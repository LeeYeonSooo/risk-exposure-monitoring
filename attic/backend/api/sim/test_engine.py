"""
engine 손계산 검증. 실행: python3 -m api.sim.test_engine  (backend/ 에서)
"""
from api.sim.engine import propagate


def test_linear_chain():
    g = {
        "nodes": [{"id": "USR", "tvl": 0}, {"id": "Market_M", "tvl": 10e6}, {"id": "Vault_V", "tvl": 6e6}],
        "edges": [{"from": "USR", "to": "Market_M", "w": 0.5}, {"from": "Market_M", "to": "Vault_V", "w": 0.8}],
    }
    r = propagate(g, {"node": "USR", "delta": 1.0})
    assert abs(r["h"]["USR"] - 1.0) < 1e-9
    assert abs(r["h"]["Market_M"] - 0.5) < 1e-9   # 0.5·1.0
    assert abs(r["h"]["Vault_V"] - 0.4) < 1e-9    # 0.8·0.5
    assert r["distress_round"] == {"USR": 0, "Market_M": 1, "Vault_V": 2}


def test_multiparent_cap():
    g = {
        "nodes": [{"id": "A"}, {"id": "B"}, {"id": "C"}],
        "edges": [{"from": "A", "to": "B", "w": 0.6}, {"from": "A", "to": "C", "w": 0.7}, {"from": "B", "to": "C", "w": 0.8}],
    }
    r = propagate(g, {"node": "A", "delta": 1.0})
    assert abs(r["h"]["B"] - 0.6) < 1e-9
    assert abs(r["h"]["C"] - 1.0) < 1e-9          # min(1, 0.7 + 0.8·0.6=1.18) = 1.0


def test_partial_depeg():
    g = {
        "nodes": [{"id": "USR"}, {"id": "M"}, {"id": "V"}],
        "edges": [{"from": "USR", "to": "M", "w": 0.5}, {"from": "M", "to": "V", "w": 0.8}],
    }
    r = propagate(g, {"node": "USR", "delta": 0.3})
    assert abs(r["h"]["M"] - 0.15) < 1e-9          # 0.5·0.3
    assert abs(r["h"]["V"] - 0.12) < 1e-9          # 0.8·0.15


if __name__ == "__main__":
    test_linear_chain()
    test_multiparent_cap()
    test_partial_depeg()
    print("✅ all engine tests passed")
