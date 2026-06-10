"""
api package.

Folder layout (re-organised 2026-05-27):
  api/
  ├── main.py            FastAPI entrypoint
  ├── core/              business logic (graph, simulation, backtest)
  └── fetchers/          external data fetchers (on-chain, off-chain)

Backwards-compatible re-exports below preserve legacy `api.<name>` import paths
for the modules still in use (graph, portfolio_simulate, fetchers).
(The old rsETH CascadeSimulator — simulation_runner/backtest_runner/forksim — was
removed 2026-06; see docs/cleanup_phase1.md.)
"""

import sys as _sys

# Submodules — import once, then alias under flat `api.<name>` paths.
from .core import (
    graph_data as _graph_data,
    graph_builder as _graph_builder,
    portfolio_simulate as _portfolio_simulate,
)
from .fetchers import (
    archive_fetcher as _archive_fetcher,
    onchain_fetcher as _onchain_fetcher,
    portfolio_fetcher as _portfolio_fetcher,
    position_fetcher as _position_fetcher,
    wallet_fetcher as _wallet_fetcher,
)

# Flat alias registration so legacy `api.X` imports keep resolving.
for _alias, _mod in {
    "graph_data": _graph_data,
    "graph_builder": _graph_builder,
    "portfolio_simulate": _portfolio_simulate,
    "archive_fetcher": _archive_fetcher,
    "onchain_fetcher": _onchain_fetcher,
    "portfolio_fetcher": _portfolio_fetcher,
    "position_fetcher": _position_fetcher,
    "wallet_fetcher": _wallet_fetcher,
}.items():
    _sys.modules[f"api.{_alias}"] = _mod
