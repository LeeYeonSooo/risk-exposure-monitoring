/**
 * 수용처(acceptor) 어댑터 레지스트리 — "이 파생토큰을 담보로 받아주는 마켓" 질의의 플러그인 지점.
 *
 * snapshot-lego 는 프로토콜을 모른 채 ACCEPTOR_ADAPTERS 만 순회한다. 새 수용처(Aave·Fluid·볼트쉐어…)는
 * 어댑터 1개를 여기 추가하면 끝 — 스냅샷 본체는 손대지 않는다.
 * 어댑터는 기존 discover.ts 의 열거 함수를 감싸기만 한다(로직 복제 금지). 노드 id 는
 * marketNodeId(protocol, marketKey) 관례를 따르고, meta/evidence 는 어댑터가 완성해 내보낸다.
 *
 * Convex(staked_in)는 여기 없음 — 수용처이면서 동시에 영수증 파생(cvxLP)을 발행해 레벨2 재귀의
 * 입력이 되므로(발견과 결합) snapshot-lego ⑤에 인라인으로 남긴다.
 */
import { aaveAccepting, dolomiteAccepting, eulerAccepting, fluidAccepting, llamalendAccepting, morphoAccepting, siloAccepting, vedaAccepting } from "./discover";
import { symbolsOf } from "./onchain";

/** 수용 마켓 1건 — collateral_at 엣지·legomkt 노드 생성에 필요한 전부. */
export interface AcceptingMarket {
  protocol: string;                  // 슬러그 — legomkt:{protocol}:{marketKey}@chain
  marketKey: string;                 // 관례: `${collateral}-${loanAddress}` (lowercase)
  label: string;                     // 마켓 노드 라벨 (관례: 대출자산 심볼)
  collateral: string;                // 담보 파생토큰 주소 (lowercase) — derivNodeId 매칭용
  loanSymbol: string;
  loanAddress: string;
  sizeUsd: number | null;            // collateral_at 엣지 weight (없으면 null)
  meta: Record<string, unknown>;     // 마켓 노드 meta
  evidence: Record<string, unknown>; // collateral_at 엣지 evidence
  // 이 마켓의 자체 오라클 주소(있으면). Morpho 처럼 "마켓마다 IOracle 지정"하는 수용처가 싣는다.
  //   snapshot-lego 후처리가 이 주소를 온체인 introspect 해 meta.oracle(종류)을 채운다 → 엣지 위 오라클 원.
  //   일반화: 어떤 어댑터든 이 필드만 채우면 오라클 분류·표시가 자동(프론트 무변경).
  oracleAddress?: string | null;
}

/** 수용처 어댑터 — accepting(chain, 담보후보 주소들) → 받아주는 마켓 목록. */
export interface AcceptorAdapter {
  id: string;
  chains: string[]; // 지원 체인 — 미지원 체인은 호출 자체를 스킵
  accepting(chain: string, collateralAddrs: string[]): Promise<AcceptingMarket[]>;
}

// ── Morpho Blue — GraphQL collateralAssetAddress_in (discover.morphoAccepting 래핑) ──
const morphoBlue: AcceptorAdapter = {
  id: "morpho_blue",
  chains: ["ethereum", "base", "arbitrum"],
  async accepting(chain, collateralAddrs) {
    return (await morphoAccepting(chain, collateralAddrs)).map((a) => ({
      protocol: "morpho_blue",
      marketKey: `${a.collateral}-${a.loanAddress}`,
      label: a.loanSymbol,
      collateral: a.collateral,
      loanSymbol: a.loanSymbol,
      loanAddress: a.loanAddress,
      sizeUsd: a.supplyUsd || null,
      oracleAddress: a.oracleAddress, // 마켓별 자체 오라클 — snapshot-lego 후처리가 introspect
      meta: {
        kind: "lending", venue: "Morpho Blue", loan: a.loanSymbol, lltv: a.lltv, sizeUsd: a.supplyUsd,
        category: `Morpho 담보마켓${a.lltv != null ? ` · LLTV ${(a.lltv * 100).toFixed(0)}%` : ""}`,
        curators: a.curators.slice(0, 4),
        // 마켓 고유 식별(회장 작업2) — 담보+대출 주소쌍 = 노드 id 와 동일한 유일키.
        //   meta 최상위에 두면 프론트 lego-overlay 의 `_market: {...meta}` 스프레드로 metadata._market.{collateralAddress,loanAddress} 에 그대로 실린다.
        //   알림 조인(alert-link)이 loan|lltv 충돌 없이 이 마켓만 집게 한다(추측 없음 — Morpho GraphQL 실주소).
        collateralAddress: a.collateral, loanAddress: a.loanAddress,
      },
      evidence: { source: "morpho-graphql", loan: a.loanSymbol, lltv: a.lltv },
    }));
  },
};

