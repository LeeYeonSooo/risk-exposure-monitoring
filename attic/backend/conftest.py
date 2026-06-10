"""
pytest configuration for the LST/LRT Depeg Simulator test suite.
Adds project root to sys.path and provides shared fixtures.
"""

import sys
import os
import pytest

# Ensure the project root is on sys.path so both `simulation` and `api` are importable
sys.path.insert(0, os.path.dirname(__file__))

# Load backend/.env so tests pick up ALCHEMY_API_KEY etc.
try:
    from dotenv import load_dotenv
    load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))
except ImportError:
    pass


@pytest.fixture()
def base_simulator():
    """Returns a CascadeSimulator initialised with default params."""
    from simulation.engine import CascadeSimulator
    from simulation.params import RSETH_PRICE_USD, DEX_LIQUIDITY_USD

    return CascadeSimulator(
        dex_liquidity_usd=DEX_LIQUIDITY_USD,
        initial_price=RSETH_PRICE_USD,
    )
