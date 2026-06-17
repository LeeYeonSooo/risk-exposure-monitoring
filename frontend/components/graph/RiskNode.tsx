"use client";

import { useState, type ReactNode } from "react";
import { Handle, type Node, type NodeProps, Position } from "@xyflow/react";
import {
  Boxes,
  Cable,
  Coins,
  Landmark,
  Layers3,
  Radio,
  type LucideIcon,
} from "lucide-react";

import type { GraphNode, NodeTickState, NodeType } from "@/lib/api";
import { formatUsd } from "@/lib/api";
import { protoDiameterPx, tokenDiameterPx } from "@/lib/node-size";
import { nodeProvenance } from "@/lib/provenance";
import { cn } from "@/lib/utils";
import { ProtocolMark } from "./ProtocolMark";
import { brandFromSlug, brandFromSymbol, brandFromVenue } from "./protocols";

export interface RiskNodeData extends Record<string, unknown> {
  node: GraphNode;
  state: NodeTickState;
  walletHighlight: boolean;
  faded?: boolean; // 포커스/하이라이트 시 비관련 노드를 흐리게
  expanded?: boolean; // (미사용, 호환 유지) 선택 노드 1-hop
}

export type RiskNodeType = Node<RiskNodeData, "risk">;

const TYPE_META: Record<
  Exclude<NodeType, "IslandHandle">,
  { icon: LucideIcon; accent: string; label: string }
> = {
  Token: { icon: Coins, accent: "#818cf8", label: "Token" },
  TokenProtocol: { icon: Layers3, accent: "#34d399", label: "Issuer" },
  DefiProtocol: { icon: Boxes, accent: "#60a5fa", label: "DeFi Protocol" },
  DerivativeToken: { icon: Layers3, accent: "#c026d3", label: "Derivative" },
  Oracle: { icon: Radio, accent: "#fbbf24", label: "Oracle" },
  Bridge: { icon: Cable, accent: "#c084fc", label: "Bridge" },
};

// 파생토큰 역할 → 원 안에 보여줄 짧은 코드 + 한글 설명 (UI 는 순수 한글 원칙 — 코드만 영문 표기)
const DERIV_ROLE_META: Record<string, { code: string; desc: string }> = {
  pt: { code: "PT", desc: "원금 토큰" },
  yt: { code: "YT", desc: "수익 토큰" },
  lp: { code: "LP", desc: "유동성 풀 토큰" },
  receipt: { code: "RC", desc: "예치 영수증" },
  wrapper: { code: "볼트", desc: "볼트 쉐어" }, // MetaMorpho 류 ERC-4626 큐레이터 볼트 쉐어
};

// 예치 영수증(receipt)은 발행 프로토콜마다 다른 토큰 — 배지를 프로토콜별로. "aT"(aToken)는 Aave 전용이라
//   Convex 영수증(cvxLP)에 붙으면 오해를 준다(사용자 2026-06-15). venue=프로토콜 슬러그로 구분.
function receiptBadge(venue: string): { code: string; desc: string } {
  const v = venue.toLowerCase();
  if (v.includes("aave") || v.includes("spark")) return { code: "aT", desc: "aToken · Aave 예치 영수증" };
  if (v.includes("convex")) return { code: "cvx", desc: "Convex 예치 영수증(cvxLP)" };
  return { code: "RC", desc: "예치 영수증" };
}

const RISK_CLASS = {
  safe: "node-healthy",
  caution: "node-caution",
  danger: "node-danger",
} as const;

function shareLabel(value: unknown): string | null {
  const n = typeof value === "number" ? value : null;
  if (n == null || !Number.isFinite(n) || n <= 0) return null;
  const p = n * 100;
  if (p >= 10) return `${p.toFixed(1)}%`;
  if (p >= 0.01) return `${p.toFixed(2)}%`;
  return "<0.01%";
}

function withShare(base: string | null, share: string | null): string {
  if (base && share) return `${base} · ${share}`;
  return base ?? share ?? "";
}

