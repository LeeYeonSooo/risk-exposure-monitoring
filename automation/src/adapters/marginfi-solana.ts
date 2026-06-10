/**
 * MarginFi (Solana) 렌딩 어댑터 — public REST 가 없어 SDK 디코드. 단 **무료 RPC 티어를 위해**
 * 전체 getProgramAccounts(MarginfiClient.fetch — 429) 대신 **bank 주소(메타데이터 캐시) → fetchMultipleBanks
 * (getMultipleAccounts, 가벼움) → 디코드** 경로를 쓴다. 가격은 DeFiLlama(solana:mint)로 USD 환산.
 *
 * 신호: **이용률(util = totalLiability/totalAsset, 가격 불요)**. ⚠️ assetWeightInit(담보 weight)은 EVM LLTV 와
 *   의미가 달라(스테이블=1.0 정상) high_lltv 로 쓰면 오탐 → maxLtv=null(util-only). (Alchemy 키 없으면 skip.)
 */
import { AnchorProvider, Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as M from "@mrgnlabs/marginfi-client-v2";
import { wrappedI80F48toBigNumber } from "@mrgnlabs/mrgn-common";

import { env } from "@/config/chains";
import type { NonEvmReserve } from "./nonevm-types";

const PROGRAM_ID = "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA";
const META = "https://storage.googleapis.com/mrgn-public/mrgn-bank-metadata-cache.json";
const mm = M as unknown as Record<string, (...a: unknown[]) => unknown> & { MARGINFI_IDL: unknown };

export const protocol = "marginfi";

interface BankMeta { bankAddress: string; tokenAddress: string; tokenSymbol: string }

async function fetchPrices(mints: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (let i = 0; i < mints.length; i += 60) {
    const chunk = mints.slice(i, i + 60).map((m) => `solana:${m}`);
    try {
      const r = await fetch(`https://coins.llama.fi/prices/current/${chunk.join(",")}`, { signal: AbortSignal.timeout(15_000) });
      const j = (await r.json()) as { coins?: Record<string, { price?: number }> };
      for (const [k, v] of Object.entries(j.coins ?? {})) if (v.price != null) out.set(k.split(":")[1], v.price);
    } catch { /* skip chunk */ }
  }
  return out;
}

export async function fetchReserves(): Promise<NonEvmReserve[]> {
  if (!env.ALCHEMY_API_KEY) return []; // 무료 public RPC 는 getMultipleAccounts 도 빡빡 — Alchemy 필요

  let meta: BankMeta[] = [];
  try { meta = (await (await fetch(META, { signal: AbortSignal.timeout(15_000) })).json()) as BankMeta[]; } catch { return []; }
  if (!meta.length) return [];

  const conn = new Connection(`https://solana-mainnet.g.alchemy.com/v2/${env.ALCHEMY_API_KEY}`, "confirmed");
  const wallet = { publicKey: Keypair.generate().publicKey, signTransaction: async (t: unknown) => t, signAllTransactions: async (t: unknown) => t };
  const provider = new AnchorProvider(conn, wallet as never, { commitment: "confirmed" });
  const program = new Program({ ...(mm.MARGINFI_IDL as object), address: PROGRAM_ID } as never, provider);

  const symByAddr = new Map(meta.map((m) => [m.bankAddress, m.tokenSymbol]));
  const mintByAddr = new Map(meta.map((m) => [m.bankAddress, m.tokenAddress]));
  const px = await fetchPrices([...new Set(meta.map((m) => m.tokenAddress))]);

  const out: NonEvmReserve[] = [];
  const addrs = meta.map((m) => m.bankAddress);
  for (let i = 0; i < addrs.length; i += 100) { // getMultipleAccounts 100/콜
    const chunk = addrs.slice(i, i + 100).map((a) => new PublicKey(a));
    let banks: { address: unknown; data: Record<string, unknown> }[] = [];
    try { banks = (await mm.fetchMultipleBanks(program, { bankAddresses: chunk })) as typeof banks; } catch { continue; }
    for (const e of banks) {
      const bank = e?.data as Record<string, unknown> | undefined;
      if (!bank) continue;
      try {
        const w = (x: unknown) => wrappedI80F48toBigNumber(x as never);
        const assetQty = w(bank.totalAssetShares).times(w(bank.assetShareValue));
        const liabQty = w(bank.totalLiabilityShares).times(w(bank.liabilityShareValue));
        if (!assetQty.gt(0)) continue;
        const util = liabQty.div(assetQty).toNumber();
        const dec = Number(bank.mintDecimals ?? 0);
        const price = px.get(mintByAddr.get(String(e.address)) ?? "") ?? 0;
        const supplyUsd = assetQty.div(10 ** dec).toNumber() * price;
        const borrowUsd = liabQty.div(10 ** dec).toNumber() * price;
        out.push({
          protocol: "marginfi", chain: "solana", market: "MarginFi",
          symbol: symByAddr.get(String(e.address)) ?? "?",
          maxLtv: null, // assetWeightInit ≠ EVM LLTV(스테이블 1.0 정상) → util-only
          utilization: util, supplyUsd, borrowUsd,
        });
      } catch { /* skip bank */ }
    }
  }
  return out;
}
