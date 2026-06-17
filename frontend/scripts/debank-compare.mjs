#!/usr/bin/env node

import { chromium } from "playwright";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const DEFAULT_EOA_FLOW_URL = "http://127.0.0.1:3002/api/eoa-flow?address={address}&depth=1";

function parseArgs(argv) {
  const out = {
    addresses: [],
    chain: "eth",
    waitMs: 12_000,
    minProjectUsd: 1,
    minTokenUsd: 1,
    tolerance: 0.05,
    headful: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === "--address") out.addresses.push(next());
    else if (arg === "--addresses") out.addresses.push(...String(next()).split(/[,\s]+/));
    else if (arg === "--chain") out.chain = next();
    else if (arg === "--eoa-flow-file") out.eoaFlowFile = next();
    else if (arg === "--eoa-flow-url") out.eoaFlowUrl = next();
    else if (arg === "--out") out.out = next();
    else if (arg === "--chrome-path") out.chromePath = next();
    else if (arg === "--wait-ms") out.waitMs = Number(next());
    else if (arg === "--min-project-usd") out.minProjectUsd = Number(next());
    else if (arg === "--min-token-usd") out.minTokenUsd = Number(next());
    else if (arg === "--tolerance") out.tolerance = Number(next());
    else if (arg === "--headful") out.headful = true;
    else if (arg === "--help" || arg === "-h") out.help = true;
    else if (ADDRESS_RE.test(arg)) out.addresses.push(arg);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  out.addresses = [...new Set(out.addresses.map((addr) => addr.toLowerCase()).filter(Boolean))];
  return out;
}

function usage() {
  return `Usage:
  npm --prefix frontend run debank:compare -- --address 0x...
  npm --prefix frontend run debank:compare -- --addresses 0x1,0x2 --eoa-flow-file /path/eoa.json --out /tmp/compare.json

Options:
  --chain eth                         DeBank chain id to compare
  --eoa-flow-file <path>              Existing EOA-flow JSON to compare against
  --eoa-flow-url <url-with-{address}> EOA-flow API template
  --chrome-path <path>                Chrome executable path
  --headful                           Show browser
  --wait-ms <ms>                      Wait after DeBank profile load
  --min-project-usd <n>               Hide tiny DeBank protocol positions
  --min-token-usd <n>                 Hide tiny wallet tokens
  --tolerance <n>                     Token amount relative tolerance
  --out <path>                        Write full JSON report`;
}

function findChromePath(explicit) {
  const candidates = [
    explicit,
    process.env.PLAYWRIGHT_CHROME,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate));
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${url}`);
  return res.json();
}

async function loadOurPayload(address, opts) {
  if (opts.eoaFlowFile) return readJson(opts.eoaFlowFile);
  const template = opts.eoaFlowUrl || DEFAULT_EOA_FLOW_URL;
  return fetchJson(template.replace("{address}", address));
}

function maybeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function money(value) {
  const n = maybeNumber(value);
  const abs = Math.abs(n);
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

function amount(value) {
  const n = maybeNumber(value);
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(2)}K`;
  if (abs >= 1) return n.toFixed(4).replace(/\.?0+$/, "");
  if (abs === 0) return "0";
  return n.toPrecision(4).replace(/\.?0+$/, "");
}

function canonicalProtocolName(name, id = "") {
  const raw = `${name || ""} ${id || ""}`.toLowerCase();
  if (raw.includes("spark")) return "spark";
  if (raw.includes("aave")) return "aave3";
  if (raw.includes("morpho")) return "morpho";
  if (raw.includes("yield basis") || raw.includes("yieldbasis")) return "yieldbasis";
  if (raw.includes("9summits") || raw.includes("lagoon")) return "lagoon";
  if (raw.includes("f(x)") || raw.includes("fxprotocol") || raw.includes("fxusd")) return "fxprotocol";
  if (raw.includes("ether.fi") || raw.includes("etherfi")) return "etherfi";
  if (raw.includes("pendle")) return "pendle2";
  if (raw.includes("spectra")) return "spectra";
  if (raw.includes("euler")) return "euler";
  if (raw.includes("uniswap")) return "uniswap";
  if (raw.includes("curve")) return "curve";
  return raw.replace(/[^a-z0-9]+/g, " ").trim().split(" ").slice(0, 3).join(" ") || "unknown";
}

function tokenSymbol(token) {
  return token?.optimized_symbol || token?.display_symbol || token?.symbol || token?.name || "TOKEN";
}

