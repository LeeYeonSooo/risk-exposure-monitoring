"use client";

import { memo, useState } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";

import { formatUsd } from "@/lib/api";
import type { FlowNode, RiskLevel } from "@/lib/flow-types";

/**
 * Circle nodes sized by tvl, with real logos (DeFiLlama icon CDN) and a label
 * rendered OUTSIDE the measured box (absolute) so the floating edge geometry stays
 * a clean circle. Risk overlay reuses the .node-* classes in globals.css.
 */

const CHAIN_ID: Record<string, number> = {
  ethereum: 1, arbitrum: 42161, base: 8453, optimism: 10, polygon: 137, avalanche: 43114,
  bsc: 56, gnosis: 100, linea: 59144, scroll: 534352, mantle: 5000, unichain: 130, berachain: 80094,
};

export interface FlowNodeData extends FlowNode {
  radius: number;
  dim?: boolean;
  [key: string]: unknown;
}

const riskClass = (r?: RiskLevel) => (r === "danger" ? "node-danger" : r === "caution" ? "node-caution" : "node-healthy");

function initials(label: string): string {
  const clean = label.replace(/^(protocol:|token:)/, "");
  return clean.slice(0, 4);
}

/** curator can be a name (Morpho metadata) or a raw address (Euler subgraph) — shorten addresses */
export function curatorLabel(c: unknown): string {
  const s = String(c);
  return /^0x[0-9a-fA-F]{40}$/.test(s) ? `${s.slice(0, 6)}…${s.slice(-4)}` : s;
}

function Logo({ src, label, size }: { src: string | null; label: string; size: number }) {
  const [err, setErr] = useState(false);
  if (!src || err) {
    return (
      <span className="flex size-full items-center justify-center font-semibold text-[var(--color-text-secondary)]"
        style={{ fontSize: Math.max(8, size * 0.28) }}>
        {initials(label)}
      </span>
    );
  }
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt={label} onError={() => setErr(true)} className="size-full rounded-full object-cover" />;
}

function tokenLogo(address?: string, chain?: string): string | null {
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) return null;
  const id = CHAIN_ID[chain ?? "ethereum"] ?? 1;
  return `https://token-icons.llamao.fi/icons/tokens/${id}/${address}?h=48&w=48`;
}
function protocolLogo(slug?: string): string | null {
  if (!slug) return null;
  return `https://icons.llamao.fi/icons/protocols/${slug}?w=48&h=48`;
}

const FILL: Record<string, string> = { market: "#38bdf8", vault: "#a855f7", external: "#94a3b8", bridge: "#f59e0b" };