// 체인별 색 — 동심원 원 헤더(IslandHandle) 색깔 구분용 (없으면 indigo 폴백)
const CHAIN_COLOR: Record<string, string> = {
  ethereum: "#818cf8", base: "#3b82f6", arbitrum: "#2dd4bf", optimism: "#f87171", polygon: "#a78bfa",
  gnosis: "#34d399", linea: "#fbbf24", scroll: "#fb923c", avalanche: "#ef4444", bsc: "#f0b90b",
  berachain: "#d97706", hyperliquid: "#22d3ee", sonic: "#facc15", mantle: "#10b981",
  zksync: "#6366f1", blast: "#fde047", mode: "#84cc16", sei: "#e11d48", plasma: "#14b8a6", megaeth: "#f472b6",
  monad: "#8b5cf6", unichain: "#fb7185",
};

// 체인명 → chainId (DeFiLlama token-icon CDN 토큰 로고용; EVM 만, 모르면 생략→폴백)
const CHAIN_ID: Record<string, number> = {
  ethereum: 1, optimism: 10, flare: 14, cronos: 25, bsc: 56, gnosis: 100, "polygon-zkevm": 1101, metis: 1088,
  manta: 169, unichain: 130, polygon: 137, sonic: 146, sei: 1329, soneium: 1868, swell: 1923, fraxtal: 252,
  zksync: 324, "wc": 480, mantle: 5000, hyperliquid: 999, mode: 34443, arbitrum: 42161, celo: 42220,
  avalanche: 43114, hemi: 43111, ink: 57073, bob: 60808, linea: 59144, berachain: 80094, blast: 81457,
  base: 8453, plume: 98866, taiko: 167000, katana: 747474, kava: 2222, scroll: 534352, lisk: 1135,
};

// 체인 대표 로고 (DeFiLlama 체인 아이콘 CDN) — 실패 시 체인색 점으로 폴백. fill=원 가득 채움(체인 노드).
function ChainLogo({ chain, color, fill }: { chain: string; color: string; fill?: boolean }) {
  const [err, setErr] = useState(false);
  if (err) return <span className={fill ? "size-2/3 rounded-full" : "size-3 rounded-full"} style={{ backgroundColor: color }} />;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`https://icons.llamao.fi/icons/chains/rsz_${chain}?w=160&h=160`}
      alt={chain}
      className={fill ? "size-full object-cover" : "size-4 rounded-full"}
      onError={() => setErr(true)}
    />
  );
}

// 토큰 대표 로고 (DeFiLlama token-icon CDN, chainId/주소) — 실패 시 기본 아이콘.
function TokenLogo({ chainId, addr, px, fallback }: { chainId: number; addr: string; px: number; fallback: ReactNode }) {
  const [err, setErr] = useState(false);
  if (err) return <>{fallback}</>;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`https://token-icons.llamao.fi/icons/tokens/${chainId}/${addr.toLowerCase()}?h=160&w=160`}
      alt=""
      width={px}
      height={px}
      className="size-full object-cover"
      onError={() => setErr(true)}
    />
  );
}

