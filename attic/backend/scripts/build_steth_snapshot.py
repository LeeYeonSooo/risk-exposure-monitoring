"""
Build the steth_depeg_2022 contagion snapshot — a "held" case on Aave V2.

stETH (collateral for ETH-looping) depegged -4.5% on Curve after LUNA (2022-05-09).
Aave V2 LT = 82.5%. A -4.5% move is FAR below the liquidation buffer, so even a
maximally-leveraged position (debt = LT*collateral) stays solvent:
    recoverable = collateral*(1-0.045) = 0.955*collateral  >  0.825*collateral = max debt
=> bad debt = 0 for ANY borrow level. Matches reality: 0 liquidations, 0 bad debt.

Morpho Blue did not exist in 2022, so this is Aave-V2-only (no cross-protocol hop).
Accounting reused from backtest_runner.VERIFIED_SNAPSHOTS (already archive-verified).
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from api.core.backtest_runner import VERIFIED_SNAPSHOTS

s = VERIFIED_SNAPSHOTS["steth_depeg_2022"]
collateral_usd = s["atoken_supply"] * s["oracle_price"]          # total stETH supplied (USD)
lt = s["lt_normal"]                                              # 0.825
# Worst-case leverage: debt at the liquidation threshold. If even this survives, all do.
borrow_usd = collateral_usd * lt
delta = round(s["actual_depeg_pct"] / 100.0, 4)                  # 0.045

out = {
    "ground_truth": {
        "headline": ("LUNA 붕괴 → stETH Curve −4.5% 디페그. Aave V2 청산 0건, bad debt $0. "
                     "−4.5%가 82.5% LT 버퍼 한참 아래라 최대레버리지 포지션도 솔벤트 유지."),
        "aave_bad_debt_usd": s["actual_bad_debt_usd"],           # 0
        "actual_liquidations": s.get("actual_liquidation_count_30d", 0),
        "distribution_note": "Aave V2 단일 마켓. Morpho Blue는 2022년에 미존재 (cross-protocol hop 없음).",
    },
    "event": {
        "id": "steth_depeg_2022_contagion",
        "date": "2022-05-09",
        "pre_shock_date": "2022-05-09",
        "shock_node": "stETH",
        "root_label": "LUNA 붕괴 패닉",
        "delta": delta,
        "description": "LUNA 붕괴 → stETH 대규모 매도 → Curve −4.5% 디페그 (held)",
        "source": "Aave V2 archive snapshot (worst-case leverage = LT)",
    },
    "aave": {
        "venue": "Aave V2",
        "market": "stETH/ETH(loop)",
        "pre_collateral_usd": round(collateral_usd),
        "pre_borrow_usd": round(borrow_usd),
        "pre_supply_usd": round(borrow_usd),
        "lltv": lt,
        "actual_bad_debt_usd": s["actual_bad_debt_usd"],
    },
    "morpho_markets": [],
}

outpath = Path(__file__).resolve().parent.parent / "api" / "data" / "steth_snapshot.json"
outpath.write_text(json.dumps(out, indent=2))
print(f"stETH collateral=${collateral_usd:,.0f}  worst-case borrow(@LT)=${borrow_usd:,.0f}  delta={delta}")
print(f"recoverable@-4.5% = ${collateral_usd*(1-delta):,.0f}  vs borrow ${borrow_usd:,.0f}  -> bad debt $0")
print("WROTE", outpath)
