"use client";

import { useMemo } from "react";

import { formatUsd, type GraphNode, type TopologyResponse } from "@/lib/api";

/**
 * 대시보드(리스트) 뷰 — 동심원·브릿지 허브의 데이터를 그래프가 아니라 표/리스트로 통합 정리.
 * concTopo(동심원, 마켓 on) + brdgTopo(브릿지 허브)의 노드를 체인별로 재구성해 렌더.
 */

// 정밀 스냅샷(온체인 어댑터) 대상 체인 — 나머지는 breadth 라이브.
const PRECISE = new Set(["ethereum", "base", "arbitrum"]);
function refreshNote(chain: string): string {
  return PRECISE.has(chain)
    ? "정밀 스냅샷 ~60분(20분 회전) · breadth 라이브(요청 시·30분 캐시) · 공급 1h"
    : "breadth 라이브(요청 시·30분 캐시) · 공급 1h · 정밀 스냅샷 X";
}

interface Vault { curator: string; allocationUsd: number | null }
interface Market { id: string; label: string; lltv: number | null; sizeUsd: number; ouroboros: boolean; cross?: boolean; vaults: Vault[] }
interface Protocol { id: string; name: string; sizeUsd: number; markets: Market[] }
interface ChainBlock { chain: string; supplyUsd: number; protocols: Protocol[]; marketCount: number }
interface Bridge { id: string; protocol: string; mechanism: string; tag: string; verified: boolean; mintLimit: number | null; weak: boolean; route: string; category: string }

const MECH_KO: Record<string, { label: string; color: string }> = {
  burn_mint: { label: "번&민트", color: "#f87171" },
  lock_mint: { label: "락&민트", color: "#60a5fa" },
  liquidity: { label: "유동성풀", color: "#2dd4bf" },
};

function pct(x: number | null): string { return x == null ? "—" : `${(x * 100).toFixed(0)}%`; }

