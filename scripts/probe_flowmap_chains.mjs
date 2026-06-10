#!/usr/bin/env node
/**
 * 상황판 멀티체인 후보 프로브 — 체인 RPC·프로토콜 주소를 온체인 실증으로만 등록하기 위한 하네스.
 * (docs/flow-situation-board.md 원칙: "토픽/주소 상수는 메모리가 아니라 온체인 실증으로 고정")
 *
 * 검사 항목(체인별):
 *   1. publicnode RPC 살아있나 + blockSec 실측(latest vs latest-10000 타임스탬프)
 *   2. Aave V3 풀 후보: getCode + getReservesList() 리저브 수 + reserve[0] symbol() 디코드
 *      + 최근 슬라이스 Supply 토픽 로그 수(활동)
 *   3. Compound V3 Comet 후보: baseToken() → symbol 해석
 *   4. Balancer V2 Vault(전 체인 동일 주소 후보): getCode + Swap 로그
 *   5. Fluid Liquidity(메인넷 주소 동일 배포 후보): getCode + LogOperate 로그
 *   6. Uniswap V3 팩토리 후보: feeAmountTickSpacing(500)==10 구성적 검증
 *   7. publicnode 주소배열 getLogs 허용 여부(멀티주소 풀 조회 가능성)
 *   8. Curve 공식 API 체인 슬러그 존재 여부
 *   9. DeFiLlama 가격 슬러그(coins.llama.fi `{slug}:{addr}`) 동작 확인
 *  10. Morpho blue-api 가 그 chainId 트랜잭션을 주는지
 *
 * 실행: cd frontend && node ../scripts/probe_flowmap_chains.mjs
 * 출력: 체인별 PASS/FAIL 표 — PASS 만 lib/flowmap.ts CHAINS 레지스트리에 등록할 것.
 */
// 셀렉터 — viem keccak256(stringToBytes(sig)).slice(0,10) 로 계산해 고정(2026-06-10).
// 의존성 없이 실행 가능하도록 하드코딩; 시그니처를 바꾸면 viem 으로 재계산할 것.
const SEL = {
  getReservesList: "0xd1946dbc", // getReservesList()
  symbol: "0x95d89b41",          // symbol()
  decimals: "0x313ce567",        // decimals()
  baseToken: "0xc55dae63",       // baseToken()
  feeTick: "0x22afcccb",         // feeAmountTickSpacing(uint24)
};
const AAVE_SUPPLY_TOPIC = "0x2b627736bca15cd5381dcf80b0bf11fd197d01a037c52b927a881a10fb73ba61";
const BAL_SWAP_TOPIC = "0x2170c741c41531aec20e7c107c24eecfdd15e69c9bb0a8dd37b1840b9e0b207b";
const FLUID_LOGOPERATE = "0x4d93b232a24e82b284ced7461bf4deacffe66759d5c24513e6f29e571ad78d15";
const BAL_VAULT = "0xba12222222228d8ba445958a75a0704d566bf2c8";
const FLUID_ADDR = "0x52aa899454998be5b000ad077a46bbe360f4e497";