// ── Euler v2 — 체인별 Goldsky 서브그래프 (discover.eulerAccepting 래핑) ──
const eulerV2: AcceptorAdapter = {
  id: "euler_v2",
  chains: ["ethereum", "base", "arbitrum"], // 체인별 euler-v2 서브그래프 (discover.EULER_SUBGRAPHS)
  async accepting(chain, collateralAddrs) {
    return (await eulerAccepting(chain, collateralAddrs)).map((a) => ({
      protocol: "euler_v2",
      marketKey: `${a.collateral}-${a.loanAddress}`,
      label: a.loanSymbol,
      collateral: a.collateral,
      loanSymbol: a.loanSymbol,
      loanAddress: a.loanAddress,
      // 온체인 totalAssets×가격(담보볼트 EVault 단위). 측정 0=실제 미사용 · null=미측정(읽기 실패).
      //   Euler v2 담보는 vault 단위로 풀링되어 여러 대출마켓이 한 담보볼트를 공유 → per-대출마켓 분해는 불가(per-볼트만 실측).
      sizeUsd: a.sizeUsd,
      oracleAddress: a.oracleAddress, // EVault.oracle() = EulerRouter
      meta: { kind: "lending", venue: "Euler", loan: a.loanSymbol, category: `Euler 담보마켓 · 대출 ${a.loanSymbol}`,
        collateralAddress: a.collateral, loanAddress: a.loanAddress, sizeUsd: a.sizeUsd,
        collateralVault: a.collateralVault, sharedCollateralPool: true }, // 마켓 고유 식별(주소쌍) + 담보볼트(공유풀) 표기. Euler 는 LLTV 미수집.
      evidence: { source: "euler-subgraph", loan: a.loanSymbol, method: "EVault.totalAssets()", collateralVault: a.collateralVault },
    }));
  },
};

// ── Aave v3 — 풀형 수용처 (discover.aaveAccepting 래핑). 마켓 = 파생의 리저브 1개 ──
//   Aave 는 대출자산 구분이 없는 풀이라 marketKey = 담보주소(legomkt:aave_v3:{addr}@chain).
//   라벨은 담보 심볼 + 순수 한글. weightUsd = aToken totalSupply × 가격(adapter 산출, null 허용).
const aaveV3: AcceptorAdapter = {
  id: "aave_v3",
  chains: ["ethereum", "base", "arbitrum"],
  async accepting(chain, collateralAddrs) {
    const accepted = await aaveAccepting(chain, collateralAddrs);
    if (!accepted.length) return [];
    const syms = await symbolsOf(chain, accepted.map((a) => a.collateral)); // 라벨용 담보 심볼
    return accepted.map((a) => {
      const sym = syms.get(a.collateral) ?? null;
      const ltvPct = (a.ltvBps / 100).toFixed(0);
      return {
        protocol: "aave_v3",
        marketKey: a.collateral, // 풀형: 담보=리저브 1:1 → 대출자산 키 없음
        label: sym ? `${sym} · Aave v3 담보 리저브` : "Aave v3 담보 리저브",
        collateral: a.collateral,
        loanSymbol: sym ?? "?",  // 풀이라 특정 대출자산 없음 — 담보 심볼로 채움
        loanAddress: a.collateral,
        sizeUsd: a.sizeUsd,
        meta: {
          kind: "lending", venue: "Aave V3", aToken: a.aToken,
          ltv: a.ltvBps / 1e4, liqThreshold: a.ltBps / 1e4, sizeUsd: a.sizeUsd,
          category: `Aave v3 담보 리저브 · LTV ${ltvPct}%`,
          // 풀형: 담보=리저브 1:1 → collateral 주소가 곧 유일키(대출자산 없음). loan 키 없음.
          collateralAddress: a.collateral, collateral: sym,
        },
        evidence: { source: "onchain", method: "Pool.getReserveData", aToken: a.aToken, ltvBps: a.ltvBps, ltBps: a.ltBps },
      };
    });
  },
};