export function TokenDashboard({
  sym, concTopo, brdgTopo, supplyByChain,
}: {
  sym: string;
  concTopo: TopologyResponse;
  brdgTopo: TopologyResponse;
  supplyByChain: Record<string, { supply: number; supplyUsd: number }>;
}) {
  const { chains, bridges } = useMemo(() => {
    // 동심원 노드 → 체인별 프로토콜/마켓/볼트 재구성
    const protoMap = new Map<string, Protocol>();      // pid → protocol
    const marketMap = new Map<string, Market>();        // mid → market
    for (const n of concTopo.nodes) {
      const m = n.metadata;
      if (m._vault) continue; // 볼트는 아래서 마켓에 붙임
      if (m._market) {
        const pm = m._market as Record<string, unknown>;
        marketMap.set(n.id, { id: n.id, label: n.label, lltv: (pm.lltv as number) ?? null, sizeUsd: (m.sizeUsd as number) ?? 0, ouroboros: !!pm.ouroboros, cross: !!pm.cross, vaults: [] });
        continue;
      }
      if (n.type === "Token" || n.type === "IslandHandle" || n.type === "Bridge") continue;
      if (!n.id.startsWith("c:")) continue;
      protoMap.set(n.id, { id: n.id, name: n.label, sizeUsd: (m.sizeUsd as number) ?? 0, markets: [] });
    }
    // 볼트 → 마켓에 부착
    for (const n of concTopo.nodes) {
      if (!n.metadata._vault) continue;
      const v = n.metadata._vault as Record<string, unknown>;
      const mid = n.id.replace(/:v\d+$/, "");
      marketMap.get(mid)?.vaults.push({ curator: String(v.curator ?? v.vault ?? n.label), allocationUsd: (v.allocationUsd as number) ?? null });
    }
    // 마켓 → 프로토콜에 부착
    for (const mk of marketMap.values()) {
      const pid = mk.id.replace(/:m\d+$/, "");
      protoMap.get(pid)?.markets.push(mk);
    }
    // 체인별 그룹
    const byChain = new Map<string, ChainBlock>();
    for (const p of protoMap.values()) {
      const chain = (concTopo.nodes.find((n) => n.id === p.id)?.metadata.chain as string) ?? "ethereum";
      if (!byChain.has(chain)) byChain.set(chain, { chain, supplyUsd: supplyByChain[chain]?.supplyUsd ?? 0, protocols: [], marketCount: 0 });
      p.markets.sort((a, b) => b.sizeUsd - a.sizeUsd);
      byChain.get(chain)!.protocols.push(p);
      byChain.get(chain)!.marketCount += p.markets.length;
    }
    const chainBlocks = [...byChain.values()].map((b) => ({ ...b, protocols: b.protocols.sort((x, y) => y.sizeUsd - x.sizeUsd) }))
      .sort((a, b) => b.supplyUsd - a.supplyUsd || b.protocols.length - a.protocols.length);

    // 브릿지
    const bridgeList: Bridge[] = brdgTopo.nodes.filter((n) => n.type === "Bridge").map((n: GraphNode) => {
      const m = n.metadata;
      return {
        id: n.id, protocol: (m.bridgeProtocol as string) ?? n.label, mechanism: (m.bridgeMechanism as string) ?? "lock_mint",
        tag: (m.bridgeTag as string) ?? "", verified: !!m.bridgeVerified, mintLimit: (m.bridgeMintLimit as number) ?? null,
        weak: !!m.bridgeWeak, route: n.label, category: (m.category as string) ?? "",
      };
    }).sort((a, b) => Number(b.verified) - Number(a.verified) || a.protocol.localeCompare(b.protocol));

    return { chains: chainBlocks, bridges: bridgeList };
  }, [concTopo, brdgTopo, supplyByChain]);

  return (
    <div className="h-full overflow-y-auto px-5 py-4 text-[var(--color-text-primary)]">
      {/* 체인 요약 */}
      <h3 className="mb-2 text-[13px] font-bold">체인 요약 <span className="font-normal text-[var(--color-text-muted)]">· {chains.length}체인</span></h3>
      <div className="mb-5 overflow-hidden rounded-lg border border-[var(--color-border-subtle)]">
        <table className="w-full text-[12px]">
          <thead className="bg-[var(--color-surface-raised)] text-[10px] uppercase text-[var(--color-text-muted)]">
            <tr><th className="px-3 py-1.5 text-left">체인</th><th className="px-3 py-1.5 text-right">공급</th><th className="px-3 py-1.5 text-right">프로토콜</th><th className="px-3 py-1.5 text-right">마켓</th><th className="px-3 py-1.5 text-left">갱신 주기</th></tr>
          </thead>
          <tbody>
            {chains.map((c) => (
              <tr key={c.chain} className="border-t border-[var(--color-border-subtle)]">
                <td className="px-3 py-1.5 font-medium capitalize">{c.chain}</td>
                <td className="px-3 py-1.5 text-right font-mono">{c.supplyUsd ? formatUsd(c.supplyUsd) : "—"}</td>
                <td className="px-3 py-1.5 text-right font-mono">{c.protocols.length}</td>
                <td className="px-3 py-1.5 text-right font-mono">{c.marketCount}</td>
                <td className="px-3 py-1.5 text-[10px] text-[var(--color-text-muted)]">{refreshNote(c.chain)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 브릿지 */}
      {bridges.length > 0 && (
        <>
          <h3 className="mb-2 text-[13px] font-bold">브릿지 <span className="font-normal text-[var(--color-text-muted)]">· {bridges.length}개 · ✓={bridges.filter((b) => b.verified).length} 온체인 검증</span></h3>
          <div className="mb-5 overflow-hidden rounded-lg border border-[var(--color-border-subtle)]">
            <table className="w-full text-[12px]">
              <thead className="bg-[var(--color-surface-raised)] text-[10px] uppercase text-[var(--color-text-muted)]">
                <tr><th className="px-3 py-1.5 text-left">회사 · 종류</th><th className="px-3 py-1.5 text-left">메커니즘</th><th className="px-3 py-1.5 text-left">검증</th><th className="px-3 py-1.5 text-right">mint 한도</th><th className="px-3 py-1.5 text-left">경로</th></tr>
              </thead>
              <tbody>
                {bridges.map((b) => {
                  const mech = MECH_KO[b.mechanism] ?? MECH_KO.lock_mint;
                  return (
                    <tr key={b.id} className="border-t border-[var(--color-border-subtle)]">
                      <td className="px-3 py-1.5 font-medium">{b.protocol}{b.weak ? " ⚠️" : ""}</td>
                      <td className="px-3 py-1.5"><span className="rounded px-1.5 py-0.5 text-[10px] font-semibold" style={{ color: mech.color, backgroundColor: `${mech.color}22` }}>{mech.label}</span></td>
                      <td className="px-3 py-1.5">{b.verified ? <span className="text-[var(--color-accent)]">✓ 검증</span> : <span className="text-[var(--color-text-muted)]">추정</span>}</td>
                      <td className="px-3 py-1.5 text-right font-mono">{b.mintLimit != null ? formatUsd(b.mintLimit) : "—"}</td>
                      <td className="px-3 py-1.5 text-[11px] text-[var(--color-text-secondary)]">{b.route}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* 프로토콜 & 마켓 (체인별) */}
      <h3 className="mb-2 text-[13px] font-bold">프로토콜 · 마켓 · 큐레이터 <span className="font-normal text-[var(--color-text-muted)]">(체인별)</span></h3>
      <div className="space-y-3 pb-6">
        {chains.map((c) => (
          <div key={c.chain} className="rounded-lg border border-[var(--color-border-subtle)]">
            <div className="flex items-center justify-between border-b border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-3 py-1.5">
              <span className="text-[12px] font-bold capitalize">{c.chain}</span>
              <span className="font-mono text-[11px] text-[var(--color-text-secondary)]">{c.supplyUsd ? formatUsd(c.supplyUsd) : ""} · {c.protocols.length}P / {c.marketCount}M</span>
            </div>
            <div className="divide-y divide-[var(--color-border-subtle)]">
              {c.protocols.map((p) => (
                <div key={p.id} className="px-3 py-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[12px] font-semibold">{p.name}</span>
                    <span className="font-mono text-[11px] text-[var(--color-text-secondary)]">{formatUsd(p.sizeUsd)}</span>
                  </div>
                  {p.markets.length > 0 && (
                    <div className="mt-1 space-y-0.5 pl-3">
                      {p.markets.map((mk) => (
                        <div key={mk.id} className="flex flex-wrap items-center gap-x-2 text-[11px] text-[var(--color-text-secondary)]">
                          <span className="font-medium text-[var(--color-text-primary)]">{mk.label}</span>
                          <span className="text-[var(--color-text-muted)]">LLTV {pct(mk.lltv)}</span>
                          <span className="font-mono">{formatUsd(mk.sizeUsd)}</span>
                          {mk.cross && <span className="text-[#fdba74]">↔토큰간</span>}
                          {mk.vaults.length > 0 && <span className="text-[var(--color-text-muted)]">· 큐레이터: {mk.vaults.map((v) => v.curator).slice(0, 4).join(", ")}{mk.vaults.length > 4 ? " 외" : ""}</span>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
