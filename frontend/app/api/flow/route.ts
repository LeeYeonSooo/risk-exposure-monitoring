import { NextResponse } from "next/server";
import pg from "pg";

import { buildFlowGraph } from "@/lib/flow-core";
import type { RiskLevel } from "@/lib/flow-types";

/**
 * GET /api/flow?tokens=stETH,wstETH,…&chains=ethereum,arbitrum&topPct=0.9
 *
 * Builds the live relationship+flow graph (DeFiLlama + Morpho + RPC) for the
 * requested tokens × chains, then overlays recent DB alerts as node risk.
 * All inputs optional → defaults to the home view (top-5 ETH tokens incl stETH).
 */
export const dynamic = "force-dynamic";
// 그래프 구성은 DB 조회 + flow-core 의 derive-family 온체인 프로브(배치 RPC)라 콜드 시 수 초가 걸린다 —
// 서버리스 기본 타임아웃에 잘리지 않게 상한을 올린다(상주 Node 면 무영향). (2026-06-13 감사)
export const maxDuration = 60;

const DATABASE_URL = process.env.DATABASE_URL;
let _pool: pg.Pool | null = null;
function pool(): pg.Pool | null {
  if (!DATABASE_URL) return null;
  if (_pool) return _pool;
  _pool = new pg.Pool({ connectionString: DATABASE_URL, max: 3 });
  return _pool;
}