function RiskNodeComponent({ data, selected }: NodeProps<RiskNodeType>) {
  const { node, state, walletHighlight, faded } = data;

  // 섬(체인 원) 이동 핸들 — 이 노드를 끌면 GraphCanvas 가 그 체인 원 전체를 옮김.
  // 노드처럼 큰 흰 원 + 체인 이름. (크기 ISLAND_HANDLE_PX = bipartite-layout 의 중앙 오프셋과 일치)
  if (node.type === "IslandHandle") {
    const chain = ((node.metadata.chain as string) ?? node.label).toLowerCase();
    const color = CHAIN_COLOR[chain] ?? "#818cf8";
    const sub = node.metadata.category as string | undefined;
    return (
      <div
        className="flex cursor-move flex-col items-center gap-1"
        title={`${node.label} 체인 원 전체 이동 (드래그)`}
      >
        <div
          className="flex items-center gap-2 rounded-full border-2 px-4 py-1.5 backdrop-blur-sm transition-transform hover:scale-105"
          style={{ borderColor: color, backgroundColor: `${color}26`, boxShadow: `0 0 20px ${color}55` }}
        >
          <ChainLogo chain={chain} color={color} />
          <span className="text-[16px] font-bold uppercase tracking-wider" style={{ color }}>
            {node.label}
          </span>
        </div>
        {sub && (
          <span className="whitespace-nowrap rounded border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-text-secondary)] shadow-sm">
            {sub}
            {shareLabel(node.metadata.distributionPct) ? ` · ${shareLabel(node.metadata.distributionPct)}` : ""}
          </span>
        )}
      </div>
    );
  }

  const isToken = node.type === "Token";
  const meta = TYPE_META[node.type];
  const Icon = meta.icon;
  const inactive = !node.active;
  // 출처 opaque(검증불가) — 정체불명 노드면 "?" 배지 (IslandHandle/체인노드는 위에서 분기 처리)
  const opaqueNode = nodeProvenance(node) === "opaque";
  // log2 스케일용 규모 (인접 엣지 amountUsd 합; 프로토콜은 page.tsx 에서 교정됨)
  const sizeUsd = (node.metadata.sizeUsd ?? node.metadata.tokensHeldUsd) as
    | number
    | null
    | undefined;
  const distribution = shareLabel(node.metadata.distributionPct);

  // 마켓/볼트 합성 노드는 로고 없음(카테고리 라벨로 구분). 진짜 프로토콜은 slug→DeFiLlama 로고.
  const isMktVault = !!(node.metadata._market || node.metadata._vault);
  const brand =
    brandFromVenue(node.metadata.venue) ??
    (isToken
      ? brandFromSymbol(node.metadata.symbol ?? node.label)
      : isMktVault
        ? null
        : brandFromSlug(node.metadata.brandSlug as string | undefined, node.label));

  const handles = (
    <>
      <Handle type="target" position={Position.Top} className="!size-1.5 !border-0 !bg-transparent" />
      <Handle type="source" position={Position.Bottom} className="!size-1.5 !border-0 !bg-transparent" />
    </>
  );

  const dimmed = faded && !walletHighlight && !selected;

  // ───────────────────────── 토큰: 원형 노드 ─────────────────────────
  // 박스 = 원(d×d). 라벨/금액은 absolute 라 박스 크기에 영향 없음 → 엣지가 원에 붙음.
  // 로고는 원 안에 1번만(중복 X), 심볼·금액은 원 아래.
  if (isToken) {
    // 동심원 토큰은 명시적 지름(링 반경 비례) 우선 → 원 클수록 토큰도 커져 가독성↑
    const d = Math.round((node.metadata.diameterPx as number | undefined) ?? tokenDiameterPx(sizeUsd));
    const labelPx = Math.max(15, Math.min(26, Math.round(d * 0.09)));
    const tokenAddr = node.metadata.tokenAddr as string | undefined;
    const chainId = CHAIN_ID[(node.metadata.chain as string)?.toLowerCase() ?? ""];
    const iconEl = <Icon size={Math.round(d * 0.42)} style={{ color: meta.accent }} />;
    return (
      <div className="relative" style={{ width: d, height: d }}>
        {handles}
        {/* 원: 단일 테두리 + overflow-hidden 으로 로고를 원형으로 클립(이중 테두리/마진 X) */}
        <div
          className={cn(
            "size-full overflow-hidden rounded-full border-2 bg-[var(--color-surface)]",
            "flex items-center justify-center",
            "transition-[box-shadow,border-color,transform] duration-300",
            RISK_CLASS[state.riskLevel],
            inactive && "opacity-45 grayscale",
            selected &&
              "ring-2 ring-[var(--color-accent)] ring-offset-2 ring-offset-[var(--color-background)] scale-110",
            walletHighlight && !selected && "ring-1 ring-[var(--color-accent)]/60",
            dimmed && "opacity-25",
          )}
          style={{ transformOrigin: "center center" }}
        >
          {brand ? (
            <ProtocolMark brand={brand} boxClass="size-full" fontPx={Math.max(11, d * 0.36)} fill circle />
          ) : tokenAddr && chainId ? (
            <TokenLogo chainId={chainId} addr={tokenAddr} px={d} fallback={iconEl} />
          ) : (
            iconEl
          )}
        </div>
        {/* wallet 강조 점 — overflow-hidden 바깥(부모)에 둬서 안 잘리게 */}
        {walletHighlight && (
          <div
            className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full bg-[var(--color-accent)]"
            style={{ boxShadow: "0 0 6px var(--color-accent)" }}
          />
        )}
        {opaqueNode && <OpaqueBadge />}
        <div
          className={cn(
            "pointer-events-none absolute left-1/2 top-full mt-1 -translate-x-1/2 text-center",
            dimmed && "opacity-25",
          )}
        >
          <div className="whitespace-nowrap font-bold leading-tight text-[var(--color-text-primary)]" style={{ fontSize: labelPx }}>{node.label}</div>
          {typeof sizeUsd === "number" && sizeUsd > 0 && (
            <div className="mt-0.5 whitespace-nowrap font-mono font-bold leading-tight text-[var(--color-text-primary)]" style={{ fontSize: Math.max(12, Math.round(labelPx * 0.9)) }}>
              {withShare(formatUsd(sizeUsd), distribution)}
            </div>
          )}
        </div>
      </div>
    );
  }

  // ───────────── 파생토큰 (머니레고) — 작은 사각라운드 칩: 역할 코드 + 라벨 아래 ─────────────
  if (node.type === "DerivativeToken") {
    const role = (node.metadata.derivRole as string) ?? "";
    // 브릿지 래핑본(USDC.e 등)은 같은 wrapper 역할이지만 볼트 쉐어가 아님 — venue=bridge 면 별도 표기.
    const rm = (role === "wrapper" && node.metadata.venue === "bridge")
      ? { code: "랩", desc: "브릿지 래핑본" }
      : role === "receipt"
        ? receiptBadge(String(node.metadata.venue ?? ""))
        : DERIV_ROLE_META[role] ?? { code: "·", desc: "파생" };
    const accent = TYPE_META.DerivativeToken.accent;
    const usd = typeof sizeUsd === "number" && sizeUsd > 0 ? formatUsd(sizeUsd) : null;
    const isTerminal = node.metadata.terminal === true;
    return (
      <div className="relative" style={{ width: 40, height: 40 }}>
        {handles}
        <div
          className={cn(
            "flex size-full items-center justify-center rounded-xl border-2 bg-[var(--color-surface)]",
            "transition-[box-shadow,border-color,transform] duration-300",
            inactive && "opacity-45 grayscale",
            selected && "ring-2 ring-[var(--color-accent)] ring-offset-2 ring-offset-[var(--color-background)] scale-110",
            dimmed && "opacity-25",
          )}
          style={{ borderColor: accent, boxShadow: `0 0 10px ${accent}33` }}
          title={`${node.label} — ${rm.desc}${isTerminal ? " · 종착" : ""}`}
        >
          <span className="text-[13px] font-extrabold" style={{ color: accent }}>{rm.code}</span>
        </div>
        {isTerminal && <TerminalBadge dim={terminalIsDim(node, state.riskLevel)} />}
        <div className={cn("pointer-events-none absolute left-1/2 top-full mt-1 -translate-x-1/2 text-center", dimmed && "opacity-25")}>
          <div className="whitespace-nowrap text-[11px] font-semibold leading-tight text-[var(--color-text-primary)]">{node.label}</div>
          <div className="whitespace-nowrap text-[9px] leading-tight text-[var(--color-text-muted)]">
            {rm.desc}{usd ? ` · ${usd}` : ""}
          </div>
        </div>
      </div>
    );
  }

  // ───────────── 체인 노드 (매크로/트리) — 체인 로고 원 + 이름·TVL 아래. 색은 리스크만, 체인은 로고로. ─────────────
  if (node.metadata._chainNode) {
    const chain = ((node.metadata.chain as string) ?? node.label).toLowerCase();
    const fallbackColor = CHAIN_COLOR[chain] ?? "#818cf8";
    const d = Math.round((node.metadata.diameterPx as number | undefined) ?? 64);
    const labelPx = Math.max(11, Math.round(d * 0.16));
    return (
      <div className="relative" style={{ width: d, height: d }}>
        {handles}
        <div
          className={cn(
            "size-full overflow-hidden rounded-full border-2 bg-[var(--color-surface)] flex items-center justify-center",
            "transition-[box-shadow,border-color,transform] duration-300 cursor-pointer",
            RISK_CLASS[state.riskLevel],
            inactive && "opacity-45 grayscale",
            selected && "ring-2 ring-[var(--color-accent)] ring-offset-2 ring-offset-[var(--color-background)] scale-110",
            dimmed && "opacity-25",
          )}
          title={`${node.label} — 클릭하면 이 체인 동심원`}
        >
          <ChainLogo chain={chain} color={fallbackColor} fill />
        </div>
        <div className={cn("pointer-events-none absolute left-1/2 top-full mt-1 -translate-x-1/2 text-center", dimmed && "opacity-25")}>
          <div className="whitespace-nowrap font-semibold capitalize leading-tight" style={{ fontSize: labelPx }}>{node.label}</div>
          {typeof sizeUsd === "number" && sizeUsd > 0 && (
            <div className="whitespace-nowrap font-mono leading-tight text-[var(--color-text-muted)]" style={{ fontSize: Math.max(9, Math.round(labelPx * 0.82)) }}>{withShare(formatUsd(sizeUsd), distribution)}</div>
          )}
        </div>
      </div>
    );
  }

  // ── 프로토콜·마켓·볼트·브릿지: 로고/아이콘 원(이름은 원 밖 아래로) — 토큰 노드와 통일. 더 크게. ──
  const isBridge = node.type === "Bridge";
  const bMech = node.metadata.bridgeMechanism as string | undefined;
  const bTag = (node.metadata.bridgeTag as string | undefined) ?? "bridge";
  const bProtocol = (node.metadata.bridgeProtocol as string | undefined) ?? bTag;
  const bWeak = !!node.metadata.bridgeWeak;
  const bMechColor = bMech === "burn_mint" ? "#f87171" : bMech === "liquidity" ? "#2dd4bf" : "#60a5fa";
  const bMechKo = bMech === "burn_mint" ? "번 & 민트" : bMech === "liquidity" ? "유동성 풀" : "락 & 민트";

  // 크기: 프로토콜=토큰 분포 share(레이아웃이 diameterPx 주입; 없으면 노출 규모 폴백), 마켓/볼트=작게(48), 브릿지=중간(60).
  // C14/C15: 연결성 중요도 배수 — 허브(많은 파생/토큰이 거쳐가는 노드)일수록 크게 (멘토 §6 "규모가 아니라 연결성").
  const connBoost = (node.metadata.connImportance as number | undefined) ?? 1;
  const d = Math.round((isBridge ? 60 : isMktVault ? 54 : ((node.metadata.diameterPx as number | undefined) ?? protoDiameterPx(sizeUsd))) * connBoost);
  // 폰트는 노드 크기에 비례하되 상한(큰 노드에서 라벨이 옆 노드를 덮지 않게).
  const labelPx = isMktVault ? 11 : Math.max(13, Math.min(18, Math.round(d * 0.12)));
  // 큐레이터 볼트(_vault)는 마켓 풀(_market)과 모양이 같아 구분이 안 됨 → 노란색 + Landmark 아이콘으로 구별.
  const isVault = !!node.metadata._vault;
  const VIcon = isVault ? Landmark : Icon;
  const iconEl = <VIcon size={Math.round(d * 0.5)} style={{ color: isVault ? "#ca8a04" : isBridge ? bMechColor : meta.accent }} />;

  // 마켓/볼트 라벨 변별 — 동일 loan-token 라벨('PYUSD' $41M vs $1 더스트)이 hover 없이도 구분되게
  //   금액·LLTV·큐레이터를 보조 라인으로 붙이고, 라벨 파싱 실패('a','WEWON' 류 한두 글자)는 venue 로 방어.
  const sizeUnknown = node.metadata.sizeUnknown === true;
  const mkt = (node.metadata._market as Record<string, unknown> | undefined) ?? undefined;
  const rawLabel = String(node.label ?? "");
  const labelOk = rawLabel.length >= 2 && !/^[a-z]$/i.test(rawLabel);
  const fallbackName = String(mkt?.loan ?? node.metadata.venue ?? "마켓");
  // 라벨(원 아래): 라인1 = 이름/회사, 라인2 = 메커니즘/규모/카테고리.
  const primary = isBridge
    ? `${node.metadata.bridgeVerified ? "✓ " : ""}${bProtocol}${bWeak ? " ⚠️" : ""}`
    : (labelOk ? rawLabel : fallbackName);
  const stat = state.tvl != null ? formatUsd(state.tvl) : typeof sizeUsd === "number" && sizeUsd > 0 ? formatUsd(sizeUsd) : null;
  const secondary = isBridge
    ? bMechKo
    : (withShare(stat, distribution) || (node.metadata.category as string | undefined) || "");
  const tertiary = !isBridge && node.metadata.category ? String(node.metadata.category) : "";
  const primaryColor = isBridge ? bMechColor : undefined;
  // 마켓 노드 보조 라인(이름만 보이던 마켓에 변별 컨텍스트). 볼트는 supply, 마켓은 금액/미상 + LLTV.
  const mktSizeText = typeof sizeUsd === "number" && sizeUsd > 0 ? formatUsd(sizeUsd) : sizeUnknown ? "금액 미상" : null;
  const lltvNum = typeof mkt?.lltv === "number" ? (mkt.lltv as number) : null;
  const mktLine = !isVault && isMktVault
    ? [mktSizeText, lltvNum != null ? `LLTV ${(lltvNum * 100).toFixed(0)}%` : null].filter(Boolean).join(" · ")
    : "";
  const vaultSupply = isVault ? (node.metadata._vault as { supplyUsd?: number | null } | undefined)?.supplyUsd : null;
  const vaultLine = isVault && typeof vaultSupply === "number" && vaultSupply > 0 ? formatUsd(vaultSupply) : "";

  return (
    <div className="group relative" style={{ width: d, height: d }}>
      {handles}
      {/* 원: 로고/아이콘만 (이름은 아래). 토큰 노드와 동일 패턴 */}
      <div
        className={cn(
          "size-full overflow-hidden rounded-full border-2 bg-[var(--color-surface)]",
          "flex items-center justify-center",
          "transition-[box-shadow,border-color,transform] duration-300",
          RISK_CLASS[state.riskLevel],
          inactive && "opacity-45 grayscale",
          selected && "ring-2 ring-[var(--color-accent)] ring-offset-2 ring-offset-[var(--color-background)] scale-110",
          walletHighlight && !selected && "ring-1 ring-[var(--color-accent)]/60",
          dimmed && "opacity-25",
        )}
        style={{ transformOrigin: "center center", ...(isVault ? { borderColor: "#eab308", backgroundColor: "#fefce8" } : isBridge ? { borderColor: `${bMechColor}88` } : {}) }}
      >
        {brand ? <ProtocolMark brand={brand} boxClass="size-full" fontPx={Math.max(11, d * 0.36)} fill circle /> : iconEl}
      </div>
      {walletHighlight && (
        <div className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full bg-[var(--color-accent)]" style={{ boxShadow: "0 0 6px var(--color-accent)" }} />
      )}
      {opaqueNode && <OpaqueBadge />}
      {node.metadata.terminal === true && <TerminalBadge dim={terminalIsDim(node, state.riskLevel)} />}
      {/* 이름 등 라벨 — 원 밖 아래(absolute → 원 크기·엣지 부착에 영향 X) */}
      <div className={cn("pointer-events-none absolute left-1/2 top-full mt-1.5 -translate-x-1/2 text-center", dimmed && "opacity-25")}>
        {/* 이름 — 전체 표시(자르지 않음) */}
        <div className="whitespace-nowrap font-bold leading-tight" style={{ fontSize: labelPx, color: primaryColor ?? "var(--color-text-primary)" }}>{primary}</div>
        {/* 마켓/풀은 이름만(텍스트 최소화). 프로토콜만 TVL·비율 + 카테고리 표시. */}
        {!isMktVault && secondary && (
          <div className="mt-0.5 whitespace-nowrap font-mono font-bold leading-tight" style={{ fontSize: Math.max(11, Math.round(labelPx * 0.92)), color: primaryColor ?? "var(--color-text-primary)" }}>{secondary}</div>
        )}
        {!isMktVault && tertiary && (
          <div className="whitespace-nowrap leading-tight text-[var(--color-text-muted)]" style={{ fontSize: Math.max(9, Math.round(labelPx * 0.7)) }}>{tertiary}</div>
        )}
        {/* 마켓 보조 라인 — 동일 라벨 변별(금액/미상·LLTV). 금액 미상은 muted 로 "추측 아님"을 명시. */}
        {mktLine && (
          <div className={cn("whitespace-nowrap font-mono leading-tight", sizeUnknown && mktSizeText === "금액 미상" ? "text-[var(--color-text-muted)] italic" : "text-[var(--color-text-secondary)]")} style={{ fontSize: 9 }}>{mktLine}</div>
        )}
        {vaultLine && (
          <div className="whitespace-nowrap font-mono leading-tight text-[#a16207]" style={{ fontSize: 9 }}>{vaultLine}</div>
        )}
      </div>
      {/* 브릿지 메커니즘/한도 상세는 GraphCanvas 의 통합 HoverTooltip 으로 일원화(중복 툴팁 제거). */}
    </div>
  );
}