// 후보 (메모리 출처 — 전부 아래 프로브를 통과해야만 채택)
const CANDS = [
  { key: "base", rpc: "https://base-rpc.publicnode.com", llama: ["base"], aave: [["Aave V3", "0xa238dd80c259a72e81d7e4664a9801593f98d1c5"]], comets: ["0xb125e6687d4313864e53df431d5425969c15eb2f", "0x46e6b214b524310239732d51387075e0e70970bf"], univ3: "0x33128a8fc17869897dce68ed026d694621f6fdfd", curve: "base", morphoChainId: 8453 },
  { key: "arbitrum", rpc: "https://arbitrum-one-rpc.publicnode.com", llama: ["arbitrum"], aave: [["Aave V3", "0x794a61358d6845594f94dc1db02a252b5b4814ad"]], comets: ["0xa5edbdd9646f8dff606d7448e414884c7d905dca", "0x9c4ec768c28520b50860ea7a15bd7213a9ff58bf", "0x6f7d514bbd4aff3bcd1140b7344b32f063dee486", "0xd98be00b5d27fc98112bde293e487f8d4ca57d07"], univ3: "0x1f98431c8ad98523631ae4a59f267346ea31f984", curve: "arbitrum", morphoChainId: 42161 },
  { key: "optimism", rpc: "https://optimism-rpc.publicnode.com", llama: ["optimism"], aave: [["Aave V3", "0x794a61358d6845594f94dc1db02a252b5b4814ad"]], comets: ["0x2e44e174f7d53f0212823acc11c01a11d58c5bcb", "0x995e394b8b2437ac8ce61ee0bc610d617962b214", "0xe36a30d249f7761327fd973001a32010b521b6fd"], univ3: "0x1f98431c8ad98523631ae4a59f267346ea31f984", curve: "optimism", morphoChainId: 10 },
  { key: "polygon", rpc: "https://polygon-bor-rpc.publicnode.com", llama: ["polygon"], aave: [["Aave V3", "0x794a61358d6845594f94dc1db02a252b5b4814ad"]], comets: ["0xf25212e676d1f7f89cd72ffee66158f541246445", "0xaeb318360f27748acb200ce616e389a6c9409a07"], univ3: "0x1f98431c8ad98523631ae4a59f267346ea31f984", curve: "polygon", morphoChainId: 137 },
  { key: "avalanche", rpc: "https://avalanche-c-chain-rpc.publicnode.com", llama: ["avax", "avalanche"], aave: [["Aave V3", "0x794a61358d6845594f94dc1db02a252b5b4814ad"]], comets: [], univ3: "0x740b1c1de25031c31ff4fc9a62f554a55cdc1bad", curve: "avalanche", morphoChainId: 43114 },
  { key: "bsc", rpc: "https://bsc-rpc.publicnode.com", llama: ["bsc"], aave: [["Aave V3", "0x6807dc923806fe8fd134338eabca509979a7e0cb"]], comets: [], univ3: "0xdb1d10011ad0ff90774d0c6bb92e5c5c8b4461f7", curve: null, morphoChainId: 56 },
  { key: "gnosis", rpc: "https://gnosis-rpc.publicnode.com", llama: ["xdai", "gnosis"], aave: [["Aave V3", "0xb50201558b00496a145fe76f7424749556e326d8"], ["Spark", "0x2dae5307c5e3fd1cf5a72cb6f698f915860607e0"]], comets: [], univ3: null, curve: "xdai", morphoChainId: 100 },
  { key: "scroll", rpc: "https://scroll-rpc.publicnode.com", llama: ["scroll"], aave: [["Aave V3", "0x11fcfe756c05ad438e312a7fd934381537d3cffe"]], comets: ["0xb2f97c1bd3bf02f5e74d13f02e3e26f93d77ce44"], univ3: null, curve: null, morphoChainId: 534352 },
  { key: "linea", rpc: "https://linea-rpc.publicnode.com", llama: ["linea"], aave: [["Aave V3", "0xc47b8c00b0f69a36fa203ffeac0334874574a8ac"]], comets: [], univ3: null, curve: null, morphoChainId: 59144 },
  { key: "sonic", rpc: "https://sonic-rpc.publicnode.com", llama: ["sonic"], aave: [["Aave V3", "0x5362dbb1e601abf3a4c14c22ffeda64042e5eaa3"]], comets: [], univ3: null, curve: null, morphoChainId: 146 },
  { key: "celo", rpc: "https://celo-rpc.publicnode.com", llama: ["celo"], aave: [["Aave V3", "0x3e59a31363e2ad014dcbc521c4a0d5757d9f3402"]], comets: [], univ3: "0xafe208a311b21f13ef87e33a90049fc17a7acdec", curve: null, morphoChainId: 42220 },
  { key: "metis", rpc: "https://metis-rpc.publicnode.com", llama: ["metis"], aave: [["Aave V3", "0x90df02551bb792286e8d4f13e0e357b4bf1d6a57"]], comets: [], univ3: null, curve: null, morphoChainId: 1088 },
  { key: "zksync", rpc: "https://zksync-rpc.publicnode.com", llama: ["era", "zksync era"], aave: [["Aave V3", "0x78e30497a3c7527d953c6b1e3541b021a98ac43c"]], comets: [], univ3: null, curve: null, morphoChainId: 324 },
];