function parseList(v: string | null): string[] | undefined {
  if (!v) return undefined;
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

const SEV_RISK: Record<string, RiskLevel> = { critical: "danger", warning: "caution", info: "safe" };

export async function GET(req: Request) {
  const url = new URL(req.url);
  const tokens = parseList(url.searchParams.get("tokens"));
  const chains = parseList(url.searchParams.get("chains"));
  const topPct = url.searchParams.get("topPct") ? Number(url.searchParams.get("topPct")) : undefined;
  const maxProto = url.searchParams.get("maxProto") ? Number(url.searchParams.get("maxProto")) : undefined;
  const maxMkt = url.searchParams.get("maxMkt") ? Number(url.searchParams.get("maxMkt")) : undefined;
  // estimated=1 → mint_event(추정) 브릿지 권한도 노드로 포함 (브릿지 뷰 토글). 기본 제외 = 검증/탐지된 것만.
  const estimated = url.searchParams.get("estimated") === "1";

  let graph;
  try {
    graph = await buildFlowGraph({ tokens, chains, topPct, maxProtocolsPerToken: maxProto, maxMarketsPerProtocol: maxMkt });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }

  // overlay recent alerts (last 48h) → risk on token/protocol nodes
  const p = pool();
  if (p) {
    try {
      const r = await p.query<{ token: string; protocol_node_id: string | null; severity: string }>(
        `SELECT DISTINCT ON (token, coalesce(protocol_node_id,'')) token, protocol_node_id, severity
         FROM alerts WHERE created_at > now() - interval '48 hours'
         ORDER BY token, coalesce(protocol_node_id,''), created_at DESC`,
      );
      const rank: Record<RiskLevel, number> = { safe: 0, caution: 1, danger: 2 };
      const bump = (id: string, risk: RiskLevel) => {
        const n = graph.nodes.find((x) => x.id === id);
        if (n && rank[risk] > rank[n.risk ?? "safe"]) n.risk = risk;
      };
      for (const a of r.rows) {
        const risk = SEV_RISK[a.severity] ?? "safe";
        if (risk === "safe") continue;
        const sym = a.token.toUpperCase();
        for (const n of graph.nodes) if (n.kind === "token" && n.token.toUpperCase() === sym) bump(n.id, risk);
        if (a.protocol_node_id) {
          // EXACT slug match only — substring 매칭은 "aave" 알림이 aave-v2/v3 전부에 위험 표시를
          // 칠하는 식의 잘못된 리스크 귀속을 만든다 (위험 배지는 검증된 매핑에만).
          const slug = a.protocol_node_id.replace(/^protocol:/, "").replace(/^dl:/, "").split("@")[0].replace(/_/g, "-");
          const slugFlat = slug.replace(/-/g, "");
          for (const n of graph.nodes) {
            if (n.kind === "protocol" && n.protocol && (n.protocol === slug || n.protocol.replace(/-/g, "") === slugFlat)) bump(n.id, risk);
          }
        }
      }
    } catch {
      /* alerts overlay is best-effort */
    }

    // ── enrich with DB real data: bridge mechanism, ouroboros loops, curator vaults ──
    const tokenIdByTC = new Map(graph.nodes.filter((n) => n.kind === "token").map((n) => [`${n.token.toUpperCase()}|${n.chain}`, n.id] as const));
    const tokenSyms = new Set(graph.nodes.filter((n) => n.kind === "token").map((n) => n.token.toUpperCase()));

    // 1) bridge_authorities (snapshot-bridge-authority) → real lock_mint/burn_mint/xERC20/OFT/CCIP mechanism
    try {
      const ba = await p.query<{ token: string; chain: string; auth_type: string; note: string | null }>(
        `SELECT DISTINCT ON (upper(token), chain) token, chain, auth_type, note FROM bridge_authorities ORDER BY upper(token), chain, auth_type`,
      );
      const byTC = new Map(ba.rows.map((r) => [`${r.token.toUpperCase()}|${r.chain}`, r] as const));
      for (const e of graph.edges) {
        if (e.kind !== "bridge" || !e.bridge) continue;
        const tok = e.id.split(":")[1] ?? "";
        const r = byTC.get(`${tok.toUpperCase()}|${e.bridge.toChain}`);
        // 승격 시에도 수치 출처 괄호(온체인 공급 vs TVL 기준 추정)는 유지 — 출처 표기를 지우지 않는다
        const prov = e.label?.match(/\(([^)]+)\)\s*$/)?.[1];
        if (r) { e.bridge.mechanism = r.auth_type; e.label = `${tok} 브릿지 · ${r.auth_type}${r.note ? ` · ${r.note}` : ""}${prov ? ` (${prov})` : ""}`; }
      }
    } catch { /* table optional */ }

    // 2) loop_findings (ouroboros/looping) → real token ↔ token relationship edges
    try {
      const lf = await p.query<{ collateral_symbol: string | null; loan_symbol: string | null; looped_usd: string | null; kind: string }>(
        `SELECT collateral_symbol, loan_symbol, looped_usd, kind FROM loop_findings WHERE looped_usd IS NOT NULL ORDER BY looped_usd DESC NULLS LAST LIMIT 80`,
      );
      const seen = new Set<string>();
      for (const r of lf.rows) {
        const c = (r.collateral_symbol ?? "").toUpperCase(), l = (r.loan_symbol ?? "").toUpperCase();
        if (!c || !l || c === l || !tokenSyms.has(c) || !tokenSyms.has(l)) continue;
        const a = tokenIdByTC.get(`${c}|ethereum`), b = tokenIdByTC.get(`${l}|ethereum`);
        if (!a || !b) continue;
        const id = `loop:${[c, l].sort().join("-")}`; if (seen.has(id)) continue; seen.add(id);
        graph.edges.push({ id, source: a, target: b, kind: "involves", tvlUsd: Number(r.looped_usd) || 0, weight: 0.7, chain: "ethereum", dir: "both", label: `🌀 루핑/ouroboros (${r.kind})` });
      }
    } catch { /* table optional */ }

    // 3) vault_allocations (snapshot-curators) → real curator + size on vault nodes
    try {
      const va = await p.query<{ vault_name: string; curator: string | null; supply_usd: string | null }>(
        `SELECT vault_name, max(curator) curator, sum(supply_usd) supply_usd FROM vault_allocations GROUP BY vault_name`,
      );
      const byName = new Map(va.rows.map((r) => [r.vault_name.toLowerCase(), r] as const));
      for (const n of graph.nodes) {
        if (n.kind !== "vault") continue;
        const r = byName.get(n.label.toLowerCase());
        if (r) { n.meta = { ...(n.meta ?? {}), curator: r.curator ?? n.meta?.curator, source: "curator-db" }; if (r.supply_usd) n.tvlUsd = Math.max(n.tvlUsd, Number(r.supply_usd)); }
      }
    } catch { /* table optional */ }

    // 4) 마켓 오라클 인텔 — 우리 온체인 introspection(edges.attrs.topMarkets[].oracle) 을 오라클 엣지에 부착.
    //    NAV/ORACLE_FREE(자기참조·하드코딩) = danger → 엣지 위 ◉ 가 빨강으로, 클릭 상세에 제공자/검증 표시.
    try {
      const tokUpper = graph.tokens.map((t) => t.symbol.toUpperCase());
      const oi = await p.query<{ coll: string | null; loan: string | null; chain: string | null; oracle: { type?: string; provider?: string; description?: string; verified?: boolean; address?: string } | null }>(
        `SELECT m->>'collateralAsset' AS coll, m->>'loanAsset' AS loan, n.chain, m->'oracle' AS oracle
         FROM edges e
         JOIN nodes n ON n.node_id = e.token_node_id
         CROSS JOIN LATERAL jsonb_array_elements(e.attrs->'topMarkets') m
         WHERE e.snapshot_ts > now() - interval '3 days'
           AND jsonb_typeof(e.attrs->'topMarkets') = 'array'
           AND (m->'oracle') IS NOT NULL
           AND upper(split_part(replace(e.token_node_id, 'token:', ''), '@', 1)) = ANY($1)`,
        [tokUpper],
      );
      const normL = (s: string) => s.toLowerCase().replace(/[^a-z0-9/]/g, "");
      const intel = new Map<string, NonNullable<typeof oi.rows[number]["oracle"]>>();
      for (const r of oi.rows) {
        if (!r.coll || !r.loan || !r.oracle) continue;
        const k = `${normL(`${r.coll}/${r.loan}`)}|${r.chain ?? "ethereum"}`;
        if (!intel.has(k)) intel.set(k, r.oracle);
      }
      const nodeById = new Map(graph.nodes.map((n) => [n.id, n] as const));
      for (const e of graph.edges) {
        if (e.kind !== "oracle") continue;
        const mkt = nodeById.get(e.source);
        if (!mkt) continue;
        const o = intel.get(`${normL(mkt.label)}|${mkt.chain}`);
        if (!o) continue;
        const danger = o.type === "NAV" || o.type === "ORACLE_FREE";
        e.oracle = { type: o.type ?? null, provider: o.provider ?? null, description: o.description ?? null, verified: !!o.verified, address: o.address ?? null, danger };
        if (danger) e.label = `${e.label ?? "오라클"} ⚠ 자기참조/NAV`;
        else if (o.provider) e.label = `오라클 · ${o.provider}`;
      }
    } catch { /* intel optional */ }

    // 5) 브릿지 노드 — EVM 검증 mint 권한(bridge_authorities)만 → 토큰@체인 노드에 🌉 노드로 부착.
    //    mint_event(추정)는 제외 — 검증된 것만 노드가 된다.
    //    비-EVM 표준 브릿지 테이블(bridge_detections — 파이썬 탐지기, solana/sui/tron/… 행만 적재)은
    //    EVM 전용 결정(2026-06-12)에 따라 조회 자체를 제거 — "안 불러온다".
    try {
      const tokenIdBySymChain = new Map<string, string>();
      for (const n of graph.nodes) if (n.kind === "token") tokenIdBySymChain.set(`${n.token.toUpperCase()}|${n.chain}`, n.id);
      const syms = [...new Set(graph.nodes.filter((n) => n.kind === "token").map((n) => n.token.toUpperCase()))];
      const PRETTY: Record<string, string> = {
        xerc20: "xERC20", xerc20_lockbox: "xERC20 Lockbox", ccip_pool: "Chainlink CCIP", ccip_remote: "Chainlink CCIP",
        oft_peer: "LayerZero OFT", minter_role: "MINTER_ROLE", cctp: "Circle CCTP", wormhole_ntt: "Wormhole NTT",
        axelar_its: "Axelar ITS", hyperlane: "Hyperlane", op_bridge: "OP Bridge", l2_canonical: "L2 Canonical", polygon_pos: "Polygon PoS",
      };
      const addBridgeNode = (sym: string, chain: string, slug: string, pretty: string, addr: string, note: string | null, mintLimit: number | null, isEstimated: boolean) => {
        const tokId = tokenIdBySymChain.get(`${sym}|${chain}`);
        if (!tokId) return;
        const id = `bridge:${chain}|${sym}|${slug}`;
        const existing = graph.nodes.find((n) => n.id === id);
        if (existing) {
          existing.meta = { ...(existing.meta ?? {}), count: ((existing.meta?.count as number | undefined) ?? 1) + 1 };
          return;
        }
        graph.nodes.push({ id, kind: "bridge", label: pretty, token: sym, chain, tvlUsd: 0, address: addr, risk: "safe", meta: { authType: slug, note, mintLimit, addr, estimated: isEstimated } });
        graph.edges.push({ id: `bn:${id}`, source: tokId, target: id, kind: "bridge", tvlUsd: 0, weight: 0.2, chain, label: `${pretty} 브릿지 통로`, bridge: { fromChain: chain, toChain: chain, mechanism: slug, protocol: pretty } });
      };
      // estimated=1 이면 mint_event(추정)도 포함, meta.estimated=true 로 표시(UI 점선·"추정"). 기본은 검증/탐지된 것만.
      const ba2 = await p.query<{ token: string; chain: string; bridge_addr: string; auth_type: string; mint_limit: number | null; note: string | null }>(
        `SELECT DISTINCT ON (upper(token), chain, auth_type) token, chain, bridge_addr, auth_type, mint_limit, note
         FROM bridge_authorities WHERE upper(token) = ANY($1)${estimated ? "" : " AND auth_type <> 'mint_event'"} ORDER BY upper(token), chain, auth_type`,
        [syms],
      );
      for (const r of ba2.rows) addBridgeNode(r.token.toUpperCase(), r.chain, r.auth_type, PRETTY[r.auth_type] ?? r.auth_type, r.bridge_addr, r.note, r.mint_limit, r.auth_type === "mint_event");
    } catch { /* table optional */ }

    // Event-discovered trace edges are added in the /flow client from the live event feed.
    // Keeping it there avoids Dune/flow_* DB dependency and preserves the server graph shape.
  }

  return NextResponse.json(graph);
}
