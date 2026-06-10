/**
 * 비-EVM 브릿지 탐지 — automation/bridge-detect(파이썬, 8계열 표준 브릿지 탐지기)를 호출해
 * 토큰별 비-EVM 체인의 브릿지(CCTP·Wormhole·IBC·StarkGate·Sui Bridge·LayerZero 등)를
 * bridge_detections 테이블에 적재. EVM 민트 권한은 기존 snapshot-bridge-authority 가 담당.
 *
 * 탐지 철학(파이썬 도구 그대로): 표준 인터페이스 응답/검증된 금고만 — 미확정 발행사는 제외.
 * Usage: npm run snapshot:bridgedetect [-- SYMBOLS...]
 * Env: DATABASE_URL, ALCHEMY_API_KEY, BASE_URL(주소 해석)
 */
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

import { closePool, query } from "@/db/client";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PY_DIR = resolve(__dirname, "../bridge-detect");
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const MAX_TOKENS = Number(process.env.BRIDGEDETECT_MAX ?? 8);
// 파이썬 도구의 비-EVM 계열만 (EVM 은 bridge-authority 담당)
const NONEVM_CHAINS = new Set(["solana", "sui", "aptos", "tron", "starknet", "stellar"]);
const MARKER = "@@BRIDGE_JSON@@";

interface PyBridge { standard: string; address: string; remotes?: { chain: string; address: string }[]; note?: string }
interface PyResult { family?: string; chain?: string | number; bridges?: PyBridge[]; error?: string }

function runDetect(addr: string, chain: string): Promise<PyResult | null> {
  return new Promise((res) => {
    const code = `import json,sys
sys.path.insert(0, ${JSON.stringify(PY_DIR)})
from main import main
r = main(sys.argv[1], sys.argv[2])
print(${JSON.stringify(MARKER)} + json.dumps({k: v for k, v in r.items() if k != "raw"}, ensure_ascii=False))`;
    const child = spawn("python3", ["-c", code, addr, chain], {
      cwd: PY_DIR,
      env: { ...process.env, ALCHEMY_KEY: process.env.ALCHEMY_KEY ?? process.env.ALCHEMY_API_KEY ?? "" },
    });
    let out = "";
    child.stdout.on("data", (d) => { out += String(d); });
    const timer = setTimeout(() => { child.kill("SIGKILL"); res(null); }, 120_000);
    child.on("exit", () => {
      clearTimeout(timer);
      const line = out.split("\n").find((l) => l.startsWith(MARKER));
      if (!line) return res(null);
      try { res(JSON.parse(line.slice(MARKER.length)) as PyResult); } catch { res(null); }
    });
    child.on("error", () => { clearTimeout(timer); res(null); });
  });
}

async function symbols(): Promise<string[]> {
  const argv = process.argv.slice(2).filter((s) => !s.startsWith("-"));
  if (argv.length) return argv;
  try {
    const d = (await fetch(`${BASE}/api/tokens`).then((r) => r.json())) as { tokens?: string[] };
    return [...new Set((d.tokens ?? []).map((t) => t.split("@")[0]))].slice(0, MAX_TOKENS);
  } catch { return ["USDC", "USDT", "USDe"]; }
}

async function main() {
  if (!process.env.DATABASE_URL) { console.error("[bridgedetect] DATABASE_URL 필요"); process.exit(1); }
  await query(`CREATE TABLE IF NOT EXISTS bridge_detections (
    token text NOT NULL, chain text NOT NULL, family text,
    standard text NOT NULL, bridge_address text NOT NULL,
    remotes jsonb, note text, snapshot_ts timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (token, chain, bridge_address, standard))`);

  const syms = await symbols();
  console.log(`[bridgedetect] ${syms.length}개 토큰 비-EVM 브릿지 탐지 (파이썬 도구)`);
  let rows = 0;
  for (const sym of syms) {
    let addrByChain: Record<string, string> = {};
    try {
      const d = (await fetch(`${BASE}/api/breadth/${encodeURIComponent(sym)}`).then((r) => r.json())) as { tokenAddrByChain?: Record<string, string> };
      addrByChain = d.tokenAddrByChain ?? {};
    } catch { continue; }
    for (const [chain, addr] of Object.entries(addrByChain)) {
      if (!NONEVM_CHAINS.has(chain)) continue;
      const r = await runDetect(addr, chain);
      if (!r?.bridges?.length) continue;
      for (const b of r.bridges) {
        await query(
          `INSERT INTO bridge_detections (token, chain, family, standard, bridge_address, remotes, note, snapshot_ts)
           VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,now())
           ON CONFLICT (token, chain, bridge_address, standard)
           DO UPDATE SET family=EXCLUDED.family, remotes=EXCLUDED.remotes, note=EXCLUDED.note, snapshot_ts=now()`,
          [sym, chain, r.family ?? chain, b.standard, b.address, JSON.stringify(b.remotes ?? []), b.note ?? null],
        );
        rows++;
      }
      console.log(`  ✓ ${sym}@${chain}: ${r.bridges.length}건`);
    }
  }
  console.log(`[bridgedetect] 완료 — ${rows}건 적재`);
  await closePool().catch(() => {});
}

main().catch(async (e) => { console.error(e); await closePool().catch(() => {}); process.exit(1); });
