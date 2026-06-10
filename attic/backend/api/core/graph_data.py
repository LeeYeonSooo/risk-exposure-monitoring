"""
Graph seed nodes/edges — 최소 핵심만.

설계 원칙 (2026-05 정리):
  - 이 파일은 "사람이 손으로 쓴 *시드* + *체인 앵커*" 만 보관.
  - 자세한 인스턴스는 modules/{aave,lido,morpho,...}/instances.json 에서 로드.
  - 자동 발견은 new-simulator/backend/api/core/aave_discovery.py 가 처리.
  - 즉 이 파일의 노드 = "통합 그래프에서 시각적 anchor 가 되는 high-level 시드".

이전 파일에 있던 placeholder (kelp_dao, swell, ethena, raft, ezeth, rsweth, ... 등 31개) 는
모듈/discovery 어디에서도 참조되지 않아 그래프상 dead 노드였음 → 모두 제거.
필요해지면 modules/<protocol>/instances.json 으로 정식 정의해서 추가하면 됨.

Node lifecycle fields (in data dict):
  launched : "YYYY-MM" — protocol/token first deployment on mainnet
"""

NODES = [
    # ── Chain anchors (시각적 top-level 구조 유지) ──────────────────────
    {"id": "eth_mainnet", "type": "chain", "label": "Ethereum Mainnet",
     "data": {"description": "EVM L1. LST/LRT 생태계 기반 체인.",
              "risk_level": "low", "category": "chain",
              "launched": "2015-07"}},
    {"id": "arbitrum", "type": "chain", "label": "Arbitrum One",
     "data": {"description": "L2 rollup. rsETH 최대 TVL L2.",
              "risk_level": "low", "category": "chain",
              "launched": "2021-08"}},

    # ── Protocol anchor (modules/aave 와 address_book 으로 backed) ─────
    {"id": "aave_v3", "type": "protocol", "label": "Aave V3",
     "data": {"description": "최대 lending 프로토콜. wstETH, weETH, rsETH 등 LST/LRT 담보 수용.",
              "risk_level": "medium", "category": "lending",
              "tvl_slug": "aave-v3",
              "launched": "2022-03"}},

    # ── Oracle provider anchor (개별 Chainlink 피드들의 시각 클러스터 중심) ────
    {"id": "chainlink_provider", "type": "oracle", "label": "Chainlink",
     "data": {"description": "분산 price feed 네트워크. 67+ 개별 피드 제공자 — 각 피드가 본 노드로 자식 연결.",
              "risk_level": "medium", "category": "oracle_provider",
              "launched": "2017-09"}},

    # ── Token anchors (address_book 매핑 + Aave V3 reserve 자동 발견으로 backed) ──
    {"id": "wsteth", "type": "token", "label": "wstETH",
     "data": {"description": "Lido 의 non-rebasing wrapper. DeFi 통합 표준 LST.",
              "risk_level": "low", "category": "lst_token",
              "launched": "2022-02"}},
    {"id": "steth", "type": "token", "label": "stETH",
     "data": {"description": "Lido 의 rebasing LST. 검증인 보상이 잔량으로 자동 반영.",
              "risk_level": "low", "category": "lst_token",
              "launched": "2020-12"}},
    {"id": "weeth", "type": "token", "label": "weETH",
     "data": {"description": "ether.fi 의 wrapped eETH. LRT.",
              "risk_level": "medium", "category": "lrt_token",
              "launched": "2024-01"}},
    {"id": "cbeth", "type": "token", "label": "cbETH",
     "data": {"description": "Coinbase 발행 LST.",
              "risk_level": "low", "category": "lst_token",
              "launched": "2022-08"}},
    {"id": "rseth", "type": "token", "label": "rsETH",
     "data": {"description": "Kelp DAO 의 LRT. 2026-04 LayerZero 해킹 사건의 중심 자산.",
              "risk_level": "high", "category": "lrt_token",
              "launched": "2023-11"}},

    # ── Protocol anchors that the contagion simulation covers (visibility in the full map) ──
    {"id": "lido", "type": "protocol", "label": "Lido",
     "data": {"description": "stETH/wstETH 발행 (LST). 전염 시뮬 venue(파생 소스).",
              "risk_level": "low", "category": "lst_protocol", "launched": "2020-12"}},
    {"id": "etherfi", "type": "protocol", "label": "etherFi",
     "data": {"description": "eETH/weETH 발행 (LRT). 전염 시뮬 venue(파생 소스).",
              "risk_level": "medium", "category": "lrt_protocol", "launched": "2024-01"}},
    {"id": "morpho", "type": "protocol", "label": "Morpho",
     "data": {"description": "격리 마켓 + 큐레이터 볼트. 전염 시뮬 핵심 venue.",
              "risk_level": "medium", "category": "lending", "launched": "2023-10"}},
    {"id": "spark", "type": "protocol", "label": "SparkLend",
     "data": {"description": "Sky 의 lending arm (Aave V3 포크). 전염 시뮬 venue.",
              "risk_level": "medium", "category": "lending", "launched": "2023-05"}},
    {"id": "pendle", "type": "protocol", "label": "Pendle",
     "data": {"description": "PT/YT 수익 토큰. PT 가 담보로 쓰여 전염 전파.",
              "risk_level": "medium", "category": "yield", "launched": "2022-06"}},
    {"id": "uniswap", "type": "protocol", "label": "Uniswap",
     "data": {"description": "DEX. 청산 매도→가격충격(fire-sale) 채널. DEX-priced 자산만.",
              "risk_level": "low", "category": "dex", "launched": "2018-11"}},
]

