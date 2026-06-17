"use client";

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { X } from "lucide-react";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  useEdgesState,
  useInternalNode,
  useNodesState,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { ADDR_EXPLORER, PRow, TX_EXPLORER, shortAddr } from "@/components/panel/spec";
import type { EoaFlowDetail, EoaFlowEdge, EoaFlowNode, EoaFlowTransfer } from "@/lib/eoa-flow-types";

const CATEGORY_COLOR: Record<string, string> = {
  lending: "#0ea5e9",
  yield_basis: "#059669",
  vault: "#8b5cf6",
  pendle: "#ea580c",
  swap: "#d97706",
  bridge: "#0d9488",
  fx_long: "#dc2626",
  token_call: "#64748b",
  token_receive: "#16a34a",
  token_send: "#e11d48",
  wallet_flow: "#475569",
};

const CATEGORY_LABEL: Record<string, string> = {
  lending: "lending",
  yield_basis: "yield basis",
  vault: "vault",
  pendle: "pendle",
  swap: "swap",
  bridge: "bridge",
  fx_long: "fx long",
  token_call: "token call",
  token_receive: "token receive",
  token_send: "token send",
  wallet_flow: "wallet",
};

type EoaNodeData = {
  raw: EoaFlowNode;
  dim?: boolean;
};

type DetailContext = {
  detail: EoaFlowDetail;
  edge: EoaFlowEdge;
  source?: EoaFlowNode;
  target?: EoaFlowNode;
};

type TokenBucket = {
  token: string;
  symbol: string;
  in: number;
  out: number;
  net: number;
  count: number;
  unknownCount: number;
};

type CounterpartyBucket = {
  counterparty: EoaFlowNode;
  tokens: TokenBucket[];
  txCount: number;
};

type BridgeBucket = {
  protocol: string;
  action: string;
  txCount: number;
  tokens: TokenBucket[];
  hasAmount: boolean;
  sampleTx?: string;
};

type ProtocolFlowBucket = {
  protocol: EoaFlowNode;
  category?: string;
  tokens: TokenBucket[];
  txCount: number;
  actions: string[];
  sampleTx?: string;
};

type InflowBucket = {
  detail: EoaFlowDetail;
  source?: EoaFlowNode;
  tokens: EoaFlowTransfer[];
};

type TokenChipMode = "position" | "activity" | "sent" | "bridge" | "holding";

const nodeTypes = { eoaFlow: EoaFlowNodeShell };
const edgeTypes = { centerLine: CenterLineEdge };

function categoryColor(category?: string): string {
  return CATEGORY_COLOR[category ?? ""] ?? "#64748b";
}

function isWalletNode(node: EoaFlowNode): boolean {
  return node.type === "eoa" || node.data.kind === "eoa" || node.data.kind === "safe";
}

function nodeRank(node: EoaFlowNode): number {
  if (isWalletNode(node)) return 0;
  if (node.type === "protocol" || node.data.kind === "protocol") return 1;
  if (node.type === "asset" || node.data.kind === "asset") return 2;
  return 3;
}

function nodeSort(a: EoaFlowNode, b: EoaFlowNode): number {
  const rd = nodeRank(a) - nodeRank(b);
  if (rd !== 0) return rd;
  const ad = a.data.dfs_depth ?? 0;
  const bd = b.data.dfs_depth ?? 0;
  if (ad !== bd) return ad - bd;
  const al = a.data.lane ?? 0;
  const bl = b.data.lane ?? 0;
  if (al !== bl) return al - bl;
  return (b.data.event_count ?? 0) - (a.data.event_count ?? 0) || a.label.localeCompare(b.label);
}

const CENTER = { x: 820, y: 520 };
const WALLET_W = 232;
const WALLET_H = 64;
const PROTOCOL_W = 244;
const PROTOCOL_H = 58;

function isSeedWallet(node: EoaFlowNode): boolean {
  return isWalletNode(node) && (node.data.discovered_by === "seed" || (node.data.dfs_depth ?? 0) === 0);
}

function layoutVisibleNodes(nodes: EoaFlowNode[]): Map<string, { x: number; y: number }> {
  const pos = new Map<string, { x: number; y: number }>();
  const seed = nodes.find(isSeedWallet);
  const protocols = nodes
    .filter((node) => !isWalletNode(node) && (node.type === "protocol" || node.data.kind === "protocol"))
    .sort((a, b) => (a.data.category ?? "").localeCompare(b.data.category ?? "") || nodeSort(a, b));
  const assetsAndOthers = nodes
    .filter((node) => !isWalletNode(node) && !protocols.includes(node))
    .sort(nodeSort);

  if (seed) pos.set(seed.id, { x: CENTER.x - WALLET_W / 2, y: CENTER.y - WALLET_H / 2 });

  const protocolRadius = Math.max(480, protocols.length * 44);
  protocols.forEach((node, index) => {
    const angle = -Math.PI / 2 + (Math.PI * 2 * index) / Math.max(1, protocols.length);
    pos.set(node.id, {
      x: CENTER.x + Math.cos(angle) * protocolRadius - PROTOCOL_W / 2,
      y: CENTER.y + Math.sin(angle) * protocolRadius - PROTOCOL_H / 2,
    });
  });

  const assetRadius = protocolRadius + 300;
  assetsAndOthers.forEach((node, index) => {
    const angle = -Math.PI / 2 + (Math.PI * 2 * (index + 0.5)) / Math.max(1, assetsAndOthers.length);
    pos.set(node.id, {
      x: CENTER.x + Math.cos(angle) * assetRadius - PROTOCOL_W / 2,
      y: CENTER.y + Math.sin(angle) * assetRadius - PROTOCOL_H / 2,
    });
  });

  return pos;
}

function edgeColor(edge: EoaFlowEdge): string {
  if (edge.edge_type === "wallet_move") return "#334155";
  if (edge.edge_type === "wallet_transfer") return "#7c3aed";
  if (edge.edge_type === "asset_in") return "#16a34a";
  if (edge.edge_type === "asset_out") return "#e11d48";
  return categoryColor(edge.category);
}

type RectCenter = { x: number; y: number; halfW: number; halfH: number };

