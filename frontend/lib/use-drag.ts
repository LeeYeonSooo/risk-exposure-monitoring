"use client";

import { useRef, useState } from "react";

/**
 * 떠 있는 패널/버튼을 끌어서 옮기는 훅.
 *  · pos === null 이면 원래 anchor 클래스 위치 그대로, 한 번 끌면 inline left/top 으로 전환
 *  · 4px 미만 이동은 드래그로 치지 않음 → 클릭과 충돌하지 않는다 (consumeMoved 로 판별)
 *  · withinParent: offsetParent(relative 컨테이너) 안에서만 이동 (트랜잭션 패널용),
 *    아니면 뷰포트 기준 (알림 독용)
 *
 * 사용: 루트 요소에 data-drag-root + style={posStyle(pos)}, 핸들 요소에 onPointerDown.
 */
export function useDragPosition(opts?: { withinParent?: boolean }) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const movedRef = useRef(false);

  const onPointerDown = (e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    const el = (e.currentTarget.closest("[data-drag-root]") ?? e.currentTarget) as HTMLElement;
    const parent = opts?.withinParent ? (el.offsetParent as HTMLElement | null) : null;
    const pRect = parent?.getBoundingClientRect();
    const rect = el.getBoundingClientRect();
    const offX = e.clientX - rect.left, offY = e.clientY - rect.top;
    const sx = e.clientX, sy = e.clientY;
    movedRef.current = false;

    const onMove = (ev: PointerEvent) => {
      if (!movedRef.current && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
      movedRef.current = true;
      const baseL = pRect?.left ?? 0, baseT = pRect?.top ?? 0;
      const areaW = pRect?.width ?? window.innerWidth, areaH = pRect?.height ?? window.innerHeight;
      const maxX = Math.max(0, areaW - rect.width), maxY = Math.max(0, areaH - rect.height);
      setPos({
        x: Math.min(Math.max(ev.clientX - offX - baseL, 0), maxX),
        y: Math.min(Math.max(ev.clientY - offY - baseT, 0), maxY),
      });
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  /** 직전 포인터 동작이 드래그였으면 true (한 번 읽으면 리셋) — 클릭 핸들러에서 가드용 */
  const consumeMoved = () => {
    const m = movedRef.current;
    movedRef.current = false;
    return m;
  };

  return { pos, onPointerDown, consumeMoved };
}

/** 드래그 후엔 anchor 클래스(right/top/transform/bottom)를 inline 으로 무력화 */
export function dragStyle(pos: { x: number; y: number } | null): React.CSSProperties | undefined {
  return pos ? { left: pos.x, top: pos.y, right: "auto", bottom: "auto", transform: "none" } : undefined;
}