# Node positions for hierarchical layout (변경된 노드 셋에 맞춰 정리)
NODE_POSITIONS = {
    # Chains (top)
    "eth_mainnet":  {"x": 700,  "y": 60},
    "arbitrum":     {"x": 1060, "y": 60},
    # Tokens (middle)
    "wsteth":       {"x": 480,  "y": 680},
    "cbeth":        {"x": 680,  "y": 680},
    "rseth":        {"x": 80,   "y": 680},
    "weeth":        {"x": 880,  "y": 680},
    "steth":        {"x": 280,  "y": 680},
    # Protocol (bottom)
    "aave_v3":      {"x": 480,  "y": 960},
    # Oracle provider (top-right, 피드들이 모이는 클러스터 중심)
    "chainlink_provider": {"x": 1280, "y": 380},
}

EDGES = [
    # ── Collateral (LST/LRT → Aave V3) ─────────────────────────────
    {"id": "e_wsteth_aave",   "source": "wsteth",  "target": "aave_v3",
     "label": "담보", "edge_type": "collateral"},
    {"id": "e_steth_aave",    "source": "steth",   "target": "aave_v3",
     "label": "담보", "edge_type": "collateral"},
    {"id": "e_weeth_aave",    "source": "weeth",   "target": "aave_v3",
     "label": "담보", "edge_type": "collateral"},
    {"id": "e_cbeth_aave",    "source": "cbeth",   "target": "aave_v3",
     "label": "담보", "edge_type": "collateral"},
    {"id": "e_rseth_aave",    "source": "rseth",   "target": "aave_v3",
     "label": "담보", "edge_type": "collateral"},

    # ── Contagion (stETH 디페그가 rsETH 인식에 영향, 발표 케이스) ───
    {"id": "e_steth_rseth_contagion",
     "source": "steth", "target": "rseth",
     "label": "전염", "edge_type": "contagion"},

    # ── Deploy anchors (체인 매핑) ──────────────────────────────────
    {"id": "e_aave_eth",      "source": "aave_v3", "target": "eth_mainnet",
     "label": "배포", "edge_type": "deploy"},
    {"id": "e_aave_arb",      "source": "aave_v3", "target": "arbitrum",
     "label": "배포", "edge_type": "deploy"},
    {"id": "e_wsteth_eth",    "source": "wsteth",  "target": "eth_mainnet",
     "label": "배포", "edge_type": "deploy"},
    {"id": "e_wsteth_arb",    "source": "wsteth",  "target": "arbitrum",
     "label": "배포", "edge_type": "deploy"},
    {"id": "e_rseth_eth",     "source": "rseth",   "target": "eth_mainnet",
     "label": "배포", "edge_type": "deploy"},
    {"id": "e_rseth_arb",     "source": "rseth",   "target": "arbitrum",
     "label": "배포", "edge_type": "deploy"},

    # ── Issuance (LST/LRT 발행 소스) ──────────────────────────────
    {"id": "e_wsteth_lido",  "source": "wsteth", "target": "lido",   "label": "발행", "edge_type": "mint_wrapper"},
    {"id": "e_steth_lido",   "source": "steth",  "target": "lido",   "label": "발행", "edge_type": "mint_wrapper"},
    {"id": "e_weeth_etherfi","source": "weeth",  "target": "etherfi","label": "발행", "edge_type": "mint_wrapper"},

    # ── Collateral (LST/LRT → Spark / Morpho) ─────────────────────
    {"id": "e_wsteth_spark", "source": "wsteth", "target": "spark",  "label": "담보", "edge_type": "collateral"},
    {"id": "e_weeth_spark",  "source": "weeth",  "target": "spark",  "label": "담보", "edge_type": "collateral"},
    {"id": "e_rseth_spark",  "source": "rseth",  "target": "spark",  "label": "담보", "edge_type": "collateral"},
    {"id": "e_wsteth_morpho","source": "wsteth", "target": "morpho", "label": "담보", "edge_type": "collateral"},
    {"id": "e_weeth_morpho", "source": "weeth",  "target": "morpho", "label": "담보", "edge_type": "collateral"},

    # ── Deploy anchors for the new protocol nodes (avoid floating) ─
    {"id": "e_lido_eth",    "source": "lido",    "target": "eth_mainnet", "label": "배포", "edge_type": "deploy"},
    {"id": "e_etherfi_eth", "source": "etherfi", "target": "eth_mainnet", "label": "배포", "edge_type": "deploy"},
    {"id": "e_morpho_eth",  "source": "morpho",  "target": "eth_mainnet", "label": "배포", "edge_type": "deploy"},
    {"id": "e_spark_eth",   "source": "spark",   "target": "eth_mainnet", "label": "배포", "edge_type": "deploy"},
    {"id": "e_pendle_eth",  "source": "pendle",  "target": "eth_mainnet", "label": "배포", "edge_type": "deploy"},
    {"id": "e_uniswap_eth", "source": "uniswap", "target": "eth_mainnet", "label": "배포", "edge_type": "deploy"},
]
