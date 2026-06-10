"""Terminal output visualization for simulation results."""

from .engine import SimulationResult


BAR_WIDTH = 40


def _bar(value: float, max_value: float, width: int = BAR_WIDTH) -> str:
    if max_value <= 0:
        return " " * width
    filled = int((value / max_value) * width)
    filled = min(filled, width)
    return "█" * filled + "░" * (width - filled)


def _fmt_usd(v: float) -> str:
    if v >= 1_000_000:
        return f"${v/1_000_000:.1f}M"
    if v >= 1_000:
        return f"${v/1_000:.0f}K"
    return f"${v:.0f}"


def _severity(depeg_pct: float) -> str:
    if depeg_pct < 5:
        return "🟢 LOW"
    if depeg_pct < 15:
        return "🟡 MEDIUM"
    if depeg_pct < 30:
        return "🔴 HIGH"
    return "💀 CRITICAL"


def print_result(result: SimulationResult) -> None:
    sep = "─" * 60

    print(f"\n{'═' * 60}")
    print(f"  {result.scenario.upper()}")
    print(f"  {result.shock_description}")
    print(f"{'═' * 60}")

    print(f"\n  초기 가격    : ${result.initial_price:,.0f}")
    print(f"  최종 DEX 가격 : ${result.final_dex_price:,.0f}")
    print(f"  Depeg 폭      : {result.depeg_pct:.1f}%  {_severity(result.depeg_pct)}")
    print(f"  총 청산 규모  : {_fmt_usd(result.total_liquidated_usd)}")
    print(f"  총 배드뎃     : {_fmt_usd(result.total_bad_debt_usd)}")
    print(f"  수렴 여부     : {'✅ 수렴' if result.converged else '⚠️  미수렴 (max rounds)'}")

    if not result.rounds:
        print("\n  → 초기 충격으로 청산 발생 없음 (포지션 건전)\n")
        return

    print(f"\n  {sep}")
    print(f"  {'라운드':>4}  {'DEX가격':>8}  {'청산규모':>10}  {'배드뎃':>9}  가격충격")
    print(f"  {sep}")

    max_sell = max((r.sell_pressure_usd for r in result.rounds), default=1)
    for r in result.rounds:
        bar = _bar(r.sell_pressure_usd, max_sell, width=20)
        print(
            f"  {r.round_num:>4}  "
            f"${r.dex_price:>7,.0f}  "
            f"{_fmt_usd(r.sell_pressure_usd):>10}  "
            f"{_fmt_usd(r.bad_debt_usd):>9}  "
            f"{bar}"
        )

    print(f"  {sep}\n")


def print_comparison(results: list) -> None:
    print(f"\n{'═' * 70}")
    print(f"  시나리오 비교 요약")
    print(f"{'═' * 70}")
    print(f"  {'시나리오':<30} {'Depeg':>7} {'청산':>10} {'배드뎃':>10} {'심각도'}")
    print(f"  {'─' * 66}")

    for r in results:
        sev = _severity(r.depeg_pct)
        print(
            f"  {r.scenario:<30} "
            f"{r.depeg_pct:>6.1f}%  "
            f"{_fmt_usd(r.total_liquidated_usd):>10}  "
            f"{_fmt_usd(r.total_bad_debt_usd):>10}  "
            f"{sev}"
        )

    print(f"  {'─' * 66}\n")