function addToken(map, symbol, delta, meta = {}) {
  const key = String(symbol || "TOKEN");
  const cur = map.get(key) || { symbol: key, amount: 0, usd: 0, sources: [] };
  cur.amount += maybeNumber(delta);
  cur.usd += maybeNumber(meta.usd);
  if (meta.source) cur.sources.push(meta.source);
  map.set(key, cur);
}

function tokenUsd(token) {
  return maybeNumber(token?.amount) * maybeNumber(token?.price);
}

function summarizeDebankProject(project) {
  const items = project.portfolio_item_list || [];
  const tokens = new Map();
  const itemsOut = [];
  let netUsd = 0;
  let assetUsd = 0;
  let debtUsd = 0;
  for (const item of items) {
    const stats = item.stats || {};
    netUsd += maybeNumber(stats.net_usd_value);
    assetUsd += maybeNumber(stats.asset_usd_value);
    debtUsd += maybeNumber(stats.debt_usd_value);
    const detail = item.detail || {};
    const itemTokens = { supply: [], borrow: [], asset: [] };
    for (const token of detail.supply_token_list || []) {
      const sym = tokenSymbol(token);
      const usd = tokenUsd(token);
      addToken(tokens, sym, token.amount, { usd, source: "supply" });
      itemTokens.supply.push({ symbol: sym, amount: maybeNumber(token.amount), usd, id: token.id });
    }
    for (const token of detail.borrow_token_list || []) {
      const sym = tokenSymbol(token);
      const usd = tokenUsd(token);
      addToken(tokens, sym, -maybeNumber(token.amount), { usd: -usd, source: "borrow" });
      itemTokens.borrow.push({ symbol: sym, amount: maybeNumber(token.amount), usd, id: token.id });
    }
    if (!itemTokens.supply.length && !itemTokens.borrow.length) {
      for (const token of item.asset_token_list || []) {
        const sym = tokenSymbol(token);
        const usd = tokenUsd(token);
        addToken(tokens, sym, token.amount, { usd, source: "asset" });
        itemTokens.asset.push({ symbol: sym, amount: maybeNumber(token.amount), usd, id: token.id });
      }
    }
    itemsOut.push({
      name: item.name,
      detailTypes: item.detail_types || [],
      healthRate: detail.health_rate ?? null,
      stats,
      tokens: itemTokens,
    });
  }
  return {
    id: project.id,
    name: project.name || project.id,
    canonical: canonicalProtocolName(project.name, project.id),
    chain: project.chain,
    netUsd,
    assetUsd,
    debtUsd,
    tokens: [...tokens.values()].filter((t) => Math.abs(t.amount) > 1e-18 || Math.abs(t.usd) > 1e-9),
    items: itemsOut,
  };
}

function normalizeDebank(projectList, tokenList, opts) {
  const chain = opts.chain;
  const projects = ((projectList?.data || []) ?? [])
    .filter((project) => project.chain === chain)
    .map(summarizeDebankProject)
    .filter((project) => Math.abs(project.netUsd) >= opts.minProjectUsd)
    .sort((a, b) => Math.abs(b.netUsd) - Math.abs(a.netUsd));
  const walletTokens = ((tokenList?.data || []) ?? [])
    .filter((token) => token.chain === chain)
    .map((token) => ({
      symbol: tokenSymbol(token),
      amount: maybeNumber(token.amount),
      usd: tokenUsd(token),
      id: token.id,
      price: maybeNumber(token.price),
    }))
    .filter((token) => Math.abs(token.usd) >= opts.minTokenUsd)
    .sort((a, b) => Math.abs(b.usd) - Math.abs(a.usd));
  return { projects, walletTokens };
}

function isWalletNode(node) {
  const kind = node?.data?.kind;
  return node?.type === "eoa" || kind === "eoa" || kind === "safe";
}

function isDebtSymbol(symbol) {
  return /debt/i.test(symbol || "");
}

function isReceiptSymbol(symbol) {
  return /^(a|sp|stk|yv|pt-|yt-|morpho|9s)/i.test(symbol || "");
}

function isPositionLike(row) {
  const category = (row.category || "").toLowerCase();
  const label = (row.label || "").toLowerCase();
  const actions = row.actions.join(" ").toLowerCase();
  if (category === "swap" || /swap|paraswap|1inch|odos|uniswap|curve|balancer/.test(label) || /swap|exchange/.test(actions)) return false;
  if (/claim|reward|transfer|bridge/.test(actions)) return false;
  if (category === "yield_basis") return /deposit|stake|mint|withdraw|redeem/.test(actions);
  if (["lending", "vault", "pendle", "fx_long"].includes(category)) return true;
  return row.tokens.some((token) => isDebtSymbol(token.symbol) || isReceiptSymbol(token.symbol));
}