const HDRS = { "content-type": "application/json", "user-agent": "Mozilla/5.0 chain-spiral-probe/0.1" };
async function rpc(url, method, params, timeoutMs = 20000) {
  const r = await fetch(url, { method: "POST", headers: HDRS, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`http ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(JSON.stringify(j.error).slice(0, 100));
  return j.result;
}
const call = (url, to, data) => rpc(url, "eth_call", [{ to, data }, "latest"]);
const hex = (n) => "0x" + n.toString(16);
const decStr = (ret) => { // abi string 디코드 (offset,len,data) — bytes32 심볼(MKR류)도 폴백
  if (!ret || ret === "0x") return null;
  const h = ret.slice(2);
  try {
    if (h.length <= 64) return Buffer.from(h, "hex").toString("utf8").replace(/\0+$/, "") || null;
    const len = parseInt(h.slice(64, 128), 16);
    return Buffer.from(h.slice(128, 128 + len * 2), "hex").toString("utf8") || null;
  } catch { return null; }
};

async function probeChain(c) {
  const out = { key: c.key, ok: false, notes: [] };
  try {
    const latest = parseInt(await rpc(c.rpc, "eth_blockNumber", []), 16);
    const [b1, b0] = await Promise.all([
      rpc(c.rpc, "eth_getBlockByNumber", [hex(latest), false]),
      rpc(c.rpc, "eth_getBlockByNumber", [hex(Math.max(1, latest - 10000)), false]),
    ]);
    const blockSec = (parseInt(b1.timestamp, 16) - parseInt(b0.timestamp, 16)) / 10000;
    out.blockSec = Math.round(blockSec * 1000) / 1000;
    out.latest = latest;
    const sliceBlocks = Math.min(50_000, Math.max(400, Math.round(1800 / blockSec))); // ≈30분 슬라이스
    const from = hex(latest - sliceBlocks);

    // Aave 인스턴스들
    out.aave = [];
    for (const [name, addr] of c.aave) {
      const a = { name, addr, pass: false };
      try {
        const codeHex = await rpc(c.rpc, "eth_getCode", [addr, "latest"]);
        if (!codeHex || codeHex === "0x") throw new Error("no code");
        const res = await call(c.rpc, addr, SEL.getReservesList);
        const n = res && res.length > 130 ? parseInt(res.slice(66, 130), 16) : 0;
        if (!(n > 0 && n < 200)) throw new Error(`reserves=${n}`);
        a.reserves = n;
        const first = "0x" + res.slice(130 + 24, 130 + 64);
        a.firstSym = decStr(await call(c.rpc, first, SEL.symbol));
        const logs = await rpc(c.rpc, "eth_getLogs", [{ address: addr, fromBlock: from, toBlock: hex(latest), topics: [AAVE_SUPPLY_TOPIC] }]);
        a.supplyLogs = logs.length;
        a.pass = a.firstSym != null;
      } catch (e) { a.err = String(e).slice(0, 60); }
      out.aave.push(a);
    }

    // Comet 후보
    out.comets = [];
    for (const addr of c.comets) {
      const cm = { addr, pass: false };
      try {
        const base = await call(c.rpc, addr, SEL.baseToken);
        const baseAddr = "0x" + base.slice(-40);
        if (/^0x0{40}$/.test(baseAddr)) throw new Error("zero base");
        cm.baseSym = decStr(await call(c.rpc, baseAddr, SEL.symbol));
        cm.pass = cm.baseSym != null;
      } catch (e) { cm.err = String(e).slice(0, 40); }
      out.comets.push(cm);
    }

    // Balancer / Fluid (동일 주소 배포 후보)
    try {
      const code = await rpc(c.rpc, "eth_getCode", [BAL_VAULT, "latest"]);
      if (code && code !== "0x") {
        const logs = await rpc(c.rpc, "eth_getLogs", [{ address: BAL_VAULT, fromBlock: from, toBlock: hex(latest), topics: [BAL_SWAP_TOPIC] }]);
        out.balancer = { pass: true, swaps: logs.length };
      } else out.balancer = { pass: false };
    } catch (e) { out.balancer = { pass: false, err: String(e).slice(0, 40) }; }
    try {
      const code = await rpc(c.rpc, "eth_getCode", [FLUID_ADDR, "latest"]);
      if (code && code !== "0x") {
        const logs = await rpc(c.rpc, "eth_getLogs", [{ address: FLUID_ADDR, fromBlock: from, toBlock: hex(latest), topics: [FLUID_LOGOPERATE] }]);
        out.fluid = { pass: logs.length >= 0, ops: logs.length };
      } else out.fluid = { pass: false };
    } catch (e) { out.fluid = { pass: false, err: String(e).slice(0, 40) }; }

    // UniV3 팩토리 — feeAmountTickSpacing(500) == 10 구성적 검증
    if (c.univ3) {
      try {
        const r = await call(c.rpc, c.univ3, SEL.feeTick + (500).toString(16).padStart(64, "0"));
        out.univ3 = { pass: parseInt(r, 16) === 10 };
      } catch (e) { out.univ3 = { pass: false, err: String(e).slice(0, 40) }; }
    }

    // 주소배열 getLogs 허용?
    try {
      const addrs = [c.aave[0][1], BAL_VAULT];
      await rpc(c.rpc, "eth_getLogs", [{ address: addrs, fromBlock: hex(latest - 100), toBlock: hex(latest) }]);
      out.addrArray = true;
    } catch (e) { out.addrArray = false; out.notes.push(`addrArray: ${String(e).slice(0, 50)}`); }

    // 가격 슬러그 — Aave reserve[0] 주소로 검증
    const probeAddr = out.aave[0]?.pass ? "0x" + (await call(c.rpc, c.aave[0][1], SEL.getReservesList)).slice(130 + 24, 130 + 64) : null;
    out.llama = null;
    if (probeAddr) {
      for (const slug of c.llama) {
        try {
          const r = await fetch(`https://coins.llama.fi/prices/current/${slug}:${probeAddr}`, { signal: AbortSignal.timeout(10000) });
          const j = await r.json();
          if (j?.coins?.[`${slug}:${probeAddr}`]?.price > 0) { out.llama = slug; break; }
        } catch { /* next */ }
      }
    }

    // Curve API
    if (c.curve) {
      try {
        const r = await fetch(`https://api.curve.finance/api/getPools/${c.curve}/main`, { headers: { "user-agent": HDRS["user-agent"] }, signal: AbortSignal.timeout(15000) });
        const j = await r.json();
        out.curve = { pass: (j?.data?.poolData ?? []).length > 0, pools: (j?.data?.poolData ?? []).length };
      } catch (e) { out.curve = { pass: false, err: String(e).slice(0, 40) }; }
    }

    out.ok = out.aave.some((a) => a.pass);
  } catch (e) { out.fatal = String(e).slice(0, 80); }
  return out;
}

