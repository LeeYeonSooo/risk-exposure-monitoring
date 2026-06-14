"use client";

import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
}

/**
 * 그래프 렌더 중 발생한 예외를 가둬서 페이지 전체가 죽는 걸 막는다.
 * (엣지/노드마다 attrs 구성이 달라 한 건의 null 접근이 화면 전체를 날리던 문제 방어.)
 * 프로덕션에선 Next 오버레이가 없으니 이 fallback 이 외부 viewer 에게 그대로 보인다.
 */
export class GraphErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    // 콘솔에만 남기고 화면은 계속 살려둔다.
    console.error("[GraphErrorBoundary] caught render error:", error);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex h-full w-full flex-col items-center justify-center gap-3 text-center">
          <div className="text-sm font-medium text-[var(--color-text-secondary)]">
            그래프를 그리는 중 일시적 오류가 발생했어요.
          </div>
          <div className="max-w-md font-mono text-[11px] text-[var(--color-text-muted)]">
            {this.state.error.message}
          </div>
          <button
            type="button"
            onClick={() => this.setState({ error: null })}
            className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-[12px] font-medium text-white hover:opacity-90"
          >
            다시 시도
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
