"use client";

import { AlertDock } from "@/components/AlertDock";
import { SiteHeader } from "@/components/SiteHeader";
import { FlowMap } from "@/components/flow/FlowMap";

/** /flow — 전체화면 흐름맵. 본체(컨트롤·그래프·디테일)는 FlowMap 컴포넌트로, 메인 페이지(흐름맵+모니터링 2분할)와 공유. */
export default function FlowPage() {
  return (
    <div className="flex h-screen flex-col bg-[var(--color-bg)]">
      <AlertDock />
      <SiteHeader />
      <FlowMap />
    </div>
  );
}
