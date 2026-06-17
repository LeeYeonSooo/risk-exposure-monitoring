#!/usr/bin/env node

import { chromium } from "playwright";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const DEFAULT_WALLET_URL = "http://127.0.0.1:3002/api/wallet-portfolio?address={address}&chain=ethereum";

function parseArgs(argv) {
  const out = {
    addresses: [],
    chain: "eth",
    waitMs: 12_000,
    minProjectUsd: 1,
    minTokenUsd: 1,
    headful: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === "--address") out.addresses.push(next());
    else if (arg === "--addresses") out.addresses.push(...String(next()).split(/[,\s]+/));
    else if (arg === "--chain") out.chain = next();
    else if (arg === "--wallet-url") out.walletUrl = next();
    else if (arg === "--out") out.out = next();
    else if (arg === "--chrome-path") out.chromePath = next();
    else if (arg === "--profile-dir") out.profileDir = next();
    else if (arg === "--proxy") out.proxy = next();
    else if (arg === "--wait-ms") out.waitMs = Number(next());
    else if (arg === "--min-project-usd") out.minProjectUsd = Number(next());
    else if (arg === "--min-token-usd") out.minTokenUsd = Number(next());
    else if (arg === "--headful") out.headful = true;
    else if (arg === "--help" || arg === "-h") out.help = true;
    else if (ADDRESS_RE.test(arg)) out.addresses.push(arg);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  out.addresses = [...new Set(out.addresses.map((a) => String(a).toLowerCase()).filter(Boolean))];
  return out;
}

function usage() {
  return `Usage:
  npm --prefix frontend run wallet:compare -- --address 0x...

Options:
  --chain eth                         DeBank chain id
  --wallet-url <url-with-{address}>   Internal API template
  --chrome-path <path>                Chrome executable path
  --profile-dir <path>                Persistent browser profile for DeBank
  --proxy <server>                    Browser proxy server
  --headful                           Show browser
  --wait-ms <ms>                      Wait after DeBank profile load
  --min-project-usd <n>               Hide tiny DeBank protocols
  --min-token-usd <n>                 Hide tiny direct wallet tokens
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

async function fetchJson(url) {
  const started = Date.now();
  const res = await fetch(url, { headers: { accept: "application/json" } });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 240)}`);
  return { elapsedMs: Date.now() - started, body: JSON.parse(text) };
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
  if (raw.includes("compound")) return "compound3";
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

function tokenUsd(token) {
  return maybeNumber(token?.amount) * maybeNumber(token?.price);
}

function normalizeDebankToken(token, source) {
  return {
    tokenAddress: typeof token?.id === "string" && token.id.startsWith("0x") ? token.id.toLowerCase() : token?.id ?? null,
    symbol: tokenSymbol(token),
    amount: maybeNumber(token?.amount),
    priceUsd: token?.price == null ? null : maybeNumber(token.price),
    valueUsd: tokenUsd(token),
    source,
  };
}