// Morpho 체인 커버리지 — 한 번에
async function probeMorpho(ids) {
  const out = {};
  for (const id of ids) {
    try {
      const q = `{ transactions(first:1, where:{ chainId_in:[${id}], type_in:[MarketSupply] }){ items{ hash } } }`;
      const r = await fetch("https://blue-api.morpho.org/graphql", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: q }), signal: AbortSignal.timeout(15000) });
      const j = await r.json();
      out[id] = !j.errors && (j?.data?.transactions?.items ?? []).length > 0;
    } catch { out[id] = false; }
  }
  return out;
}

const results = await Promise.all(CANDS.map(probeChain));
const morpho = await probeMorpho(CANDS.map((c) => c.morphoChainId));
for (const r of results) {
  const c = CANDS.find((x) => x.key === r.key);
  console.log(`\n══ ${r.key} ${r.ok ? "✅" : "❌"} blockSec=${r.blockSec ?? "?"} latest=${r.latest ?? "?"} ${r.fatal ? "FATAL: " + r.fatal : ""}`);
  for (const a of r.aave ?? []) console.log(`  Aave ${a.name}: ${a.pass ? `PASS reserves=${a.reserves} first=${a.firstSym} supplyLogs(슬라이스)=${a.supplyLogs}` : `FAIL ${a.err ?? ""}`}`);
  for (const cm of r.comets ?? []) console.log(`  Comet ${cm.addr.slice(0, 10)}…: ${cm.pass ? `PASS base=${cm.baseSym}` : `FAIL ${cm.err ?? ""}`}`);
  if (r.balancer) console.log(`  Balancer: ${r.balancer.pass ? `PASS swaps=${r.balancer.swaps}` : "없음"}`);
  if (r.fluid) console.log(`  Fluid: ${r.fluid.pass ? `PASS ops=${r.fluid.ops}` : "없음"}`);
  if (r.univ3) console.log(`  UniV3 factory: ${r.univ3.pass ? "PASS (tick(500)=10)" : "FAIL"}`);
  console.log(`  addrArray getLogs: ${r.addrArray ? "허용" : "거부"} · llama slug: ${r.llama ?? "?"} · curve: ${r.curve ? (r.curve.pass ? r.curve.pools + "풀" : "FAIL") : "-"} · morpho(${c.morphoChainId}): ${morpho[c.morphoChainId] ? "있음" : "없음"}`);
  if (r.notes.length) console.log(`  notes: ${r.notes.join(" | ")}`);
}
