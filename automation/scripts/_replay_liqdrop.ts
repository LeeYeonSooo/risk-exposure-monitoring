import { query, closePool } from "@/db/client";

function median(xs: number[]): number {
  const a = [...xs].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
const T = {
  minLiquidityUsd: 250_000,
  minLiquidityDropUsd: 1_000_000,
  maxStalenessMin: 360,
  liquidityDropPct: { info: 0.25, warning: 0.40, critical: 0.60 },
};
function sevFor(v: number) {
  if (v >= T.liquidityDropPct.critical) return "critical";
  if (v >= T.liquidityDropPct.warning) return "warning";
  if (v >= T.liquidityDropPct.info) return "info";
  return null;
}

async function main() {
  const alerts = await query<any>(
    `SELECT id, created_at, snapshot_ts, severity, token, protocol_node_id, detail
     FROM alerts WHERE kind='liquidity_drop_lending' AND resolved_at IS NULL ORDER BY created_at`,
  );
  const rows: any[] = [];
  for (const al of alerts.rows) {
    const tokenNode = `token:${al.token}`;
    const proto = al.protocol_node_id;
    const snapTs = new Date(al.snapshot_ts).toISOString();
    // current edge at the alert snapshot (curr)
    const cur = await query<any>(
      `SELECT snapshot_ts, (attrs->'lendingRisk'->>'liquidityUsd')::float8 liq,
              (attrs->'lendingRisk'->>'utilization')::float8 util,
              attrs->'meta'->>'snapshotTs' mts,
              (attrs->'classification'->>'protocol_class') pclass
       FROM edges WHERE token_node_id=$1 AND protocol_node_id=$2 AND snapshot_ts <= $3
       ORDER BY snapshot_ts DESC LIMIT 1`, [tokenNode, proto, snapTs]);
    // prev edge (one before curr)
    const prevRows = await query<any>(
      `SELECT snapshot_ts, (attrs->'lendingRisk'->>'liquidityUsd')::float8 liq,
              (attrs->'lendingRisk'->>'utilization')::float8 util,
              attrs->'meta'->>'snapshotTs' mts
       FROM edges WHERE token_node_id=$1 AND protocol_node_id=$2 AND snapshot_ts < $3
       ORDER BY snapshot_ts DESC LIMIT 8`, [tokenNode, proto, cur.rows[0]?.snapshot_ts ?? snapTs]);
    // baseline median (6 most recent >0 before curr)
    const baseSamples = prevRows.rows.map((r: any) => r.liq).filter((x: number) => x != null && x > 0).slice(0, 6);
    // next edges after alert (to detect reversion)
    const nxt = await query<any>(
      `SELECT snapshot_ts, (attrs->'lendingRisk'->>'liquidityUsd')::float8 liq
       FROM edges WHERE token_node_id=$1 AND protocol_node_id=$2 AND snapshot_ts > $3
       ORDER BY snapshot_ts ASC LIMIT 3`, [tokenNode, proto, cur.rows[0]?.snapshot_ts ?? snapTs]);

    const c = cur.rows[0];
    const p = prevRows.rows[0];
    const dCurr = al.detail?.currLiquidityUsd;
    const dBase = al.detail?.baseLiquidityUsd ?? al.detail?.prevLiquidityUsd;
    const dDrop = al.detail?.dropPct;

    // replay with current gates using reconstructed values
    const currLiq = c?.liq;
    const prevLiq = p?.liq;
    const lendMed = baseSamples.length >= 3 ? median(baseSamples) : null;
    const baseLiq = lendMed ?? prevLiq;
    const currU = c?.util;
    const prevU = p?.util;
    const prevTs = p?.mts ? new Date(p.mts).getTime() : (p ? new Date(p.snapshot_ts).getTime() : null);
    const currTs = c?.mts ? new Date(c.mts).getTime() : (c ? new Date(c.snapshot_ts).getTime() : null);
    const elapsedMin = prevTs != null && currTs != null ? (currTs - prevTs) / 60000 : null;
    const staleGap = elapsedMin != null && elapsedMin > T.maxStalenessMin;

    let replaySev: string | null = null;
    let reason = "";
    if (currLiq == null || prevLiq == null || baseLiq == null) { reason = "no-edge-data"; }
    else if (!(currLiq > 0)) { reason = "currLiq<=0"; }
    else if (staleGap) { reason = `staleGap ${elapsedMin?.toFixed(0)}min`; }
    else if (!(baseLiq >= T.minLiquidityUsd)) { reason = "baseLiq<min"; }
    else if (!(currLiq < baseLiq)) { reason = "currLiq>=baseLiq"; }
    else if (!((baseLiq - currLiq) >= T.minLiquidityDropUsd)) { reason = `absDrop ${((baseLiq-currLiq)/1e6).toFixed(2)}M<1M`; }
    else {
      const dp = (baseLiq - currLiq) / baseLiq;
      replaySev = sevFor(dp);
      reason = `dropPct ${(dp*100).toFixed(1)}%`;
      if (replaySev === "critical") {
        const utilRose = prevU != null && currU != null && currU > prevU + 0.02;
        const utilHigh = currU != null && currU >= 0.90;
        if (!utilRose && !utilHigh) { replaySev = "warning"; reason += " (crit->warn no-corrob)"; }
      }
    }
    // reversion: does next snapshot return toward baseline (>= 85% of base)?
    const reverts = nxt.rows.length > 0 && baseLiq != null && nxt.rows.some((r: any) => r.liq != null && r.liq >= baseLiq * 0.85);
    const elapsedHr = elapsedMin != null ? (elapsedMin/60).toFixed(1) : "?";

    rows.push({
      id: al.id, sev: al.severity, token: al.token, proto: proto.replace("protocol:",""),
      detail_drop: dDrop != null ? (dDrop*100).toFixed(1)+"%" : "-",
      detail_curr: dCurr != null ? (dCurr/1e6).toFixed(2)+"M" : "-",
      recon_curr: currLiq != null ? (currLiq/1e6).toFixed(2)+"M" : "NA",
      recon_base: baseLiq != null ? (baseLiq/1e6).toFixed(2)+"M" : "NA",
      nsamp: baseSamples.length,
      elapsedHr, replaySev: replaySev ?? "NONE", reason,
      reverts: reverts ? "REVERTS" : "stays",
      nextLiq: nxt.rows.map((r:any)=> r.liq!=null?(r.liq/1e6).toFixed(2):"-").join(","),
      currU: currU != null ? currU.toFixed(3) : "-", prevU: prevU != null ? prevU.toFixed(3):"-",
    });
  }
  console.log(JSON.stringify(rows, null, 0));
  await closePool();
}
main().catch((e) => { console.error(e); process.exit(1); });