function rectCenterOf(node: ReturnType<typeof useInternalNode>): RectCenter | null {
  if (!node) return null;
  const raw = (node.data as EoaNodeData | undefined)?.raw;
  const fallbackW = raw && isWalletNode(raw) ? WALLET_W : PROTOCOL_W;
  const fallbackH = raw && isWalletNode(raw) ? WALLET_H : PROTOCOL_H;
  const width = node.measured?.width ?? node.width ?? fallbackW;
  const height = node.measured?.height ?? node.height ?? fallbackH;
  return {
    x: node.internals.positionAbsolute.x + width / 2,
    y: node.internals.positionAbsolute.y + height / 2,
    halfW: width / 2,
    halfH: height / 2,
  };
}

function rectBoundaryPoint(from: RectCenter, to: RectCenter, pad: number): { x: number; y: number } {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const tx = Math.abs(ux) > 1e-6 ? from.halfW / Math.abs(ux) : Number.POSITIVE_INFINITY;
  const ty = Math.abs(uy) > 1e-6 ? from.halfH / Math.abs(uy) : Number.POSITIVE_INFINITY;
  const dist = Math.max(0, Math.min(tx, ty) + pad);
  return { x: from.x + ux * dist, y: from.y + uy * dist };
}

function CenterLineEdge({ id, source, target, data, style, selected, animated }: EdgeProps) {
  const sourceRect = rectCenterOf(useInternalNode(source));
  const targetRect = rectCenterOf(useInternalNode(target));
  if (!sourceRect || !targetRect) return null;

  const edge = data as EoaFlowEdge | undefined;
  const color = (style?.stroke as string | undefined) ?? (edge ? edgeColor(edge) : "#64748b");
  const strokeWidth = Number(style?.strokeWidth ?? 2);
  const opacity = Number(style?.opacity ?? 0.9);
  const dash = style?.strokeDasharray as string | undefined;
  const start = rectBoundaryPoint(sourceRect, targetRect, 2);
  const end = rectBoundaryPoint(targetRect, sourceRect, 3);
  const path = `M ${start.x} ${start.y} L ${end.x} ${end.y}`;

  return (
    <g className="eoa-flow-edge">
      <path d={path} fill="none" stroke="transparent" strokeWidth={18} style={{ cursor: "pointer" }} />
      <path
        id={`eoa-edge-${id}`}
        d={path}
        fill="none"
        stroke={color}
        strokeWidth={selected ? strokeWidth + 0.7 : strokeWidth}
        strokeOpacity={selected ? 1 : opacity}
        strokeDasharray={dash}
        strokeLinecap="round"
        style={{ pointerEvents: "none" }}
      >
        {animated && <animate attributeName="stroke-dashoffset" from="0" to="-18" dur="1s" repeatCount="indefinite" />}
      </path>
    </g>
  );
}