function NodeShell({ data, selected }: NodeProps) {
  const d = data as FlowNodeData;
  const size = d.radius * 2;
  // 선택하면 일시적으로 색 복귀 — 엣지(FloatingFlowEdge)의 dim 동작과 대칭
  const dimmed = !!d.dim && !selected;
  // 흐름 귀속 어댑터가 없는 노드(예: pendle·balancer·sushiswap·L2 euler 볼트) — 회색이어도
  // "조용해서"가 아니라 "측정 미지원". 점선 외곽선 + 라벨로 "거래 없음 회색"과 구분한다.
  const noAdapter = d.meta?.flowSupported === false;
  const isToken = d.kind === "token";
  const isProto = d.kind === "protocol";
  const isExt = d.kind === "external"; // (type completeness — flow-core does not create these today)
  const isBridge = d.kind === "bridge";
  const isDisc = d.kind === "market" || d.kind === "vault" || isExt;
  const logo = isToken ? tokenLogo(d.address, d.chain) : isProto ? protocolLogo(d.protocol) : null;
  const fill = d.risk === "danger" ? "#ef4444" : d.risk === "caution" ? "#f59e0b" : FILL[d.kind] ?? "#cbd5e1";

  // 브릿지 노드 — 토큰 사이의 🌉. 메커니즘(CCIP/LZ/락박스 등)이 라벨, 미검증=주의색 테두리.
  if (isBridge) {
    const bc = d.risk === "caution" ? "#f59e0b" : "#0d9488";
    return (
      <div className="relative flex items-center justify-center"
        style={{ width: size, height: size, opacity: dimmed ? 0.35 : 1, filter: dimmed ? "grayscale(1)" : undefined, transition: "opacity .25s, filter .25s" }}
        title={`${d.label}${d.meta?.fromChain ? ` · ${String(d.meta.fromChain)}↔${String(d.meta.toChain)}` : ""}`}>
        <Handle type="target" position={Position.Top} style={{ opacity: 0, width: 1, height: 1, border: 0, minWidth: 0, minHeight: 0 }} isConnectable={false} />
        <Handle type="source" position={Position.Top} style={{ opacity: 0, width: 1, height: 1, border: 0, minWidth: 0, minHeight: 0 }} isConnectable={false} />
        <div className="flex items-center justify-center rounded-full bg-[var(--color-surface)]"
          style={{ width: size, height: size, border: `2px ${d.risk === "caution" ? "dashed" : "solid"} ${bc}`, boxShadow: selected ? "0 0 0 3px var(--color-accent)" : undefined, fontSize: Math.max(9, size * 0.42) }}>
          🌉
        </div>
        <div className="pointer-events-none absolute left-1/2 top-full mt-1 -translate-x-1/2 whitespace-nowrap text-center" style={{ width: 150 }}>
          <div className="text-[9px] font-bold" style={{ color: bc }}>{d.label}</div>
          {d.meta?.fromChain != null && <div className="text-[8px] text-[var(--color-text-muted)]">{String(d.meta.fromChain)} ↔ {String(d.meta.toChain)}</div>}
        </div>
      </div>
    );
  }

  const showLabel = isToken || (isProto && d.radius > 13) || (d.kind === "market" && d.radius > 13) || (d.kind === "vault" && d.radius > 12) || (isExt && d.radius > 11) || selected;

  return (
    <div
      className="relative flex items-center justify-center"
      // dim = "색을 뺀다": 회색조 + 반투명 — TX 없는 노드는 가라앉고, 흐름이 있는 노드만 색이 남는다
      style={{ width: size, height: size, opacity: dimmed ? 0.35 : 1, filter: dimmed ? "grayscale(1)" : undefined, transition: "opacity .25s, filter .25s" }}
      title={`${d.label}${d.tvlUsd ? " · " + formatUsd(d.tvlUsd) : ""}${d.protocol && d.kind !== "protocol" ? " · " + d.protocol : ""}${noAdapter ? " · 흐름 측정 미지원(어댑터 없음)" : ""}`}
    >
      <Handle type="target" position={Position.Top} style={{ opacity: 0, width: 1, height: 1, border: 0, minWidth: 0, minHeight: 0 }} isConnectable={false} />
      <Handle type="source" position={Position.Top} style={{ opacity: 0, width: 1, height: 1, border: 0, minWidth: 0, minHeight: 0 }} isConnectable={false} />
      <div
        className={"flex items-center justify-center overflow-hidden rounded-full " + (isDisc ? "" : "bg-[var(--color-surface)] ") + riskClass(d.risk)}
        style={{
          width: size, height: size, padding: isToken || isProto ? Math.max(2, size * 0.1) : 0,
          boxShadow: selected ? "0 0 0 3px var(--color-accent)" : undefined,
          background: isDisc ? fill : undefined,
          border: d.kind === "vault" ? "1.5px solid #7e22ce" : d.kind === "market" ? "1.5px solid #0284c7" : d.kind === "bridge" ? "1.5px solid #d97706" : isExt ? "1.5px dashed #64748b" : undefined,
          // 어댑터 없는 노드 = 점선 외곽선 (회색조여도 "측정 미지원"임을 표시 — dim grayscale 와 무관)
          outline: noAdapter ? "2px dashed #94a3b8" : undefined,
          outlineOffset: noAdapter ? 2 : undefined,
        }}
      >
        {isDisc ? <span /> : <Logo src={logo} label={d.label} size={size} />}
      </div>
      {showLabel && (
        <div className="pointer-events-none absolute left-1/2 top-full mt-1 -translate-x-1/2 whitespace-nowrap text-center" style={{ width: 170 }}>
          <div className={"font-semibold text-[var(--color-text-primary)] " + (isToken ? "text-[12px]" : "text-[10px]")}>
            {d.kind === "vault" ? "🏛 " : d.kind === "bridge" ? "🌉 " : ""}{d.label}
          </div>
          {d.kind === "vault" && d.meta?.curator ? (
            <div className="text-[8px] text-[var(--color-text-muted)]">큐레이터 {curatorLabel(d.meta.curator)}</div>
          ) : null}
          {d.tvlUsd > 0 && <div className="font-mono text-[9px] text-[var(--color-text-muted)]">{formatUsd(d.tvlUsd)}</div>}
          {noAdapter && (selected || d.radius > 14) && <div className="text-[8px] italic text-[var(--color-text-muted)]">흐름 측정 미지원</div>}
        </div>
      )}
    </div>
  );
}

export const FlowNodeShell = memo(NodeShell);