function normalizeOurEoaFlow(payload, address) {
  const addr = address.toLowerCase();
  const nodesById = new Map((payload.nodes || [])
    .filter((node) => node.type !== "event" && node?.data?.kind !== "event")
    .map((node) => [node.id, node]));
  const rows = new Map();
  for (const edge of payload.edges || []) {
    if (edge.edge_type !== "protocol_flow") continue;
    const source = nodesById.get(edge.source);
    const target = nodesById.get(edge.target);
    const protocol = source && isWalletNode(source) ? target : source;
    if (!protocol || isWalletNode(protocol)) continue;
    for (const detail of edge.details || []) {
      if ((detail.address || "").toLowerCase() !== addr) continue;
      const key = protocol.id;
      const row = rows.get(key) || {
        id: key,
        label: protocol.label,
        canonical: canonicalProtocolName(protocol.label, protocol.id),
        category: edge.category || protocol?.data?.category,
        tokensBySymbol: new Map(),
        txs: new Set(),
        actions: new Set(),
      };
      if (detail.tx_hash) row.txs.add(detail.tx_hash);
      if (detail.action) row.actions.add(detail.action);
      for (const transfer of detail.transfers || []) {
        if (transfer.direction === "internal") continue;
        const sign = transfer.direction === "out" ? -1 : 1;
        addToken(row.tokensBySymbol, transfer.symbol, sign * maybeNumber(transfer.amount), { source: transfer.direction });
      }
      rows.set(key, row);
    }
  }
  const all = [...rows.values()].map((row) => ({
    id: row.id,
    label: row.label,
    canonical: row.canonical,
    category: row.category,
    txCount: row.txs.size,
    actions: [...row.actions].sort(),
    tokens: [...row.tokensBySymbol.values()].filter((token) => Math.abs(token.amount) > 1e-18),
  })).filter((row) => row.tokens.length);
  return {
    positions: all.filter(isPositionLike).sort((a, b) => maxAbsToken(b) - maxAbsToken(a)),
    activity: all.filter((row) => !isPositionLike(row)).sort((a, b) => maxAbsToken(b) - maxAbsToken(a)),
  };
}

function maxAbsToken(row) {
  return Math.max(0, ...row.tokens.map((token) => Math.abs(token.amount)));
}

function compareAddress(debank, our, opts) {
  const ourByCanonical = new Map();
  for (const row of our.positions) {
    if (!ourByCanonical.has(row.canonical)) ourByCanonical.set(row.canonical, []);
    ourByCanonical.get(row.canonical).push(row);
  }
  const projectComparisons = debank.projects.map((project) => {
    const rows = ourByCanonical.get(project.canonical) || [];
    const ourTokens = new Map();
    for (const row of rows) {
      for (const token of row.tokens) addToken(ourTokens, token.symbol, token.amount, { source: row.label });
    }
    const tokenDiffs = project.tokens.map((dt) => {
      const ot = ourTokens.get(dt.symbol);
      const diff = ot ? ot.amount - dt.amount : null;
      const rel = diff == null ? null : Math.abs(diff) / Math.max(1e-12, Math.abs(dt.amount));
      return {
        symbol: dt.symbol,
        debankAmount: dt.amount,
        ourAmount: ot?.amount ?? null,
        diff,
        rel,
        pass: rel != null && rel <= opts.tolerance,
      };
    });
    return {
      project: project.name,
      canonical: project.canonical,
      netUsd: project.netUsd,
      matched: rows.length > 0,
      ourRows: rows.map((row) => row.label),
      tokenDiffs,
    };
  });
  return {
    matchedProjects: projectComparisons.filter((p) => p.matched).length,
    totalProjects: projectComparisons.length,
    missingProjects: projectComparisons.filter((p) => !p.matched).map((p) => p.project),
    projectComparisons,
  };
}

