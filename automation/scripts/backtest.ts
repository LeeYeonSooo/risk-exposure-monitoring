/**
 * 백테스트 CLI — fork 기반(2026-06 재작성). 실제 사건 블록으로 fork 해 프로덕션 디텍터를 그대로 재생한다.
 * 로직은 src/backtest/{incidents,fork-reader,run}.ts. (구 픽스처-replay 하니스 대체.)
 *
 * Usage:
 *   npm run backtest                 # 전 사건
 *   npm run backtest -- --verbose    # poll 별 가격/공급/발화 상세
 *   npm run backtest -- --only USDC  # id 부분매칭 사건만
 */
import "@/backtest/run";