// ── Fluid (Instadapp) — vault형 수용처 (discover.fluidAccepting 래핑). 마켓 = vault 1개 ──
//   Fluid 는 담보·부채가 명확한 vault 모델 → marketKey = vault id(legomkt:fluid:{vaultId}@chain).
//   라벨은 부채 토큰 심볼(스마트부채면 "USDC/USDT" 식). sizeUsd 는 단일담보 vault 만 산출(어댑터 산출, null 허용).
const fluid: AcceptorAdapter = {
  id: "fluid",
  chains: ["ethereum", "base", "arbitrum"], // Fluid API 지원 체인 (CHAIN_IDS 와 동일)
  async accepting(chain, collateralAddrs) {
    return (await fluidAccepting(chain, collateralAddrs)).map((a) => {
      const loanLabel = a.loanSymbol1 ? `${a.loanSymbol}/${a.loanSymbol1}` : a.loanSymbol; // 스마트부채면 둘 다
      const cfPct = a.cf != null ? ` · 담보계수 ${(a.cf * 100).toFixed(0)}%` : "";
      return {
        protocol: "fluid",
        marketKey: a.vaultId, // vault형: vault id 가 곧 마켓 키
        label: `${loanLabel} · Fluid vault`,
        collateral: a.collateral,
        loanSymbol: a.loanSymbol,
        loanAddress: a.loanAddress,
        sizeUsd: a.sizeUsd,
        oracleAddress: a.oracleAddress, // Fluid API oracle 필드
        meta: {
          kind: "lending", venue: "Fluid", vaultId: a.vaultId, vaultAddress: a.vaultAddress,
          loan: loanLabel, smartCollateral: a.smartCollateral,
          collateralFactor: a.cf, liqThreshold: a.lt, liqPenalty: a.penalty, sizeUsd: a.sizeUsd,
          category: `Fluid 담보 vault · 대출 ${loanLabel}${cfPct}`,
          // vault형: vaultId 가 유일키. 담보·대출 주소도 실어 알림 조인 변별력 확보.
          collateralAddress: a.collateral, loanAddress: a.loanAddress,
        },
        evidence: {
          source: "fluid-api", endpoint: "api.fluid.instadapp.io/v2/{chainId}/vaults",
          vaultId: a.vaultId, vaultAddress: a.vaultAddress, loan: loanLabel,
          smartCollateral: a.smartCollateral, collateralFactor: a.cf,
        },
      };
    });
  },
};

// ── Curve LlamaLend — sUSDe 등 "베이스 토큰"을 직접 담보로 받아 crvUSD 차입 (discover.llamalendAccepting 래핑) ──
//   LP 가 아니라 토큰 자체를 받는다 → addBaseAcceptors(부모 토큰) 경유로만 붙는다. 마켓키 = collateral-controller(마켓 유일키).
const curveLlamalend: AcceptorAdapter = {
  id: "curve_llamalend",
  chains: ["ethereum"],
  async accepting(chain, collateralAddrs) {
    const accepted = await llamalendAccepting(chain, collateralAddrs);
    if (!accepted.length) return [];
    const loanSyms = await symbolsOf(chain, accepted.map((a) => a.loanAddress));
    return accepted.map((a) => {
      const loanSym = loanSyms.get(a.loanAddress) ?? "crvUSD";
      return {
        protocol: "curve_llamalend",
        marketKey: `${a.collateral}-${a.controller}`, // controller = 마켓 유일키(같은 담보의 여러 마켓 구분)
        label: loanSym,
        collateral: a.collateral,
        loanSymbol: loanSym,
        loanAddress: a.loanAddress,
        // size = controller.total_debt() = 이 담보로 빌린 crvUSD 총량(차입측). 담보 가치 아님 — evidence 에 명시.
        sizeUsd: a.sizeUsd,
        oracleAddress: a.oracleAddress, // amm.price_oracle_contract()
        meta: { kind: "lending", venue: "Curve LlamaLend", loan: loanSym, sizeUsd: a.sizeUsd,
          category: `Curve LlamaLend 담보마켓 · 대출 ${loanSym}`,
          collateralAddress: a.collateral, loanAddress: a.loanAddress, controller: a.controller, marketIdx: a.idx },
        evidence: { source: "onchain", factory: "0xea6876dde9e3467564acbee1ed5bac88783205e0",
          method: "OneWayLendingFactory.collateral_tokens/controllers + Controller.total_debt()", sizeSide: "borrowed(crvUSD)", controller: a.controller },
      };
    });
  },
};

// ── Silo v2 — 격리 대출(이더리움·아비트럼). 마켓 = (담보 silo, 반대편=대출자산) (discover.siloAccepting 래핑) ──
const siloV2: AcceptorAdapter = {
  id: "silo_v2",
  chains: ["ethereum", "arbitrum"],
  async accepting(chain, collateralAddrs) {
    const accepted = await siloAccepting(chain, collateralAddrs);
    if (!accepted.length) return [];
    const loanSyms = await symbolsOf(chain, accepted.map((a) => a.loanAddress));
    return accepted.map((a) => {
      const loanSym = loanSyms.get(a.loanAddress) ?? "?";
      return {
        protocol: "silo_v2",
        marketKey: `${a.collateral}-${a.collateralSilo}`, // 담보 silo 주소 = 마켓 유일키
        label: loanSym,
        collateral: a.collateral,
        loanSymbol: loanSym,
        loanAddress: a.loanAddress,
        sizeUsd: a.sizeUsd, // 담보 silo totalAssets×가격(예치측) — 측정0=빈 마켓 · null=미측정
        oracleAddress: a.oracleAddress, // SiloConfig.getConfig(silo).solvencyOracle
        meta: { kind: "lending", venue: "Silo v2", loan: loanSym, sizeUsd: a.sizeUsd,
          category: `Silo v2 격리마켓 · 대출 ${loanSym}`,
          collateralAddress: a.collateral, loanAddress: a.loanAddress, silo: a.collateralSilo, marketId: a.marketId },
        evidence: { source: "silo-onchain", method: "SiloFactory.idToSiloConfig → getSilos/getAssetForSilo + Silo.totalAssets()", silo: a.collateralSilo, marketId: a.marketId, sizeSide: "collateral deposits" },
      };
    });
  },
};