async function collectDebank(browser, address, opts) {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1200 },
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  });
  let projectList = null;
  let tokenList = null;
  let user = null;
  const wantedProject = `/portfolio/project_list?user_addr=${address}`;
  const wantedToken = `/token/balance_list?user_addr=${address}`;
  const wantedUser = `/user?id=${address}`;
  page.on("response", async (res) => {
    const url = res.url();
    try {
      if (url.includes(wantedProject)) projectList = await res.json();
      else if (url.includes(wantedToken) && url.includes(`chain=${opts.chain}`)) tokenList = await res.json();
      else if (url.includes(wantedUser)) user = await res.json();
    } catch {
      /* keep missing; DeBank sometimes races page close */
    }
  });
  const started = Date.now();
  await page.goto(`https://debank.com/profile/${address}`, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.waitForTimeout(opts.waitMs);
  const bodyText = await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "");
  await page.close();
  return {
    elapsedMs: Date.now() - started,
    raw: { projectList, tokenList, user },
    normalized: normalizeDebank(projectList, tokenList, opts),
    warnings: [
      !projectList ? "missing DeBank project_list response" : null,
      !tokenList ? `missing DeBank token balance_list response for chain=${opts.chain}` : null,
    ].filter(Boolean),
    bodyPreview: bodyText.slice(0, 1200),
  };
}

function printAddressReport(address, report) {
  const { debank, our, comparison } = report;
  console.log(`\n=== ${address} ===`);
  console.log(`DeBank: ${debank.normalized.projects.length} ${report.chain} projects, ${debank.normalized.walletTokens.length} wallet tokens, ${debank.elapsedMs}ms`);
  if (debank.warnings.length) console.log(`Warnings: ${debank.warnings.join("; ")}`);
  if (debank.normalized.projects.length) {
    console.log("DeBank projects:");
    for (const project of debank.normalized.projects.slice(0, 10)) {
      const toks = project.tokens.slice(0, 5).map((t) => `${t.amount < 0 ? "" : "+"}${amount(t.amount)} ${t.symbol}`).join(", ");
      console.log(`  - ${project.name} ${money(project.netUsd)} :: ${toks}`);
    }
  }
  if (our.positions.length) {
    console.log("Our position-like rows:");
    for (const row of our.positions.slice(0, 10)) {
      const toks = row.tokens.slice(0, 6).map((t) => `${t.amount < 0 ? "" : "+"}${amount(t.amount)} ${t.symbol}`).join(", ");
      console.log(`  - ${row.label} [${row.category}] :: ${toks}`);
    }
  } else {
    console.log("Our position-like rows: none");
  }
  console.log(`Protocol coverage: ${comparison.matchedProjects}/${comparison.totalProjects}`);
  if (comparison.missingProjects.length) console.log(`Missing DeBank projects: ${comparison.missingProjects.join(", ")}`);
  for (const pc of comparison.projectComparisons.filter((p) => p.matched).slice(0, 8)) {
    const diffs = pc.tokenDiffs.slice(0, 5).map((d) => {
      if (d.ourAmount == null) return `${d.symbol}: missing`;
      return `${d.symbol}: DeBank ${amount(d.debankAmount)} vs ours ${amount(d.ourAmount)} (${d.pass ? "OK" : "DIFF"})`;
    }).join("; ");
    console.log(`  * ${pc.project}: ${diffs || "no comparable tokens"}`);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(usage());
    return;
  }
  if (!opts.addresses.length) throw new Error("Provide --address or --addresses");
  for (const address of opts.addresses) {
    if (!ADDRESS_RE.test(address)) throw new Error(`Invalid address: ${address}`);
  }
  const executablePath = findChromePath(opts.chromePath);
  if (!executablePath) {
    throw new Error("No Chrome executable found. Pass --chrome-path or install Playwright browsers.");
  }

  const browser = await chromium.launch({ headless: !opts.headful, executablePath });
  const results = {};
  try {
    for (const address of opts.addresses) {
      const debank = await collectDebank(browser, address, opts);
      const ourPayload = await loadOurPayload(address, opts).catch((err) => ({ nodes: [], edges: [], metadata: { error: String(err) } }));
      const our = normalizeOurEoaFlow(ourPayload, address);
      const comparison = compareAddress(debank.normalized, our, opts);
      results[address] = {
        chain: opts.chain,
        debank,
        our,
        ourMetadata: ourPayload.metadata || {},
        comparison,
      };
      printAddressReport(address, results[address]);
    }
  } finally {
    await browser.close();
  }

  if (opts.out) {
    await mkdir(path.dirname(opts.out), { recursive: true });
    await writeFile(opts.out, JSON.stringify({ generatedAt: new Date().toISOString(), options: opts, results }, null, 2));
    console.log(`\nwrote ${opts.out}`);
  }
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exitCode = 1;
});