// 종착 배지 — 다음 예치 홉이 없는 "설계상 끝"(담보 잠김·이자 수취·보상 영수증). 노드 우하단 "끝".
//   '미완(단절)'과 구분돼야 하므로 데이터로 확정된 종착(meta.terminal)에만 붙는다(감사관 [추궁]).
//   dim=true: 더스트·금액미상 종착(신호 약함) — 거의 모든 leaf 마켓이 종착이라 배지가 변별력을 잃는 문제(회장 작업6)를
//     해소하려 시각 비중을 낮춘다(반투명·테두리만). 큰 금액/위험색 종착은 solid 로 또렷이 남겨 트리아지가 된다.
function TerminalBadge({ dim = false }: { dim?: boolean }) {
  return (
    <div
      className={cn(
        "absolute -bottom-0.5 -right-0.5 z-10 flex size-3 items-center justify-center rounded-full text-[7px] font-bold leading-none ring-1 ring-[var(--color-surface)]",
        dim
          ? "bg-transparent text-[var(--color-text-muted)] opacity-50 ring-[var(--color-text-muted)]"
          : "bg-[var(--color-accent)] text-white",
      )}
      title={dim
        ? "종착(더스트·금액 미상) — 끝이지만 규모가 작거나 미상이라 약하게 표기."
        : "종착 — 여기가 끝(다음 예치 홉 없음). 클릭하면 재원·회수 경로 설명."}
    >
      끝
    </div>
  );
}