function summarizeDebankProject(project) {
  const positions = [];
  let netUsd = 0;
  let assetUsd = 0;
  let debtUsd = 0;
  for (const item of project.portfolio_item_list || []) {
    const stats = item.stats || {};
    const detail = item.detail || {};
    netUsd += maybeNumber(stats.net_usd_value);
    assetUsd += maybeNumber(stats.asset_usd_value);
    debtUsd += maybeNumber(stats.debt_usd_value);
    const supplied = (detail.supply_token_list || []).map((t) => normalizeDebankToken(t, "debank:supply"));
    const collateral = (detail.collateral_token_list || []).map((t) => normalizeDebankToken(t, "debank:collateral"));
    const borrowed = (detail.borrow_token_list || []).map((t) => normalizeDebankToken(t, "debank:borrow"));
    const assets = (item.asset_token_list || []).map((t) => normalizeDebankToken(t, "debank:asset"));
    positions.push({
      label: item.name || project.name || project.id,
      type: item.detail_types || [],
      healthRate: detail.health_rate ?? null,
      supplied: supplied.length ? supplied : assets,
      collateral,
      borrowed,
      stats,
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
    positions,
  };
}

function normalizeDebank(projectList, tokenList, opts) {
  const projects = ((projectList?.data || []) ?? [])
    .filter((project) => project.chain === opts.chain)
    .map(summarizeDebankProject)
    .filter((project) => Math.abs(project.netUsd) >= opts.minProjectUsd)
    .sort((a, b) => Math.abs(b.netUsd) - Math.abs(a.netUsd));
  const walletTokens = ((tokenList?.data || []) ?? [])
    .filter((token) => token.chain === opts.chain)
    .map((token) => normalizeDebankToken(token, "debank:wallet"))
    .filter((token) => Math.abs(token.valueUsd) >= opts.minTokenUsd)
    .sort((a, b) => Math.abs(b.valueUsd) - Math.abs(a.valueUsd));
  return { projects, walletTokens };
}

function tokenKey(token) {
  const address = token?.tokenAddress || token?.id;
  if (typeof address === "string" && address.startsWith("0x")) return `addr:${address.toLowerCase()}`;
  return `sym:${String(token?.symbol || "TOKEN").toLowerCase()}`;
}

function flattenOurProtocolTokens(protocol, side) {
  const tokens = [];
  for (const position of protocol.positions || []) {
    for (const token of position[side] || []) tokens.push(token);
  }
  return tokens;
}

function sumTokens(tokens) {
  const byKey = new Map();
  for (const token of tokens) {
    const key = tokenKey(token);
    const cur = byKey.get(key) || {
      tokenAddress: token.tokenAddress ?? null,
      symbol: token.symbol || "TOKEN",
      amount: 0,
      valueUsd: 0,
      priced: false,
    };
    cur.amount += maybeNumber(token.amount);
    if (token.valueUsd != null) {
      cur.valueUsd += maybeNumber(token.valueUsd);
      cur.priced = true;
    }
    byKey.set(key, cur);
  }
  return [...byKey.values()].map((row) => ({ ...row, valueUsd: row.priced ? row.valueUsd : null }));
}

function compareTokens(debankTokens, ourTokens) {
  const ours = new Map(sumTokens(ourTokens).map((token) => [tokenKey(token), token]));
  return debankTokens.map((dt) => {
    const exact = ours.get(tokenKey(dt));
    const fallback = exact || [...ours.values()].find((ot) => String(ot.symbol).toLowerCase() === String(dt.symbol).toLowerCase());
    return {
      symbol: dt.symbol,
      debankAmount: dt.amount,
      ourAmount: fallback?.amount ?? null,
      debankUsd: dt.valueUsd,
      ourUsd: fallback?.valueUsd ?? null,
      matched: !!fallback,
    };
  });
}

function compareAddress(debank, internal) {
  const ourProtocols = internal.protocols || [];
  const ourByCanonical = new Map();
  for (const protocol of ourProtocols) {
    if (!ourByCanonical.has(protocol.canonical)) ourByCanonical.set(protocol.canonical, []);
    ourByCanonical.get(protocol.canonical).push(protocol);
  }
  const projectComparisons = debank.projects.map((project) => {
    const ours = ourByCanonical.get(project.canonical) || [];
    const ourSupplied = ours.flatMap((p) => flattenOurProtocolTokens(p, "supplied"));
    const ourCollateral = ours.flatMap((p) => flattenOurProtocolTokens(p, "collateral"));
    const ourBorrowed = ours.flatMap((p) => flattenOurProtocolTokens(p, "borrowed"));
    const debankSupplied = project.positions.flatMap((p) => p.supplied || []);
    const debankCollateral = project.positions.flatMap((p) => p.collateral || []);
    const debankBorrowed = project.positions.flatMap((p) => p.borrowed || []);
    return {
      project: project.name,
      canonical: project.canonical,
      debankNetUsd: project.netUsd,
      ourNetUsd: ours.reduce((sum, p) => sum + maybeNumber(p.netUsd), 0),
      matched: ours.length > 0,
      ourProtocols: ours.map((p) => p.protocolName),
      supplied: compareTokens(debankSupplied, ourSupplied),
      collateral: compareTokens(debankCollateral, ourCollateral),
      borrowed: compareTokens(debankBorrowed, ourBorrowed),
    };
  });
  const walletComparisons = compareTokens(debank.walletTokens, internal.walletTokens || []);
  return {
    protocolCoverage: {
      matched: projectComparisons.filter((p) => p.matched).length,
      total: projectComparisons.length,
      missing: projectComparisons.filter((p) => !p.matched).map((p) => p.project),
    },
    walletTokenCoverage: {
      matched: walletComparisons.filter((t) => t.matched).length,
      total: walletComparisons.length,
      missing: walletComparisons.filter((t) => !t.matched).map((t) => t.symbol),
    },
    projectComparisons,
    walletComparisons,
  };
}

async function collectDebank(context, address, opts) {
  const page = await context.newPage();
  let projectList = null;
  let tokenList = null;
  let user = null;
  const wantedProject = `/portfolio/project_list?user_addr=${address}`;
  const wantedToken = `/token/balance_list?user_addr=${address}`;
  const wantedUser = `/user?id=${address}`;
  page.on("response", async (res) => {
    const url = res.url();
    try {
      if (url.includes(wantedProject) || url.includes("/user/all_complex_protocol_list")) projectList = await res.json();
      else if ((url.includes(wantedToken) && url.includes(`chain=${opts.chain}`)) || url.includes("/user/all_token_list")) tokenList = await res.json();
      else if (url.includes(wantedUser) || url.includes("/user/total_balance")) user = await res.json();
    } catch {
      /* DeBank responses can race page close */
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
      !projectList ? "missing DeBank project list response" : null,
      !tokenList ? `missing DeBank token list response for chain=${opts.chain}` : null,
    ].filter(Boolean),
    bodyPreview: bodyText.slice(0, 1200),
  };
}

async function makeBrowserContext(opts) {
  const executablePath = findChromePath(opts.chromePath);
  if (!executablePath) throw new Error("No Chrome executable found. Pass --chrome-path or install Playwright browsers.");
  const launchOptions = {
    headless: !opts.headful,
    executablePath,
    args: ["--disable-blink-features=AutomationControlled"],
    proxy: opts.proxy ? { server: opts.proxy } : undefined,
  };
  const contextOptions = {
    viewport: { width: 1440, height: 1200 },
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    locale: "en-US",
    timezoneId: "America/New_York",
  };
  if (opts.profileDir) {
    const context = await chromium.launchPersistentContext(opts.profileDir, { ...launchOptions, ...contextOptions });
    await context.addInitScript(() => Object.defineProperty(navigator, "webdriver", { get: () => undefined }));
    return { context, close: () => context.close() };
  }
  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext(contextOptions);
  await context.addInitScript(() => Object.defineProperty(navigator, "webdriver", { get: () => undefined }));
  return { context, close: async () => { await context.close(); await browser.close(); } };
}

function printAddressReport(address, report) {
  const { debank, internal, comparison } = report;
  console.log(`\n=== ${address} ===`);
  console.log(`Internal: total ${money(internal.totalUsd)} (${internal.walletTokens.length} wallet tokens, ${internal.protocols.length} protocols, ${report.internalElapsedMs}ms)`);
  console.log(`DeBank: ${debank.normalized.projects.length} ${report.chain} projects, ${debank.normalized.walletTokens.length} wallet tokens, ${debank.elapsedMs}ms`);
  if (debank.warnings.length) console.log(`Warnings: ${debank.warnings.join("; ")}`);
  if (internal.dataGaps?.length) console.log(`Internal gaps: ${internal.dataGaps.join("; ")}`);
  console.log(`Wallet token coverage: ${comparison.walletTokenCoverage.matched}/${comparison.walletTokenCoverage.total}`);
  if (comparison.walletTokenCoverage.missing.length) console.log(`Missing wallet tokens: ${comparison.walletTokenCoverage.missing.slice(0, 12).join(", ")}`);
  console.log(`Protocol coverage: ${comparison.protocolCoverage.matched}/${comparison.protocolCoverage.total}`);
  if (comparison.protocolCoverage.missing.length) console.log(`Missing DeBank protocols: ${comparison.protocolCoverage.missing.join(", ")}`);
  for (const pc of comparison.projectComparisons.filter((p) => p.matched).slice(0, 10)) {
    const borrow = pc.borrowed.filter((t) => t.matched).slice(0, 3).map((t) => `${t.symbol} ${amount(t.debankAmount)} vs ${amount(t.ourAmount)}`).join("; ");
    const coll = pc.collateral.filter((t) => t.matched).slice(0, 3).map((t) => `${t.symbol} ${amount(t.debankAmount)} vs ${amount(t.ourAmount)}`).join("; ");
    console.log(`  * ${pc.project}: DeBank ${money(pc.debankNetUsd)} vs internal ${money(pc.ourNetUsd)}${coll ? ` | collateral ${coll}` : ""}${borrow ? ` | debt ${borrow}` : ""}`);
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

  const browser = await makeBrowserContext(opts);
  const results = {};
  try {
    for (const address of opts.addresses) {
      const template = opts.walletUrl || DEFAULT_WALLET_URL;
      const internalFetch = await fetchJson(template.replace("{address}", address));
      const debank = await collectDebank(browser.context, address, opts);
      const comparison = compareAddress(debank.normalized, internalFetch.body);
      results[address] = {
        chain: opts.chain,
        internalElapsedMs: internalFetch.elapsedMs,
        internal: internalFetch.body,
        debank,
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
