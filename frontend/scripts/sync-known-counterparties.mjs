#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import path from "node:path";

const DUNE_API = "https://api.dune.com/api/v1";
const OUTPUT = path.resolve("data/known-counterparties.generated.json");
const ADDRESS_RE = /^0x[a-f0-9]{40}$/;
const LIMIT = Math.max(100, Math.min(Number(process.argv.find((arg) => arg.startsWith("--limit="))?.split("=")[1] ?? 25_000), 100_000));
const apiKey = process.env.DUNE_API_KEY;

if (!apiKey) {
  console.error("DUNE_API_KEY is required. Source your env first; do not print the key.");
  process.exit(1);
}

function normalizeAddress(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return null;
  const prefixed = raw.startsWith("0x") ? raw : `0x${raw}`;
  return ADDRESS_RE.test(prefixed) ? prefixed : null;
}

function mapCategory(row) {
  const category = String(row.category ?? "").toLowerCase();
  const name = String(row.name ?? "").toLowerCase();
  const model = String(row.model_name ?? "").toLowerCase();
  const haystack = `${category} ${name} ${model}`;
  if (category === "cex" || haystack.includes("exchange")) return "cex";
  if (category === "bridge" || haystack.includes("bridge")) return "bridge";
  if (haystack.includes("solver") || haystack.includes("settlement")) return "solver";
  if (haystack.includes("router") || haystack.includes("aggregator") || haystack.includes("swaprouter")) return "router";
  return "protocol";
}

async function dune(pathname, options = {}) {
  const res = await fetch(`${DUNE_API}${pathname}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-Dune-Api-Key": apiKey,
      ...(options.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Dune ${pathname} HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  return res.json();
}

async function main() {
  const sql = `
    SELECT
      blockchain,
      address,
      name,
      category,
      source,
      updated_at,
      model_name
    FROM labels.addresses
    WHERE blockchain = 'ethereum'
      AND (
        category IN ('cex', 'bridge', 'defi', 'lending', 'stablecoin', 'yield')
        OR model_name IN ('dex_pools')
      )
      AND lower(name) NOT LIKE '% user%'
      AND lower(name) NOT LIKE '%trader%'
    ORDER BY
      CASE
        WHEN category = 'cex' THEN 0
        WHEN category = 'bridge' THEN 1
        WHEN model_name = 'dex_pools' THEN 2
        ELSE 3
      END,
      updated_at DESC NULLS LAST,
      name ASC
    LIMIT ${LIMIT}
  `;

  const execution = await dune("/sql/execute", {
    method: "POST",
    body: JSON.stringify({ sql }),
  });
  const executionId = execution.execution_id;
  if (!executionId) throw new Error("Dune did not return execution_id");

  let status = null;
  for (let i = 0; i < 90; i += 1) {
    status = await dune(`/execution/${executionId}/status`);
    if (status.is_execution_finished) break;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  if (!status?.is_execution_finished) throw new Error(`Dune execution timed out: ${executionId}`);
  if (!String(status.state ?? "").includes("COMPLETED")) {
    throw new Error(`Dune execution failed: ${status.state ?? "unknown"} ${status.error?.message ?? ""}`);
  }

  const result = await dune(`/execution/${executionId}/results?limit=${LIMIT}`);
  const rows = result.result?.rows ?? [];
  const seen = new Set();
  const entries = [];
  const now = new Date().toISOString();
  for (const row of rows) {
    const address = normalizeAddress(row.address);
    if (!address || seen.has(address)) continue;
    seen.add(address);
    entries.push({
      address,
      category: mapCategory(row),
      label: String(row.name ?? "known counterparty").slice(0, 120),
      family: String(row.name ?? "").split(":")[0].trim().slice(0, 80) || undefined,
      source: `dune:${row.category ?? "labels.addresses"}`,
      updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : now,
    });
  }

  entries.sort((a, b) => a.category.localeCompare(b.category) || a.label.localeCompare(b.label) || a.address.localeCompare(b.address));
  await writeFile(OUTPUT, `${JSON.stringify(entries, null, 2)}\n`);
  console.log(`Wrote ${entries.length} known counterparties to ${OUTPUT}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