// ── Dolomite — 공유풀 마진 머니마켓(Arbitrum 주력). 상장 마켓 = 담보 가능, 고정 대출쌍 없음(크로스) (discover.dolomiteAccepting 래핑) ──
const DOLOMITE_MARGIN: Record<string, string> = { arbitrum: "0x6bd780e7fdf01d77e4d475c821f1e7ae05409072" }; // 체인별 상이 — arb만 검증
const dolomite: AcceptorAdapter = {
  id: "dolomite",
  chains: ["arbitrum", "ethereum", "base"],
  async accepting(chain, collateralAddrs) {
    return (await dolomiteAccepting(chain, collateralAddrs)).map((a) => ({
      protocol: "dolomite",
      marketKey: a.collateral, // 크로스담보: 고정 대출쌍 없음 → 담보주소가 곧 마켓 유일키
      label: `${a.symbol}`,
      collateral: a.collateral,
      loanSymbol: "여러자산/cross", // 공유풀 — 특정 대출자산 없음(상장된 다른 모든 토큰 차입 가능)
      loanAddress: DOLOMITE_MARGIN[chain] ?? a.collateral,
      sizeUsd: a.sizeUsd, // 그 토큰의 Dolomite 공급 총량 USD(담보 풀측, Aave aToken 사이징과 동급)
      oracleAddress: a.oracleAddress, // Dolomite 중앙 오라클 라우터(체인당 공유)
      meta: { kind: "lending", venue: "Dolomite", loan: "여러자산/cross", sharedCollateralPool: true,
        isolationMode: a.isIsolation, borrowingDisabled: a.borrowingDisabled, supplyTokens: a.supplyTokens, sizeUsd: a.sizeUsd,
        category: a.isIsolation ? "Dolomite 격리모드 담보(담보전용)" : "Dolomite 마진 담보 · 크로스(여러자산 대출)",
        collateralAddress: a.collateral },
      evidence: { source: "dolomite-api", endpoint: "api.dolomite.io/tokens/{chainId}", symbol: a.symbol, isolationMode: a.isIsolation, sizeSide: "supplied(collateral pool)" },
    }));
  },
};

// ── Veda BoringVault — 토큰을 배킹으로 재예치하는 일드 볼트(자체 쉐어 발행). 하류 2차 의존성(중요도 중). ──
//   대출 마켓이 아니라 일드 볼트이므로 오라클 없음(circle 미표시). "이 토큰이 어느 일드 프로토콜의 배킹이 되는가"를 맵에 띄운다.
const veda: AcceptorAdapter = {
  id: "veda",
  chains: ["ethereum"],
  async accepting(chain, collateralAddrs) {
    return (await vedaAccepting(chain, collateralAddrs)).map((a) => ({
      protocol: "veda",
      marketKey: `${a.collateral}-${a.vault}`,
      label: a.vaultSymbol,
      collateral: a.collateral,
      loanSymbol: a.vaultSymbol, // 대출 없음 — 볼트가 발행하는 쉐어 토큰명
      loanAddress: a.vault,
      sizeUsd: a.sizeUsd, // 볼트가 보유한 그 토큰 잔액 USD(배킹 규모)
      meta: { kind: "pool", venue: "Veda", vault: a.vault, sizeUsd: a.sizeUsd,
        category: `Veda 일드 볼트 · ${a.vaultSymbol} 배킹 재예치`,
        collateralAddress: a.collateral },
      evidence: { source: "onchain", method: "ERC20.balanceOf(boringVault)", vault: a.vault,
        note: "토큰이 Veda BoringVault 에 배킹으로 재예치 — 볼트가 자체 쉐어 발행(2차 의존성)" },
    }));
  },
};

/** 등록 순서 = 질의 순서. 새 수용처는 여기에만 추가. */
export const ACCEPTOR_ADAPTERS: AcceptorAdapter[] = [morphoBlue, eulerV2, aaveV3, fluid, curveLlamalend, siloV2, dolomite, veda];