function formatAmount(value: number | undefined): string {
  if (value == null || !Number.isFinite(value)) return "";
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(2)}K`;
  if (abs >= 1) return value.toFixed(4).replace(/\.?0+$/, "");
  return value.toPrecision(4).replace(/\.?0+$/, "");
}

function formatSignedAmount(value: number): string {
  const abs = Math.abs(value);
  const body = formatAmount(abs);
  return `${value > 0 ? "+" : "-"}${body}`;
}

function tokenAmountLabel(bucket: Pick<TokenBucket, "net" | "count" | "unknownCount" | "symbol">, signed = false): string {
  if (!Number.isFinite(bucket.net) || Math.abs(bucket.net) <= 1e-12) {
    return bucket.unknownCount > 0
      ? `amount unknown · ${bucket.unknownCount} transfers ${bucket.symbol}`
      : `net 0 ${bucket.symbol}`;
  }
  return `${signed ? formatSignedAmount(bucket.net) : formatAmount(Math.abs(bucket.net))} ${bucket.symbol}`;
}

function transferSign(direction: EoaFlowTransfer["direction"]): string {
  return direction === "out" ? "-" : direction === "in" ? "+" : "~";
}

function formatDateTime(value?: string): string | null {
  if (!value) return null;
  return value.replace("T", " ").replace(/Z$/, "").slice(0, 16);
}

function labelForKind(node: EoaFlowNode): string {
  if (node.data.kind === "safe") return "Safe";
  if (isWalletNode(node)) return "EOA";
  if (node.type === "asset" || node.data.kind === "asset") return "Asset";
  return CATEGORY_LABEL[node.data.category ?? ""] ?? "Protocol";
}

function detailKey(detail: EoaFlowDetail): string {
  return detail.event_id ?? `${detail.address ?? ""}:${detail.tx_hash ?? ""}:${detail.block_number ?? ""}:${detail.category ?? ""}:${detail.action ?? ""}`;
}

function addTokenBucket(map: Map<string, TokenBucket>, transfer: EoaFlowTransfer, direction: "in" | "out" | "net" = transfer.direction === "out" ? "out" : "in") {
  const key = `${transfer.token || "unknown"}:${transfer.symbol || "TOKEN"}`;
  const cur = map.get(key) ?? { token: transfer.token, symbol: transfer.symbol || "TOKEN", in: 0, out: 0, net: 0, count: 0, unknownCount: 0 };
  const amount = Number(transfer.amount);
  const hasAmount = Number.isFinite(amount) && amount > 0;
  if (hasAmount) {
    if (direction === "out") cur.out += amount;
    else if (direction === "in") cur.in += amount;
    else cur.net += amount;
    if (direction !== "net") cur.net = cur.in - cur.out;
  } else {
    cur.unknownCount += transfer.count || 1;
  }
  cur.count += transfer.count || 1;
  map.set(key, cur);
}

function sortedTokenBuckets(map: Map<string, TokenBucket>): TokenBucket[] {
  return [...map.values()].sort((a, b) => Math.abs(b.net) - Math.abs(a.net) || b.unknownCount - a.unknownCount || a.symbol.localeCompare(b.symbol));
}

function isDebtSymbol(symbol: string): boolean {
  return /debt/i.test(symbol);
}

function isReceiptSymbol(symbol: string): boolean {
  return /^(a|sp|stk|yv|pt-|yt-|morpho|9s)/i.test(symbol);
}

function isPositionLikeProtocol(row: ProtocolFlowBucket): boolean {
  const category = (row.category ?? row.protocol.data.category ?? "").toLowerCase();
  const label = row.protocol.label.toLowerCase();
  const actions = row.actions.join(" ").toLowerCase();

  if (category === "swap" || /swap|paraswap|1inch|odos|uniswap|curve|balancer/.test(label) || /swap|exchange/.test(actions)) return false;
  if (/claim|reward|transfer|bridge/.test(actions)) return false;
  if (category === "yield_basis") return /deposit|stake|mint|withdraw|redeem/.test(actions);
  if (["lending", "vault", "pendle", "fx_long"].includes(category)) return true;
  return row.tokens.some((token) => isDebtSymbol(token.symbol) || /^(a|sp|stk|yv|pt-|yt-|morpho|9s)/i.test(token.symbol));
}

function nodeAddress(node?: EoaFlowNode): string | null {
  return (node?.data.address ?? node?.data.target ?? null)?.toLowerCase() ?? null;
}

function contextsForAddress(address: string, edges: EoaFlowEdge[], nodesById: Map<string, EoaFlowNode>): DetailContext[] {
  const addr = address.toLowerCase();
  const seen = new Map<string, DetailContext>();
  for (const edge of edges) {
    const source = nodesById.get(edge.source);
    const target = nodesById.get(edge.target);
    for (const detail of edge.details ?? []) {
      if ((detail.address ?? "").toLowerCase() !== addr) continue;
      const key = detailKey(detail);
      if (!seen.has(key)) seen.set(key, { detail, edge, source, target });
    }
  }
  return [...seen.values()].sort((a, b) => (a.detail.block_number ?? 0) - (b.detail.block_number ?? 0) || detailKey(a.detail).localeCompare(detailKey(b.detail)));
}

function nodeFlowSummary(node: EoaFlowNode, edges: EoaFlowEdge[], nodesById: Map<string, EoaFlowNode>) {
  const address = node.data.address ?? node.data.target;
  if (!address) return null;
  const contexts = contextsForAddress(address, edges, nodesById);

  const positionMap = new Map<string, TokenBucket>();
  for (const { detail } of contexts) {
    for (const transfer of detail.transfers ?? []) {
      if (transfer.direction === "internal") continue;
      addTokenBucket(positionMap, transfer);
    }
  }
  const positions = sortedTokenBuckets(positionMap).filter((bucket) => Math.abs(bucket.net) > 1e-10);
  const holdings = positions.filter((bucket) => bucket.net > 1e-10 && !isDebtSymbol(bucket.symbol));

  const protocolMap = new Map<string, { protocol: EoaFlowNode; category?: string; tokenMap: Map<string, TokenBucket>; txs: Set<string>; actions: Set<string>; sampleTx?: string }>();
  for (const { detail, edge, source, target } of contexts) {
    if (edge.edge_type !== "protocol_flow") continue;
    const protocol = source && isWalletNode(source) ? target : source;
    if (!protocol || isWalletNode(protocol)) continue;
    const row = protocolMap.get(protocol.id) ?? {
      protocol,
      category: edge.category ?? protocol.data.category,
      tokenMap: new Map<string, TokenBucket>(),
      txs: new Set<string>(),
      actions: new Set<string>(),
      sampleTx: detail.tx_hash,
    };
    if (detail.tx_hash) row.txs.add(detail.tx_hash);
    if (detail.action) row.actions.add(detail.action);
    for (const transfer of detail.transfers ?? []) {
      if (transfer.direction === "internal") continue;
      addTokenBucket(row.tokenMap, transfer);
    }
    protocolMap.set(protocol.id, row);
  }
  const protocolRows: ProtocolFlowBucket[] = [...protocolMap.values()]
    .map((row) => ({
      protocol: row.protocol,
      category: row.category,
      tokens: sortedTokenBuckets(row.tokenMap).filter((bucket) => Math.abs(bucket.net) > 1e-10 || bucket.unknownCount > 0),
      txCount: row.txs.size,
      actions: [...row.actions],
      sampleTx: row.sampleTx,
    }))
    .filter((row) => row.tokens.length > 0)
    .sort((a, b) => Math.max(...b.tokens.map((token) => Math.abs(token.net)), 0) - Math.max(...a.tokens.map((token) => Math.abs(token.net)), 0));
  const protocolPositions = protocolRows.filter(isPositionLikeProtocol);
  const protocolActivity = protocolRows.filter((row) => !isPositionLikeProtocol(row));

  const sentByCounterparty = new Map<string, { counterparty: EoaFlowNode; tokenMap: Map<string, TokenBucket>; txs: Set<string> }>();
  for (const edge of edges) {
    if (edge.edge_type !== "wallet_move" || edge.source !== node.id) continue;
    const counterparty = nodesById.get(edge.target);
    if (!counterparty || !isWalletNode(counterparty)) continue;
    for (const detail of edge.details ?? []) {
      if ((detail.address ?? "").toLowerCase() !== address.toLowerCase()) continue;
      const outgoing = (detail.transfers ?? []).filter((transfer) => transfer.direction === "out");
      if (!outgoing.length) continue;
      const row = sentByCounterparty.get(edge.target) ?? { counterparty, tokenMap: new Map<string, TokenBucket>(), txs: new Set<string>() };
      if (detail.tx_hash) row.txs.add(detail.tx_hash);
      for (const transfer of outgoing) addTokenBucket(row.tokenMap, transfer);
      sentByCounterparty.set(edge.target, row);
    }
  }
  const sentToWallets: CounterpartyBucket[] = [...sentByCounterparty.values()].map((row) => ({
    counterparty: row.counterparty,
    tokens: sortedTokenBuckets(row.tokenMap).map((bucket) => ({ ...bucket, net: bucket.out || bucket.net })),
    txCount: row.txs.size,
  })).filter((row) => row.tokens.some((token) => token.net > 1e-12 || token.unknownCount > 0)).sort((a, b) => {
    const av = Math.max(...a.tokens.map((token) => token.net), 0);
    const bv = Math.max(...b.tokens.map((token) => token.net), 0);
    return bv - av || b.txCount - a.txCount;
  });

  const bridges = new Map<string, { protocol: string; action: string; txs: Set<string>; tokenMap: Map<string, TokenBucket>; sampleTx?: string }>();
  for (const edge of edges) {
    if (edge.category !== "bridge") continue;
    if (edge.source !== node.id && edge.target !== node.id) continue;
    for (const detail of edge.details ?? []) {
      if ((detail.address ?? "").toLowerCase() !== address.toLowerCase()) continue;
      const key = `${detail.protocol || edge.label || edge.target}:${detail.action || "bridge"}`;
      const row = bridges.get(key) ?? { protocol: detail.protocol || nodesById.get(edge.target)?.label || "bridge", action: detail.action || "bridge", txs: new Set<string>(), tokenMap: new Map<string, TokenBucket>(), sampleTx: detail.tx_hash };
      if (detail.tx_hash) row.txs.add(detail.tx_hash);
      for (const transfer of detail.transfers ?? []) {
        if (transfer.direction === "out") addTokenBucket(row.tokenMap, transfer);
      }
      bridges.set(key, row);
    }
  }
  const bridgeRows: BridgeBucket[] = [...bridges.values()].map((row) => {
    const tokens = sortedTokenBuckets(row.tokenMap).map((bucket) => ({ ...bucket, net: bucket.out || bucket.net }));
    if (!tokens.length && /ETH/i.test(row.action)) {
      tokens.push({ token: "native:eth", symbol: "ETH", in: 0, out: 0, net: 0, count: 1, unknownCount: 1 });
    }
    return { protocol: row.protocol, action: row.action, txCount: row.txs.size, tokens, hasAmount: tokens.some((token) => Math.abs(token.net) > 1e-12), sampleTx: row.sampleTx };
  });

  const inflows: InflowBucket[] = contexts
    .filter(({ detail }) =>
      detail.category === "token_mint" ||
      /mint/i.test(detail.action ?? "") ||
      (detail.transfers ?? []).some((transfer) => transfer.direction === "in"),
    )
    .map(({ detail, source, target }) => ({
      detail,
      source: nodeAddress(source) === address.toLowerCase() ? target : source,
      tokens: detail.transfers?.filter((transfer) => transfer.direction === "in") ?? [],
    }));

  const firstInflow = contexts.find(({ detail }) =>
    detail.category === "token_mint" ||
    /mint/i.test(detail.action ?? "") ||
    (detail.transfers ?? []).some((transfer) => transfer.direction === "in"),
  ) ?? null;

  return { protocolPositions, protocolActivity, positions, holdings, sentToWallets, bridges: bridgeRows, inflows, firstInflow };
}

function EoaFlowNodeShell({ data, selected }: NodeProps) {
  const { raw, dim } = data as EoaNodeData;
  const wallet = isWalletNode(raw);
  const safe = raw.data.kind === "safe";
  const color = wallet ? (safe ? "#0d9488" : "#4f46e5") : categoryColor(raw.data.category);
  const address = raw.data.address ?? raw.data.target;
  const counts = raw.data.event_count;
  const depth = raw.data.dfs_depth;
  const css: CSSProperties = {
    width: wallet ? 232 : 244,
    minHeight: wallet ? 64 : 58,
    borderColor: selected ? "var(--color-accent)" : color,
    boxShadow: selected ? "0 0 0 3px rgba(79, 70, 229, 0.18), 0 12px 26px rgba(15, 23, 42, 0.12)" : "0 8px 18px rgba(15, 23, 42, 0.06)",
    opacity: dim && !selected ? 0.16 : 1,
    filter: dim && !selected ? "grayscale(0.9)" : undefined,
  };

  return (
    <div
      className="relative rounded-lg border-2 bg-[var(--color-surface)] px-3 py-2 text-left transition-all"
      style={css}
      title={address ?? raw.label}
    >
      <Handle type="target" position={Position.Left} className="!h-2 !w-2 !border-0 !bg-transparent" isConnectable={false} />
      <Handle type="source" position={Position.Right} className="!h-2 !w-2 !border-0 !bg-transparent" isConnectable={false} />
      <div className="flex items-center gap-2">
        <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />
        <span className="min-w-0 truncate text-[12px] font-bold text-[var(--color-text-primary)]">{raw.label}</span>
      </div>
      <div className="mt-1 flex items-center gap-2 text-[10px] text-[var(--color-text-muted)]">
        <span className="font-mono uppercase">{labelForKind(raw)}</span>
        {depth != null && <span className="font-mono">d{depth}</span>}
        {counts != null && <span className="ml-auto font-mono">{counts} events</span>}
      </div>
      {address && <div className="mt-1 truncate font-mono text-[10px] text-[var(--color-text-secondary)]">{shortAddr(address)}</div>}
    </div>
  );
}

function SelectionPanel({
  selectedNode,
  selectedEdge,
  nodesById,
  edges,
  onClose,
}: {
  selectedNode: EoaFlowNode | null;
  selectedEdge: EoaFlowEdge | null;
  nodesById: Map<string, EoaFlowNode>;
  edges: EoaFlowEdge[];
  onClose: () => void;
}) {
  const edgeSource = selectedEdge ? nodesById.get(selectedEdge.source) : null;
  const edgeTarget = selectedEdge ? nodesById.get(selectedEdge.target) : null;

  return (
    <div className="px-5 py-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {selectedNode ? (
            <>
              <div className="truncate text-[15px] font-bold text-[var(--color-text-primary)]">{selectedNode.label}</div>
              <div className="text-[11px] text-[var(--color-text-muted)]">{labelForKind(selectedNode)} · {selectedNode.data.kind}</div>
            </>
          ) : selectedEdge ? (
            <>
              <div className="text-[13px] font-bold text-[var(--color-text-primary)]">
                {edgeSource?.label ?? selectedEdge.source} <span className="text-[var(--color-text-muted)]">-&gt;</span> {edgeTarget?.label ?? selectedEdge.target}
              </div>
              <div className="text-[11px] text-[var(--color-text-muted)]">{selectedEdge.edge_type}{selectedEdge.category ? ` · ${selectedEdge.category}` : ""}</div>
            </>
          ) : null}
        </div>
        <button onClick={onClose} className="rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-raised)]" aria-label="close detail">
          <X size={15} />
        </button>
      </div>

      {selectedNode && <NodeDetails node={selectedNode} edges={edges} nodesById={nodesById} />}
      {selectedEdge && <EdgeDetails edge={selectedEdge} />}
    </div>
  );
}

function NodeDetails({ node, edges, nodesById }: { node: EoaFlowNode; edges: EoaFlowEdge[]; nodesById: Map<string, EoaFlowNode> }) {
  const address = node.data.address ?? node.data.target;
  const counts = node.data.category_counts ?? {};
  const summary = isWalletNode(node) ? nodeFlowSummary(node, edges, nodesById) : null;
  return (
    <div className="mt-3 space-y-0.5">
      <PRow k="주소" v={address ? shortAddr(address) : null} href={address ? ADDR_EXPLORER.ethereum(address) : null} badge={address ? "verified" : undefined} />
      <PRow k="이벤트" v={node.data.event_count != null ? node.data.event_count.toLocaleString() : null} />
      <PRow k="DFS depth" v={node.data.dfs_depth != null ? String(node.data.dfs_depth) : null} />
      <PRow k="발견" v={node.data.discovered_by ?? null} />
      <PRow k="첫 이벤트" v={formatDateTime(node.data.first_seen_utc)} />
      <PRow k="마지막" v={formatDateTime(node.data.last_seen_utc)} />
      {Object.keys(counts).length > 0 && (
        <div className="mt-3">
          <div className="mb-1.5 text-[11px] font-semibold text-[var(--color-text-muted)]">카테고리</div>
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([category, count]) => (
              <span key={category} className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg)] px-2 py-1 font-mono text-[10px] text-[var(--color-text-secondary)]">
                {category} {count}
              </span>
            ))}
          </div>
        </div>
      )}
      {summary && <WalletFlowSummary summary={summary} />}
    </div>
  );
}

function SectionTitle({ children, note }: { children: React.ReactNode; note?: string }) {
  return (
    <div className="mt-4 flex items-center justify-between gap-3">
      <div className="text-[12px] font-semibold text-[var(--color-text-primary)]">{children}</div>
      {note && <div className="font-mono text-[10px] text-[var(--color-text-muted)]">{note}</div>}
    </div>
  );
}

function SectionHelp({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-1 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2.5 py-1.5 text-[10px] leading-4 text-[var(--color-text-muted)]">
      {children}
    </div>
  );
}

function TokenList({ rows, signed = false, limit = 8 }: { rows: TokenBucket[]; signed?: boolean; limit?: number }) {
  if (!rows.length) return <div className="mt-2 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg)] px-3 py-2 text-[11px] text-[var(--color-text-muted)]">계산된 토큰 없음</div>;
  return (
    <div className="mt-2 space-y-1">
      {rows.slice(0, limit).map((bucket) => (
        <a
          key={`${bucket.token}:${bucket.symbol}:${bucket.net}`}
          href={bucket.token ? ADDR_EXPLORER.ethereum(bucket.token) : undefined}
          target="_blank"
          rel="noreferrer"
          title={bucket.token}
          className="flex items-center justify-between gap-2 rounded border border-[var(--color-border-subtle)] bg-[var(--color-bg)] px-2.5 py-1.5 font-mono text-[10px] hover:border-[var(--color-accent)]"
        >
          <span className={bucket.net < -1e-10 ? "text-[var(--color-danger)]" : bucket.net > 1e-10 ? "text-[var(--color-healthy)]" : "text-[var(--color-text-muted)]"}>
            {tokenAmountLabel(bucket, signed)}
          </span>
          <span className="text-[var(--color-text-muted)]">in {formatAmount(bucket.in)} / out {formatAmount(bucket.out)}</span>
        </a>
      ))}
    </div>
  );
}

function tokenChipLabel(token: TokenBucket, signed = false, out = false): string {
  if (Math.abs(token.net) > 1e-12) {
    const base = tokenAmountLabel(token, signed);
    return out && !base.startsWith("-") ? `-${base}` : base;
  }
  return tokenAmountLabel(token, signed);
}

function tokenChipPrefix(token: TokenBucket, mode: TokenChipMode, row?: ProtocolFlowBucket): string | null {
  if (isDebtSymbol(token.symbol)) return "debt";
  if (mode === "sent") return "sent";
  if (mode === "bridge") return "bridge";
  if (mode === "activity") {
    const category = (row?.category ?? row?.protocol.data.category ?? "").toLowerCase();
    if (category === "swap") return token.net < 0 ? "paid" : "got";
    return token.net < 0 ? "out" : "in";
  }
  if (mode === "position") {
    if (isReceiptSymbol(token.symbol)) return token.net < 0 ? "receipt out" : "receipt";
    return token.net < 0 ? "asset out" : "asset in";
  }
  return null;
}

function tokenChipTitle(token: TokenBucket, mode: TokenChipMode, row?: ProtocolFlowBucket): string {
  if (isDebtSymbol(token.symbol)) {
    return token.net >= 0
      ? "Debt token: positive net means borrow/debt minted exceeds repay/burn. This is liability, not received spendable asset."
      : "Debt token: negative net means repay/burn exceeded borrow mint. This is debt reduction, not a swap input.";
  }
  if (mode === "activity" && (row?.category ?? row?.protocol.data.category) === "swap") {
    return token.net < 0 ? "Swap input paid by this address." : "Swap output received by this address.";
  }
  if (mode === "position" && isReceiptSymbol(token.symbol)) {
    return token.net < 0 ? "Position receipt token decreased, usually withdrawal/redeem." : "Position receipt token increased, usually deposit/supply claim.";
  }
  if (mode === "position") {
    return token.net < 0 ? "Underlying asset moved out for deposit/repay/payment." : "Underlying asset moved in from borrow/withdraw/claim.";
  }
  if (mode === "sent") return "Token sent from this address to another EOA/Safe.";
  if (mode === "bridge") return "Token sent through a bridge route.";
  return token.token || token.symbol;
}

function tokenChipTone(token: TokenBucket, mode: TokenChipMode, out: boolean): "danger" | "healthy" | "muted" {
  if (Math.abs(token.net) <= 1e-12) return "muted";
  if (isDebtSymbol(token.symbol)) return token.net > 0 ? "danger" : "healthy";
  if (out || mode === "sent" || mode === "bridge") return "danger";
  return token.net < 0 ? "danger" : "healthy";
}

function TokenChip({
  token,
  signed = false,
  out = false,
  mode = "holding",
  row,
}: {
  token: TokenBucket;
  signed?: boolean;
  out?: boolean;
  mode?: TokenChipMode;
  row?: ProtocolFlowBucket;
}) {
  const hasAmount = Math.abs(token.net) > 1e-12;
  const prefix = tokenChipPrefix(token, mode, row);
  const tone = tokenChipTone(token, mode, out);
  return (
    <span
      title={tokenChipTitle(token, mode, row)}
      className={
        "rounded border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-1.5 py-0.5 font-mono text-[10px] " +
        (hasAmount ? (tone === "danger" ? "text-[var(--color-danger)]" : tone === "healthy" ? "text-[var(--color-healthy)]" : "text-[var(--color-text-muted)]") : "text-[var(--color-text-muted)]")
      }
    >
      {prefix && <><span className="text-[var(--color-text-muted)]">{prefix}</span>{" "}</>}
      {tokenChipLabel(token, signed, out)}
    </span>
  );
}

function ProtocolRows({ rows, emptyLabel, limit = 12, mode }: { rows: ProtocolFlowBucket[]; emptyLabel: string; limit?: number; mode: "position" | "activity" }) {
  if (!rows.length) return <div className="mt-2 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg)] px-3 py-2 text-[11px] text-[var(--color-text-muted)]">{emptyLabel}</div>;
  return (
    <div className="mt-2 space-y-2">
      {rows.slice(0, limit).map((row) => {
        const addr = row.protocol.data.address ?? row.protocol.data.target;
        return (
          <div key={row.protocol.id} className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg)] p-2.5">
            <div className="flex items-center justify-between gap-2">
              <a href={addr ? ADDR_EXPLORER.ethereum(addr) : undefined} target="_blank" rel="noreferrer" className="truncate text-[11px] font-semibold text-[var(--color-text-primary)] hover:text-[var(--color-accent)]">
                {row.protocol.label}
              </a>
              {row.category && <span className="font-mono text-[10px] text-[var(--color-text-muted)]">{row.category}</span>}
            </div>
            {row.actions.length > 0 && (
              <div className="mt-0.5 truncate font-mono text-[10px] text-[var(--color-text-muted)]">{row.actions.slice(0, 2).join(" / ")}{row.actions.length > 2 ? ` +${row.actions.length - 2}` : ""}</div>
            )}
            <div className="mt-1 flex flex-wrap gap-1">
              {row.tokens.slice(0, 7).map((token) => <TokenChip key={`${row.protocol.id}:${token.token}:${token.symbol}`} token={token} signed mode={mode} row={row} />)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function WalletFlowSummary({
  summary,
}: {
  summary: NonNullable<ReturnType<typeof nodeFlowSummary>>;
}) {
  return (
    <>
      <SectionTitle note="position-like net">프로토콜별 현재 포지션 추정</SectionTitle>
      <SectionHelp>
        debt 토큰은 부채입니다. <span className="font-mono">debt +</span>는 남은/늘어난 차입, <span className="font-mono">debt -</span>는 상환으로 줄어든 차입입니다. receipt는 aToken/spToken/vault share 같은 예치증 토큰입니다.
      </SectionHelp>
      <ProtocolRows rows={summary.protocolPositions} emptyLabel="프로토콜 포지션 없음" mode="position" />

      <SectionTitle note="swap/claim net">프로토콜별 활동 흐름</SectionTitle>
      <SectionHelp>
        swap에서 <span className="font-mono">paid -</span>는 투입한 토큰, <span className="font-mono">got +</span>는 받은 토큰입니다. 이 섹션은 과거 활동 누적이고 현재 포지션 잔액이 아닙니다.
      </SectionHelp>
      <ProtocolRows rows={summary.protocolActivity} emptyLabel="스왑/클레임 흐름 없음" limit={8} mode="activity" />

      <SectionTitle note="positive net · debt 제외">토큰별 현재 보유 추정</SectionTitle>
      <TokenList rows={summary.holdings} limit={8} />

      <SectionTitle note={`${summary.sentToWallets.length} wallets`}>다른 EOA/Safe로 보낸 토큰</SectionTitle>
      {summary.sentToWallets.length ? (
        <div className="mt-2 space-y-2">
          {summary.sentToWallets.slice(0, 6).map((row) => {
            const addr = row.counterparty.data.address ?? row.counterparty.data.target;
            return (
              <div key={row.counterparty.id} className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg)] p-2.5">
                <a href={addr ? ADDR_EXPLORER.ethereum(addr) : undefined} target="_blank" rel="noreferrer" className="block truncate text-[11px] font-semibold text-[var(--color-text-primary)] hover:text-[var(--color-accent)]">
                  {row.counterparty.label}
                </a>
                <div className="mt-1 flex flex-wrap gap-1">
                  {row.tokens.slice(0, 5).map((token) => (
                    <TokenChip key={`${row.counterparty.id}:${token.token}:${token.symbol}`} token={token} out mode="sent" />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      ) : <div className="mt-2 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg)] px-3 py-2 text-[11px] text-[var(--color-text-muted)]">선택 주소 기준 송신 집계 없음</div>}

      <SectionTitle note={`${summary.bridges.length} routes`}>브릿지로 보낸 양</SectionTitle>
      {summary.bridges.length ? (
        <div className="mt-2 space-y-2">
          {summary.bridges.map((bridge) => (
            <div key={`${bridge.protocol}:${bridge.action}:${bridge.sampleTx}`} className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg)] p-2.5">
              <div className="flex items-center justify-between gap-2">
                <div className="truncate text-[11px] font-semibold text-[var(--color-text-primary)]">{bridge.protocol}</div>
                <span className="font-mono text-[10px] text-[var(--color-text-muted)]">{bridge.txCount} tx</span>
              </div>
              <div className="mt-0.5 truncate font-mono text-[10px] text-[var(--color-text-muted)]">{bridge.action}</div>
              <div className="mt-1 flex flex-wrap gap-1">
                {bridge.tokens.slice(0, 5).map((token) => <TokenChip key={`${bridge.protocol}:${token.token}:${token.symbol}`} token={token} out mode="bridge" />)}
                {!bridge.tokens.length && <span className="rounded border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-text-muted)]">token unavailable</span>}
                {bridge.sampleTx && (
                  <a href={TX_EXPLORER.ethereum(bridge.sampleTx)} target="_blank" rel="noreferrer" className="rounded border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-accent)]">
                    tx {shortAddr(bridge.sampleTx)}
                  </a>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : <div className="mt-2 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg)] px-3 py-2 text-[11px] text-[var(--color-text-muted)]">브릿지 이벤트 없음</div>}

      <SectionTitle note={`${summary.inflows.length} events`}>mint/receive 전체</SectionTitle>
      {summary.inflows.length ? (
        <div className="mt-2 space-y-2">
          {summary.inflows.slice(0, 24).map((row, index) => (
            <div key={`${row.detail.event_id ?? row.detail.tx_hash}:${index}`} className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg)] p-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-[11px] font-semibold text-[var(--color-text-primary)]">{row.detail.category === "token_mint" ? "mint" : "receive"} · {row.source?.label ?? row.detail.protocol ?? "unknown"}</span>
                <span className="font-mono text-[10px] text-[var(--color-text-muted)]">{row.detail.datetime_utc?.slice(0, 10) ?? "unknown"}</span>
              </div>
              <div className="mt-1 flex flex-wrap gap-1">
                {(row.tokens.length ? row.tokens : row.detail.transfers ?? []).slice(0, 5).map((transfer) => (
                  <span key={`${transfer.token}:${transfer.symbol}:${transfer.amount}:${row.detail.event_id}`} className="rounded border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-healthy)]">
                    +{Number(transfer.amount) > 0 ? formatAmount(transfer.amount) : "amount unknown"} {transfer.symbol}
                  </span>
                ))}
                {row.detail.tx_hash && (
                  <a href={TX_EXPLORER.ethereum(row.detail.tx_hash)} target="_blank" rel="noreferrer" className="rounded border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-accent)]">
                    tx {shortAddr(row.detail.tx_hash)}
                  </a>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : <div className="mt-2 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg)] px-3 py-2 text-[11px] text-[var(--color-text-muted)]">mint/receive 이벤트 없음</div>}
    </>
  );
}

function EdgeDetails({ edge }: { edge: EoaFlowEdge }) {
  const details = edge.details ?? [];
  return (
    <div className="mt-3">
      <div className="space-y-0.5">
        <PRow k="관계" v={edge.edge_type} />
        <PRow k="카테고리" v={edge.category ?? null} />
        <PRow k="이벤트" v={(edge.event_count ?? details.length).toLocaleString()} />
        <PRow k="샘플 tx" v={edge.tx_hash ? shortAddr(edge.tx_hash) : null} href={edge.tx_hash ? TX_EXPLORER.ethereum(edge.tx_hash) : null} badge={edge.tx_hash ? "verified" : undefined} />
      </div>

      <div className="mt-4 flex items-center justify-between">
        <div className="text-[12px] font-semibold text-[var(--color-text-primary)]">이동 리스트</div>
        <div className="font-mono text-[10px] text-[var(--color-text-muted)]">{details.length} rows</div>
      </div>

      {details.length === 0 ? (
        <div className="mt-2 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg)] px-3 py-2 text-[12px] text-[var(--color-text-muted)]">
          이 엣지는 요약만 있고 세부 tx 리스트는 아직 붙지 않았습니다.
        </div>
      ) : (
        <div className="mt-2 space-y-2">
          {details.map((detail, index) => (
            <DetailRow key={`${detail.event_id ?? detail.tx_hash ?? index}:${index}`} detail={detail} />
          ))}
        </div>
      )}
    </div>
  );
}

function DetailRow({ detail }: { detail: EoaFlowDetail }) {
  const transfers = detail.transfers ?? [];
  return (
    <div className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg)] p-3">
      <div className="flex items-center gap-2 text-[10px] text-[var(--color-text-muted)]">
        <span className="font-mono text-[var(--color-text-secondary)]">{detail.datetime_utc?.slice(0, 10) ?? "unknown"}</span>
        {detail.category && <span>{detail.category}</span>}
        {detail.block_number != null && <span className="ml-auto font-mono">{detail.block_number.toLocaleString()}</span>}
      </div>
      <div className="mt-1 text-[12px] font-semibold text-[var(--color-text-primary)]">
        {detail.protocol || detail.category || "transfer"}
        {detail.action ? <span className="font-normal text-[var(--color-text-muted)]"> · {detail.action}</span> : null}
      </div>
      {transfers.length > 0 && (
        <div className="mt-2 space-y-1">
          {transfers.map((transfer, index) => (
            <a
              key={`${transfer.direction}:${transfer.token}:${transfer.symbol}:${index}`}
              href={ADDR_EXPLORER.ethereum(transfer.token)}
              target="_blank"
              rel="noreferrer"
              title={transfer.token}
              className="flex items-center gap-2 rounded border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2 py-1 font-mono text-[10px] hover:border-[var(--color-accent)]"
            >
              <span className={transfer.direction === "out" ? "text-[var(--color-danger)]" : transfer.direction === "in" ? "text-[var(--color-healthy)]" : "text-[var(--color-text-muted)]"}>
                {transferSign(transfer.direction)}
              </span>
              <span className="text-[var(--color-text-primary)]">{formatAmount(transfer.amount) || `${transfer.count}x`}</span>
              <span className="min-w-0 truncate text-[var(--color-text-secondary)]">{transfer.symbol}</span>
            </a>
          ))}
        </div>
      )}
      {detail.tx_hash && (
        <a
          href={TX_EXPLORER.ethereum(detail.tx_hash)}
          target="_blank"
          rel="noreferrer"
          title={detail.tx_hash}
          className="mt-2 block truncate font-mono text-[10px] text-[var(--color-text-muted)] hover:text-[var(--color-accent)]"
        >
          {detail.tx_hash}
        </a>
      )}
    </div>
  );
}

export function EoaFlowGraph({ nodes, edges }: { nodes: EoaFlowNode[]; edges: EoaFlowEdge[] }) {
  const allEntityNodes = useMemo(() => nodes.filter((node) => node.type !== "event" && node.data.kind !== "event").sort(nodeSort), [nodes]);
  const seedWallet = useMemo(() => allEntityNodes.find(isSeedWallet) ?? allEntityNodes.find(isWalletNode) ?? null, [allEntityNodes]);
  const candidateVisibleNodeIds = useMemo(() => new Set(allEntityNodes.filter((node) => !isWalletNode(node) || node.id === seedWallet?.id).map((node) => node.id)), [allEntityNodes, seedWallet]);
  const nodesById = useMemo(() => new Map(allEntityNodes.map((node) => [node.id, node] as const)), [allEntityNodes]);
  const visibleEdges = useMemo(() => edges.filter((edge) => {
    const source = nodesById.get(edge.source);
    const target = nodesById.get(edge.target);
    if (!source || !target) return false;
    if (isWalletNode(source) && isWalletNode(target)) return false;
    if (isWalletNode(source) && source.id !== seedWallet?.id) return false;
    if (isWalletNode(target) && target.id !== seedWallet?.id) return false;
    return candidateVisibleNodeIds.has(edge.source) && candidateVisibleNodeIds.has(edge.target);
  }), [candidateVisibleNodeIds, edges, nodesById, seedWallet]);
  const visibleConnectedNodeIds = useMemo(() => {
    const ids = new Set<string>();
    for (const edge of visibleEdges) {
      ids.add(edge.source);
      ids.add(edge.target);
    }
    if (seedWallet) ids.add(seedWallet.id);
    return ids;
  }, [seedWallet, visibleEdges]);
  const visibleNodes = useMemo(() => allEntityNodes.filter((node) => candidateVisibleNodeIds.has(node.id) && visibleConnectedNodeIds.has(node.id)), [allEntityNodes, candidateVisibleNodeIds, visibleConnectedNodeIds]);
  const edgesById = useMemo(() => new Map(visibleEdges.map((edge) => [edge.id, edge] as const)), [visibleEdges]);
  const [selected, setSelected] = useState<{ type: "node" | "edge"; id: string } | null>(null);
  const selectedNode = selected?.type === "node" ? nodesById.get(selected.id) ?? null : null;
  const selectedEdge = selected?.type === "edge" ? edgesById.get(selected.id) ?? null : null;

  const focus = useMemo(() => {
    if (!selected) return null;
    const nodeIds = new Set<string>();
    const edgeIds = new Set<string>();
    if (selected.type === "edge") {
      const edge = edgesById.get(selected.id);
      if (edge) {
        edgeIds.add(edge.id);
        nodeIds.add(edge.source);
        nodeIds.add(edge.target);
      }
    } else {
      nodeIds.add(selected.id);
      for (const edge of visibleEdges) {
        if (edge.source === selected.id || edge.target === selected.id) {
          edgeIds.add(edge.id);
          nodeIds.add(edge.source);
          nodeIds.add(edge.target);
        }
      }
    }
    return { nodeIds, edgeIds };
  }, [edgesById, selected, visibleEdges]);

  const { rfNodesBase, rfEdgesBase } = useMemo(() => {
    const positions = layoutVisibleNodes(visibleNodes);
    const rfNodesBase: Node[] = visibleNodes.map((node) => {
      const pos = positions.get(node.id) ?? { x: 0, y: 0 };
      const dim = focus ? !focus.nodeIds.has(node.id) : false;
      return {
        id: node.id,
        type: "eoaFlow",
        position: pos,
        data: { raw: node, dim },
        selected: selected?.type === "node" && selected.id === node.id,
        draggable: true,
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
      } as Node;
    });

    const rfEdgesBase: Edge[] = visibleEdges.map((edge) => {
      const color = edgeColor(edge);
      const active = focus ? focus.edgeIds.has(edge.id) : true;
      const walletMove = edge.edge_type === "wallet_move" || edge.edge_type === "wallet_transfer";
      const protocolFlow = edge.edge_type === "protocol_flow";
      return {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        type: "centerLine",
        animated: active && (walletMove || protocolFlow),
        data: edge,
        selected: selected?.type === "edge" && selected.id === edge.id,
        style: {
          stroke: color,
          strokeWidth: active ? (walletMove ? 2.8 : protocolFlow ? 2.4 : 2) : 1.1,
          strokeDasharray: edge.edge_type === "wallet_transfer" || edge.edge_type === "asset_out" ? "4 4" : undefined,
          opacity: active ? 0.92 : 0.08,
        },
      } as Edge;
    });

    return { rfNodesBase, rfEdgesBase };
  }, [focus, selected, visibleEdges, visibleNodes]);

  const [rfNodes, setRfNodes, onNodesChange] = useNodesState(rfNodesBase);
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState(rfEdgesBase);
  useEffect(() => setRfNodes(rfNodesBase), [rfNodesBase, setRfNodes]);
  useEffect(() => setRfEdges(rfEdgesBase), [rfEdgesBase, setRfEdges]);

  const clearSelection = useCallback(() => setSelected(null), []);

  if (!visibleNodes.length) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-[var(--color-text-muted)]">
        EOA flow graph 없음
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
      <div className="relative h-[620px] min-h-[620px] flex-none bg-[var(--color-bg)] lg:h-auto lg:min-h-0 lg:flex-1">
        <ReactFlow
          nodes={rfNodes}
          edges={rfEdges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={(_, node) => setSelected({ type: "node", id: node.id })}
          onEdgeClick={(_, edge) => setSelected({ type: "edge", id: edge.id })}
          onPaneClick={clearSelection}
          fitView
          fitViewOptions={{ padding: 0.12, duration: 450 }}
          minZoom={0.12}
          maxZoom={1.7}
          proOptions={{ hideAttribution: true }}
          nodesConnectable={false}
          elementsSelectable
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#cbd5e1" />
          <Controls />
          <MiniMap
            pannable
            zoomable
            nodeStrokeWidth={2}
            maskColor="rgba(246, 248, 251, 0.74)"
            style={{ border: "1px solid var(--color-border-subtle)", borderRadius: 8, background: "var(--color-surface)" }}
          />
        </ReactFlow>

        <div className="pointer-events-none absolute bottom-4 left-4 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface)]/95 px-3 py-2 text-[10px] text-[var(--color-text-muted)] shadow-sm">
          <div className="flex flex-wrap gap-3">
            <Legend color="#4f46e5" label="seed EOA" />
            <Legend color="#0ea5e9" label="lending" />
            <Legend color="#059669" label="yield basis" />
            <Legend color="#d97706" label="swap" />
          </div>
        </div>
      </div>

      {(selectedNode || selectedEdge) && (
        <aside className="w-full shrink-0 overflow-y-auto border-t border-[var(--color-border-subtle)] bg-[var(--color-surface)] lg:w-[380px] lg:border-l lg:border-t-0">
          <SelectionPanel selectedNode={selectedNode} selectedEdge={selectedEdge} nodesById={nodesById} edges={edges} onClose={clearSelection} />
        </aside>
      )}
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="inline-block size-2 rounded-sm" style={{ backgroundColor: color }} />
      {label}
    </span>
  );
}
