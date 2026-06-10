"""
4 simulation scenarios based on real incident patterns.
Calibrated against actual on-chain data.

S1: ORACLE_MANIPULATION
    공격자가 rsETH 오라클을 하향 조작 → oracle price frozen at shocked level
    Aave가 조작된 oracle로 HF 계산 → 포지션 강제 청산
    Ref: Raft cbETH divUp 인덱스 인플레이션 패턴

S2: BRIDGE_HACK  [CALIBRATED: 2026-04-18 Kelp DAO]
    LayerZero DVN 침해 → 116,500 rsETH 무담보 민팅
    → Aave eMode에 담보 예치 + $230M 직접 배드뎃
    → 패닉 매도 + cascade
    실제: depeg ~99%, Aave bad debt $230M, total loss $292M

S3: EIGENLAYER_SLASHING
    Kelp 운영자 슬래시 → rsETH NAV 감소
    → on-chain oracle 즉시 업데이트 → 포지션 cascade
    Ref: EigenLayer 슬래싱 메인넷

S4: MASS_WITHDRAWAL  [CALIBRATED: stETH depeg 2022-05]
    대형 홀더 매도 (뱅크런)
    → DEX 점진적 하락 → oracle 느린 추격 → cascade
    oracle_catchup_rate=0.12 (Chainlink 0.5% deviation threshold 반영)
    실제 stETH 사례: 6% depeg, 완만한 회복
"""

from dataclasses import dataclass, field
from typing import Optional
from .params import RSETH_PRICE_USD, DEX_LIQUIDITY_USD
from .oracle import ChainlinkOracleModel, STANDARD_FEED, ONCHAIN_NAV_FEED
from .agents import univ3_price_impact


@dataclass
class Scenario:
    name: str
    display_name: str
    description: str
    shock_description: str
    shocked_price: float
    oracle_start_price: float
    oracle_freezes: bool = True
    oracle_catchup_rate: float = 0.30   # 0.30 = fast (emergency), 0.10 = slow (market)
    dex_liquidity_override: Optional[float] = None
    direct_bad_debt_usd: float = 0.0
    # emergency_freeze_ticks: after this many ticks, stop cascade (market freeze).
    # None = no limit (full cascade). Used for bridge_hack to model Aave market freeze.
    emergency_freeze_ticks: Optional[int] = None
    # passive_arb_enabled: True when rsETH retains real value and arb bots will close
    # DEX/oracle gaps. False for scenarios where rsETH itself becomes worthless
    # (bridge_hack, ankr_key_compromise) — arb bots won't buy into worthless collateral.
    passive_arb_enabled: bool = True
    # oracle_model: when set, replaces the linear oracle_catchup_rate approximation with
    # a Chainlink deviation-threshold + heartbeat model. None = legacy smooth catchup.
    oracle_model: Optional[ChainlinkOracleModel] = None
    # ── Parameter rationale fields ──────────────────────────────────────────
    # confidence: calibrated / high / medium / low
    #   calibrated = backtested against real incident data
    #   high       = based on multiple real comparable incidents
    #   medium     = single reference incident or theoretical with good basis
    #   low        = theoretical, limited real-world reference
    # source: onchain_calibrated / historical_pattern / theoretical
    confidence: str = "medium"
    source: str = "theoretical"
    rationale: str = ""   # plain-text explanation of why the shock % was chosen
    # families: which AssetSpec.scenario_family values this scenario applies to.
    # An LST asset (wstETH) shouldn't see {bridge_hack, eigenlayer_slashing, ezeth_depeg}
    # because none of those threat vectors apply to a non-restaking LST.
    # Default ("lrt",) preserves existing rsETH-only behaviour.
    families: tuple[str, ...] = ("lrt",)