// 종착 배지 신호 강도 — 더스트($1만 미만)·금액미상이고 위험색도 없으면 dim(약한 종착). 결정론적 순수 판정.
//   큰 금액·위험색·이자/보상/볼트/스테이킹 종착(담보종착 외 정보성 종착)은 또렷이 둔다.
function terminalIsDim(node: GraphNode, riskLevel: string): boolean {
  if (riskLevel !== "safe") return false; // 위험색 종착은 항상 또렷이
  const kind = node.metadata.terminalKind as string | undefined;
  // 담보종착만 노이즈 주범 — 나머지(yield/reward/vault_share/staking/lp_held)는 정보성이라 dim 안 함.
  if (kind !== "collateral_sink") return false;
  const size = (node.metadata.sizeUsd ?? node.metadata.tokensHeldUsd) as number | null | undefined;
  const unknown = node.metadata.sizeUnknown === true || size == null;
  const dust = typeof size === "number" && size > 0 && size < 10_000; // $1만 미만 = 더스트
  return unknown || dust;
}

// 검증불가(opaque) 배지 — 정체불명 컨트랙트/이름없는 큐레이터. 노드 좌상단 "?".
function OpaqueBadge() {
  return (
    <div
      className="absolute -left-0.5 -top-0.5 z-10 flex size-3 items-center justify-center rounded-full bg-[var(--color-surface)] text-[8px] font-bold leading-none text-[var(--color-text-muted)] ring-1 ring-[var(--color-text-muted)]"
      title="검증불가(opaque) — 정체불명 컨트랙트/이름없는 큐레이터. DD 불가."
    >
      ?
    </div>
  );
}

export const RiskNode = RiskNodeComponent;
