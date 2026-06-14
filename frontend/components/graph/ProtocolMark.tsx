"use client";

import { useState } from "react";

import type { ProtocolBrand } from "./protocols";
import { cn } from "@/lib/utils";

interface Props {
  brand: ProtocolBrand;
  /** tailwind size class for the box, e.g. "size-9" */
  boxClass: string;
  /** monogram font px */
  fontPx: number;
  /** explicit pixel size (overrides boxClass sizing) — for dynamically-sized circular token nodes */
  sizePx?: number;
  /** circular instead of rounded-square */
  circle?: boolean;
  /** fill mode: logo image covers the whole box edge-to-edge (no inner padding/box) — the
   *  parent provides the single border ring. Avoids the messy double-ring + margin look. */
  fill?: boolean;
}

/**
 * Renders a protocol's logo, trying sources in order and falling back gracefully:
 *   1. /protocols/<slug>.svg   — a local file the user can drop in (highest priority)
 *   2. DefiLlama icon CDN       — the real protocol logo, fetched live
 *   3. brand-coloured monogram  — always works, so identity is never lost
 */
export function ProtocolMark({ brand, boxClass, fontPx, sizePx, circle, fill }: Props) {
  const sources = [
    `/protocols/${brand.slug}.svg`,
    brand.llama ? `https://icons.llamao.fi/icons/protocols/${brand.llama}?w=160&h=160` : null,
  ].filter(Boolean) as string[];

  const [idx, setIdx] = useState(0);
  const exhausted = idx >= sources.length;

  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-center overflow-hidden",
        circle ? "rounded-full" : "rounded-lg",
        boxClass,
      )}
      style={{
        // fill+이미지일 땐 배경 틴트 없이(이미지가 꽉 채움). monogram 폴백이면 틴트로 글자 보이게.
        backgroundColor: fill && !exhausted ? "transparent" : `${brand.color}22`,
        ...(sizePx ? { width: sizePx, height: sizePx } : {}),
      }}
      title={brand.label}
    >
      {!exhausted ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={sources[idx]}
          alt={brand.label}
          className={cn("size-full", fill ? "object-cover" : "object-contain p-px")}
          onError={() => setIdx((i) => i + 1)}
        />
      ) : (
        <span
          className="font-bold leading-none"
          style={{ color: brand.color, fontSize: fontPx }}
        >
          {brand.mark}
        </span>
      )}
    </div>
  );
}