def build_scenarios(
    rseth_price: float = RSETH_PRICE_USD,
    dex_liquidity: float = DEX_LIQUIDITY_USD,
    dump_rseth_override: float = None,
    bridge_hack_rseth: float = None,
    bridge_hack_ltv: float = None,
) -> list:

    # ─── S1: Oracle Manipulation ───────────────────────────────────────────────
    # 공격자가 rsETH 오라클을 조작. 조작된 oracle은 공격 내내 고정.
    # oracle_freezes=True: oracle이 조작된 가격에 머뭄 → 포지션 계속 청산 위험
    s1_shocked = rseth_price * 0.85
    s1 = Scenario(
        name="oracle_manipulation",
        display_name="[S1] 오라클 조작",
        description=(
            "공격자가 rsETH 오라클을 15% 하향 조작.\n"
            "Aave가 조작된 oracle ($2,125)로 HF 계산 → 정상 포지션 강제 청산.\n"
            "Ref: Raft cbETH 인덱스 인플레이션 패턴"
        ),
        shock_description="Oracle 15% 조작 → $2,125. 포지션 강제 청산 시작.",
        shocked_price=s1_shocked,
        oracle_start_price=s1_shocked,
        oracle_freezes=True,
        oracle_catchup_rate=0.0,  # frozen: no catch-up
        confidence="medium",
        source="historical_pattern",
        rationale="15%는 Raft 2023-11 cbETH 인덱스 인플레이션 사건의 실제 oracle 괴리 수준을 참고. rsETH에 직접 발생한 사례 없으므로 medium 신뢰도.",
        families=("lrt", "lst"),  # oracle manipulation is asset-agnostic
    )

    # ─── S2: Bridge Hack [CALIBRATED to 2026-04-18 Kelp DAO] ─────────────────
    # 실제 사건: LayerZero DVN 1-of-1 침해 → 116,500 rsETH 무담보 민팅
    # 메인넷 Aave에 실제 예치된 rsETH: 공격 직후 aToken 공급 증가량 (온체인 도출)
    # bridge_hack_rseth: 실제 예치량 (run_backtest_live에서 온체인 파생, 없으면 기본값)
    # bridge_hack_ltv:   eMode LTV w[0] (Aave 컨트랙트에서 읽음, 없으면 기본값)
    s2_dump_rseth = 30_000
    s2_dump_usd = s2_dump_rseth * rseth_price
    s2_liquidity = dex_liquidity * 0.5
    s2_impact = min(univ3_price_impact(s2_dump_usd, s2_liquidity), 0.80)
    s2_shocked = rseth_price * (1 - s2_impact)
    s2_rseth = bridge_hack_rseth if bridge_hack_rseth is not None else 116_500
    s2_ltv   = bridge_hack_ltv   if bridge_hack_ltv   is not None else 0.790
    s2_direct_bad_debt = s2_rseth * rseth_price * s2_ltv
    s2 = Scenario(
        name="bridge_hack",
        display_name="[S2] 브리지 해킹 (Kelp 재현)",
        description=(
            "116,500 rsETH 무담보 민팅 → Aave eMode 담보 예치 → $230M 차입.\n"
            "Chainlink LRTOracle은 DEX spot 미추격 + Aave 마켓 즉시 동결 → cascade 없음.\n"
            "배드뎃 = 공격자 직접 차입분만. Ref: 2026-04-18 Kelp DAO LayerZero exploit"
        ),
        shock_description=f"직접 배드뎃 ${s2_direct_bad_debt/1e6:.0f}M ({s2_rseth:,.0f} rsETH × LTV {s2_ltv:.0%}) + DEX {s2_impact*100:.0f}% 충격",
        shocked_price=s2_shocked,
        oracle_start_price=rseth_price,        # Chainlink LRTOracle: fair value 기준, DEX 미추격
        oracle_freezes=True,                   # Oracle 동결 = 기존 포지션 HF 영향 없음 → cascade 없음
        oracle_catchup_rate=0.0,
        dex_liquidity_override=s2_liquidity,
        direct_bad_debt_usd=s2_direct_bad_debt,
        emergency_freeze_ticks=None,           # oracle_freezes=True로 이미 cascade 없음
        passive_arb_enabled=False,             # rsETH 자체 무담보 민팅 → 시장 가치 붕괴 → arb 없음
        confidence="calibrated",
        source="onchain_calibrated",
        rationale="2026-04-18 Kelp DAO 실제 사건 기반 calibration. 116,500 rsETH 무담보 민팅 → Aave $230M 배드뎃. 충격값 40%는 실제 DEX 패닉 매도 + LP 이탈 역산.",
        families=("lrt",),  # bridge hack pattern primarily affects cross-chain LRTs
    )

    # ─── S3: EigenLayer Slashing ───────────────────────────────────────────────
    # on-chain 슬래싱 → LRTOracle 즉시 업데이트 → 포지션 cascade
    s3_shocked = rseth_price * 0.85
    s3 = Scenario(
        name="eigenlayer_slashing",
        display_name="[S3] EigenLayer 대규모 슬래싱",
        description=(
            "Kelp 운영자 15% 슬래시 → rsETH NAV 15% 감소.\n"
            "LRTOracle가 on-chain으로 업데이트 → Aave HF 즉시 재계산.\n"
            "Ref: EigenLayer 슬래싱 2025-04-17 메인넷"
        ),
        shock_description="EigenLayer 15% 슬래시 → oracle $2,125으로 즉시 업데이트",
        shocked_price=s3_shocked,
        oracle_start_price=s3_shocked,
        oracle_freezes=False,
        oracle_catchup_rate=0.20,              # NAV 지속 감소 반영 (legacy fallback)
        oracle_model=ONCHAIN_NAV_FEED,         # LRTOracle: on-chain NAV → updates each block
        confidence="medium",
        source="historical_pattern",
        rationale="15%는 EigenLayer 슬래싱 메인넷 2025-04 사례 참고. 운영자 단일 슬래시 최대값 기준. 복수 운영자 동시 슬래시 시 더 클 수 있음.",
        families=("lrt",),  # restaking slash is LRT-specific (LSTs are not restaked)
    )

    # ─── S4: Mass Withdrawal [CALIBRATED to stETH depeg 2022-05] ─────────────
    # 실제: stETH가 Curve 풀에서 6% depeg (5월 2022)
    # 기계: 대형 홀더 매도 → DEX 하락 → Chainlink 천천히 추격 → 제한적 cascade
    # oracle_catchup_rate=0.12: Chainlink 0.5% deviation threshold 반영 (느린 업데이트)
    s4_dump_rseth = 5_000
    s4_dump_usd = s4_dump_rseth * rseth_price
    s4_liquidity = dex_liquidity * 0.80
    s4_impact = min(univ3_price_impact(s4_dump_usd, s4_liquidity), 0.40)
    s4_shocked = rseth_price * (1 - s4_impact)
    s4 = Scenario(
        name="mass_withdrawal",
        display_name="[S4] 대량 인출 (뱅크런)",
        description=(
            "대형 홀더 5,000 rsETH 매도 압력.\n"
            "DEX 점진적 하락 → oracle 느린 추격 → eMode 포지션 cascade.\n"
            "Ref: stETH Curve 풀 depeg 2022-05 (6% depeg, 완만한 회복)"
        ),
        shock_description=f"5,000 rsETH 매도 → DEX {s4_impact*100:.0f}% 하락, oracle 느린 추격",
        shocked_price=s4_shocked,
        oracle_start_price=rseth_price,
        oracle_freezes=False,
        oracle_catchup_rate=0.12,              # 느린 추격 (legacy fallback)
        oracle_model=STANDARD_FEED,            # Chainlink standard: 0.5% deviation / 300-block heartbeat
        dex_liquidity_override=s4_liquidity,
        confidence="medium",
        source="historical_pattern",
        rationale="stETH Curve 풀 2022-05 depeg (6%) 패턴 참고. Chainlink 0.5% deviation threshold 기반 — oracle은 DEX가 0.5% 이상 하락할 때마다 계단식 추격. rsETH DEX 유동성이 stETH보다 얇아 실제 충격은 더 클 수 있음.",
        families=("lrt", "lst"),  # bank-run dynamic applies to both LST and LRT
    )

    # ─── S5: Reentrancy Theft [Penpie pattern] ───────────────────────────────
    # Vault reentrancy → LRT stolen and dumped → panic cascade
    # Ref: 2024-09-03 Penpie $27M (nonReentrant 누락 → batchHarvestMarketRewards 악용)
    s5_direct_bad_debt = 27_000_000
    s5_shocked = rseth_price * 0.94     # 6% DEX panic + stolen token dump
    s5 = Scenario(
        name="penpie_reentrancy",
        display_name="[S5] 재진입 해킹 (Penpie 패턴)",
        description=(
            "재진입 취약점 → rsETH 연관 풀 $27M 탈취 → 공격자 DEX 덤프 → panic cascade.\n"
            "Ref: 2024-09-03 Penpie agETH/wstETH/sfrxETH/ankrETH 탈취"
        ),
        shock_description=f"재진입 탈취 ${s5_direct_bad_debt/1e6:.0f}M + DEX 6% 패닉 충격",
        shocked_price=s5_shocked,
        oracle_start_price=rseth_price,
        oracle_freezes=False,
        oracle_catchup_rate=0.20,
        oracle_model=STANDARD_FEED,            # Chainlink standard feed
        direct_bad_debt_usd=s5_direct_bad_debt,
        confidence="medium",
        source="historical_pattern",
        rationale="2024-09-03 Penpie agETH/wstETH 탈취 패턴 참고. rsETH 직접 연관성 없으나 유사 재진입 취약점 가정. 6% DEX 충격은 실제 Penpie 사후 덤프 규모 기반.",
        families=("lrt", "lst"),  # Penpie victim list included wstETH directly
    )

    # ─── S6: Admin Key Compromise [Ankr/Helio pattern] ───────────────────────
    # Private key stolen → unlimited rsETH minting → extreme dump → oracle frozen
    # Ref: 2022-12-02 Ankr aBNBc 60조 무단 민팅 + Helio TWAP 오라클 지연 → $15M 배드뎃
    s6_shocked = rseth_price * 0.40     # -60%: unlimited supply causes extreme crash
    s6 = Scenario(
        name="ankr_key_compromise",
        display_name="[S6] 어드민 키 탈취 (Ankr 패턴)",
        description=(
            "어드민 키 탈취 → rsETH 무제한 민팅 → DEX -60% 폭락.\n"
            "Chainlink oracle은 즉시 반응하지 않음 → HF 계산 오류 지속 → 대규모 배드뎃.\n"
            "Ref: 2022-12-02 Ankr 키 탈취 + Helio TWAP 오라클 지연"
        ),
        shock_description="어드민 키 탈취 → 무제한 민팅 → DEX -60% + 오라클 동결",
        shocked_price=s6_shocked,
        oracle_start_price=rseth_price,  # Chainlink unaware initially
        oracle_freezes=True,             # Oracle frozen until incident discovered
        oracle_catchup_rate=0.0,
        direct_bad_debt_usd=15_000_000,
        passive_arb_enabled=False,       # 무제한 민팅 → rsETH 가치 붕괴 → arb 없음
        confidence="low",
        source="historical_pattern",
        rationale="2022-12 Ankr aBNBc 키 탈취 패턴. rsETH 키 구조가 Ankr보다 강화됐을 수 있어 low 신뢰도. 60% 충격은 무제한 민팅 시 최악 시나리오 기준.",
        families=("lrt", "lst"),  # any issuer with admin keys is exposed
    )

    # ─── S7: Index Inflation [Raft pattern] ──────────────────────────────────
    # Index manipulation → rsETH oversupply minted → dump → moderate cascade
    # Ref: 2023-11 Raft rcbETH-c divUp → 6.7M R 무담보 민팅 → R -50% depeg
    s7_shocked = rseth_price * 0.85     # -15%: inflation-induced oversupply
    s7 = Scenario(
        name="raft_index_inflation",
        display_name="[S7] 인덱스 인플레이션 (Raft 패턴)",
        description=(
            "rsETH 내부 인덱스 조작 → 초과 민팅 → DEX 덤프 → 점진적 cascade.\n"
            "Ref: 2023-11 Raft cbETH divUp 조작 → 6.7M R 과발행"
        ),
        shock_description="인덱스 조작 → 초과 발행 → DEX -15% 충격, oracle 중간 속도 추격",
        shocked_price=s7_shocked,
        oracle_start_price=rseth_price,
        oracle_freezes=False,
        oracle_catchup_rate=0.15,
        oracle_model=STANDARD_FEED,            # Chainlink standard feed
        direct_bad_debt_usd=3_300_000,
        confidence="low",
        source="historical_pattern",
        rationale="2023-11 Raft cbETH divUp 인플레이션 패턴. rsETH 인덱스 구조가 다를 수 있어 low 신뢰도. 15% 충격은 Raft R 토큰 depeg 규모 참고.",
        families=("lrt",),  # index inflation is specific to LRT-style index accounting
    )

    # ─── S8: Read-only Reentrancy [Balancer pattern] ─────────────────────────
    # Pool reentrancy → oracle price manipulated downward → forced liquidations
    # Ref: 2023-08 Balancer V2 mulDown 반올림 오류 + 읽기 전용 재진입
    s8_shocked = rseth_price * 0.88     # -12%: oracle manipulated to this level
    s8 = Scenario(
        name="balancer_reentrancy",
        display_name="[S8] 읽기 전용 재진입 (Balancer 패턴)",
        description=(
            "DEX 풀 읽기 전용 재진입 → rsETH oracle 가격 조작 → HF 강제 하락 → 청산 cascade.\n"
            "Ref: 2023-08 Balancer V2 mulDown + 읽기 전용 재진입"
        ),
        shock_description="읽기 전용 재진입 → oracle -12% 조작 → 포지션 강제 청산",
        shocked_price=s8_shocked,
        oracle_start_price=s8_shocked,  # Oracle IS the manipulated price
        oracle_freezes=True,            # Manipulation holds until tx reverts
        oracle_catchup_rate=0.0,
        direct_bad_debt_usd=2_100_000,
        confidence="low",
        source="historical_pattern",
        rationale="2023-08 Balancer V2 읽기 전용 재진입 패턴. rsETH/Aave 조합에서 동일 취약점 존재 여부 미확인. 12% 충격은 Balancer 실제 oracle 조작 규모 참고.",
        families=("lrt", "lst"),  # 2023-08 Balancer exploit hit wstETH pools directly
    )

    # ─── S9: Validator Slashing [Lido/EigenLayer pattern] ────────────────────
    # Large-scale validator slashing → rsETH NAV drops → oracle immediate update
    # Ref: stETH 2022 슬래싱 사례 + EigenLayer 슬래싱 2025-04
    s9_shock_pct = 0.08
    s9_shocked = rseth_price * (1 - s9_shock_pct)
    s9 = Scenario(
        name="lido_validator_slashing",
        display_name="[S9] 검증자 대규모 슬래싱 (Lido/EigenLayer 패턴)",
        description=(
            "Kelp/EigenLayer 검증자 대규모 슬래시 → rsETH NAV -8% → LRTOracle 즉시 업데이트.\n"
            "Ref: Lido stETH 슬래싱 + EigenLayer 슬래싱 메인넷 2025-04"
        ),
        shock_description="대규모 검증자 슬래싱 → rsETH NAV -8% → oracle 즉시 반영",
        shocked_price=s9_shocked,
        oracle_start_price=s9_shocked,  # On-chain slashing → oracle updates immediately
        oracle_freezes=False,
        oracle_catchup_rate=0.20,       # NAV 지속 감소 반영 (legacy fallback)
        oracle_model=ONCHAIN_NAV_FEED,         # LRTOracle: on-chain NAV
        confidence="low",
        source="historical_pattern",
        rationale="EigenLayer 슬래싱 메인넷 2025-04 + Lido stETH 사례 참고. 8%는 단일 검증자 집합 대규모 슬래시 기준. stETH 대비 rsETH 위임 분산도에 따라 달라질 수 있음.",
        families=("lrt", "lst"),  # validator slashing is the LST-native risk; LRT inherits it
    )

    # ─── S10: Withdrawal Queue Depeg [ezETH pattern] ─────────────────────────
    # Protocol withdrawal queue saturated → DEX premium collapses → slow cascade
    # Ref: 2024-04-24 Renzo 인출 큐 포화 → ezETH -3.5% depeg
    # dump_rseth_override: backtest can pass calibrated value (e.g. ezETH 2024: 350)
    s10_dump_rseth = dump_rseth_override if dump_rseth_override is not None else 8_000
    s10_dump_usd   = s10_dump_rseth * rseth_price
    s10_liquidity  = dex_liquidity * 0.70  # Some LPs exit during withdrawal panic
    s10_impact = min(univ3_price_impact(s10_dump_usd, s10_liquidity), 0.40)
    s10_shocked = rseth_price * (1 - s10_impact)
    s10 = Scenario(
        name="ezeth_depeg",
        display_name="[S10] 인출 큐 포화 (ezETH 패턴)",
        description=(
            "Kelp 인출 큐 포화 → rsETH 즉시 인출 불가 → DEX 프리미엄 소멸 → 매도 cascade.\n"
            "Ref: 2024-04-24 Renzo 포인트 프로그램 종료 → ezETH -3.5% depeg"
        ),
        shock_description=f"인출 큐 포화 → DEX {s10_impact*100:.0f}% 충격, oracle 매우 느린 추격",
        shocked_price=s10_shocked,
        oracle_start_price=rseth_price,
        oracle_freezes=False,
        oracle_catchup_rate=0.10,      # Very slow: structural issue (legacy fallback)
        oracle_model=ChainlinkOracleModel(deviation_threshold=0.010, heartbeat_blocks=300),  # 1% threshold for LRT queue depeg
        dex_liquidity_override=s10_liquidity,
        confidence="low",
        source="historical_pattern",
        rationale="2024-04-24 Renzo ezETH -3.5% depeg 패턴. rsETH 인출 큐 구조가 다를 수 있음. 10% 충격은 ezETH보다 보수적으로 설정 (rsETH DEX 유동성이 더 얇음).",
        families=("lrt",),  # LRT withdrawal queue is qualitatively different from LST staking queue
    )

    return [s1, s2, s3, s4, s5, s6, s7, s8, s9, s10]


def scenarios_for_family(family: str, **build_kwargs) -> list:
    """Return only the scenarios applicable to the given AssetSpec.scenario_family.

    Example:
        wsteth_scenarios = scenarios_for_family("lst", rseth_price=2628.0)
        # → S1, S4, S5, S6, S8, S9 (LST-applicable subset)
    """
    return [s for s in build_scenarios(**build_kwargs) if family in s.families]
