from dotenv import load_dotenv
load_dotenv()

"""FastAPI backend for LST/LRT Depeg Simulator."""

import json
import os
from pathlib import Path
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, field_validator
from typing import Optional

# 프로젝트 루트 경로 (api → backend → new-simulator = repo root, self-contained)
ROOT = Path(__file__).resolve().parent.parent.parent

from .core.graph_data import NODES, EDGES, NODE_POSITIONS
from .core.graph_builder import build_dynamic_graph, get_cached_graph
from .core.module_bridge import merge_module_graph, get_module_summary, refresh_module_graph
from .core import focus as _focus
from .core import aave_discovery as _aave_discovery
from .core import morpho_discovery as _morpho_discovery
from .core import consumer_discovery as _consumer_discovery
from .core import flow_discovery as _flow_discovery
from .core import pendle_discovery as _pendle_discovery
from .core import eoa_bridge_discovery as _eoa_bridge_discovery
from .core import position_copresence_discovery as _copresence_discovery
from .event_collectors import AaveCollector, LidoCollector, MorphoCollector, SkyCollector, event_store as _event_store
from .fetchers.onchain_fetcher import get_live_stats
from .fetchers.wallet_fetcher import fetch_wallet_position
from .fetchers.portfolio_fetcher import fetch_wallet_portfolio
from .core import contagion_backtest as _contagion
from .core import live_contagion as _live

import asyncio as _asyncio

async def _warmup():
    """Kick off background warmup immediately — never blocks server startup."""
    _asyncio.create_task(_do_warmup())


async def _do_warmup():
    """Background: warm the live on-chain stats cache (used by /api/wallet/.../position)."""
    try:
        await get_live_stats()
    except Exception:
        pass


def _startup_refresh_modules():
    """startup: integration/module_loader 자동 실행 → simulator_graph.json 최신화."""
    result = refresh_module_graph()
    if result.get("ok"):
        print(
            f"[startup] module graph refreshed: modules={result['modules']} "
            f"nodes={result['node_count']} edges={result['edge_count']}"
        )
    else:
        print(f"[startup] module refresh skipped/failed: {result.get('error')}")


# ─────────────────────────────────────────────────────────────────
# Phase 5 (작업 5) — 정기 폴링 (Aave 이벤트 자동 수집)
# ─────────────────────────────────────────────────────────────────

# 환경변수로 조절. 0 또는 음수면 비활성.
POLLING_INTERVAL_MINUTES = int(os.getenv("AAVE_POLLING_INTERVAL_MINUTES", "60"))
# 시작 블록 (마지막 수집 블록 + 1 부터). 기본은 mock 모드 가정 — 의미는 작음.
_last_polled_block: int = int(os.getenv("AAVE_POLLING_START_BLOCK", "19000000"))
_polling_stats: dict = {
    "enabled": POLLING_INTERVAL_MINUTES > 0,
    "interval_minutes": POLLING_INTERVAL_MINUTES,
    "runs": 0,
    "total_edges_saved": 0,
    "last_run_at": None,
    "last_blocks": None,
    "last_error": None,
}


# 마지막으로 발견된 reserve 수 (새 자산 감지용)
_last_reserves_count: int = 0
_new_reserves_history: list[dict] = []


async def _check_new_reserves():
    """
    Phase 5 (작업 7) — 새 자산 자동 등록.
    discovery 다시 실행 → 이전 폴링 대비 reserve 수가 늘었으면
    새 자산이 추가된 것으로 보고 자동 module 재로드 + 시그널 기록.
    """
    global _last_reserves_count, _new_reserves_history
    try:
        discovery = await _aave_discovery.discover_aave_reserves()
        current = discovery.get("count", 0)
        if current > 0 and _last_reserves_count > 0 and current != _last_reserves_count:
            delta = current - _last_reserves_count
            event = {
                "detected_at": _polling_stats.get("last_run_at"),
                "previous_count": _last_reserves_count,
                "current_count": current,
                "delta": delta,
            }
            _new_reserves_history.append(event)
            print(f"[reserves] change detected: {_last_reserves_count} → {current} ({'+' if delta > 0 else ''}{delta})")

            # 자동 module 재로드 (새 자산 노드가 그래프에 등장)
            if delta > 0:
                # discovery 결과를 json 으로 저장 후 module_loader 재실행
                nodes = _aave_discovery.discovery_to_module_nodes(discovery)
                edges = _aave_discovery.discovery_to_module_edges(discovery)
                out_path = ROOT / "integration" / "output" / "discovered_nodes_edges.json"
                out_path.parent.mkdir(parents=True, exist_ok=True)
                out_path.write_text(
                    json.dumps({"nodes": nodes, "edges": edges, "_meta": discovery}, indent=2, ensure_ascii=False),
                    encoding="utf-8",
                )
                refresh_module_graph()
                _focus.invalidate_graph_cache()
        _last_reserves_count = current
    except Exception as e:
        print(f"[reserves] check failed: {e}")


_copresence_cycle = 0
# 60분 폴링 기준 24 사이클 = 약 하루. copresence 는 무거운 RPC(480콜) 이라 일 1회만.
_COPRESENCE_EVERY_CYCLES = 24


async def _refresh_copresence():
    """포지션 co-presence 재계산 (일 1회). discovered_copresence.json 저장 + 그래프 머지."""
    try:
        disc = await _copresence_discovery.discover_copresence()
        nodes = _copresence_discovery.discovery_to_module_nodes(disc)
        edges = _copresence_discovery.discovery_to_module_edges(disc)
        out_path = ROOT / "integration" / "output" / "discovered_copresence.json"
        out_path.write_text(
            json.dumps({"nodes": nodes, "edges": edges, "_meta": disc}, indent=2, ensure_ascii=False),
            encoding="utf-8",
        )
        if disc.get("bridges_count", 0) > 0:
            refresh_module_graph()
            print(f"[polling] copresence: {disc['bridges_count']} bridges "
                  f"(lido_indep={disc.get('lido_independent')}, sky_indep={disc.get('sky_independent')})")
    except Exception as e:
        print(f"[polling] copresence error: {e}")


async def _aave_polling_loop():
    """백그라운드: 일정 주기마다 AaveCollector 호출 → SQLite 적재 + 새 자산 감지."""
    global _last_polled_block, _copresence_cycle
    import asyncio as _aio
    import time as _t

    collector = _COLLECTORS.get("aave-v3")
    if collector is None:
        return

    if POLLING_INTERVAL_MINUTES <= 0:
        print("[polling] disabled (AAVE_POLLING_INTERVAL_MINUTES <= 0)")
        return

    print(f"[polling] aave-v3 every {POLLING_INTERVAL_MINUTES} min, start_block={_last_polled_block}")

    while True:
        try:
            from_block = _last_polled_block
            # mock 모드면 블록 50씩 진행. subgraph 모드면 더 큰 폭으로 가능.
            to_block = from_block + (50 if collector.mode == "mock" else 200)

            edges, _ = await collector.collect(from_block, to_block)
            new_count = _event_store.save_edges(edges)

            _last_polled_block = to_block + 1
            _polling_stats["runs"] += 1
            _polling_stats["total_edges_saved"] += new_count
            _polling_stats["last_run_at"] = _t.time()
            _polling_stats["last_blocks"] = [from_block, to_block]
            _polling_stats["last_error"] = None
            print(f"[polling] aave-v3 blocks {from_block}-{to_block}: +{new_count} edges (total {_polling_stats['total_edges_saved']})")

            # Lido / Morpho / Sky 도 같은 블록 범위 수집 (RPC eth_getLogs, 10블록 chunk 자동)
            for extra_proto in ("lido", "morpho", "sky"):
                extra_collector = _COLLECTORS.get(extra_proto)
                if extra_collector is None:
                    continue
                try:
                    extra_edges, _ = await extra_collector.collect(from_block, to_block)
                    extra_new = _event_store.save_edges(extra_edges)
                    _polling_stats["total_edges_saved"] += extra_new
                    print(f"[polling] {extra_proto} blocks {from_block}-{to_block}: "
                          f"+{extra_new} edges ({extra_collector.get_source()})")
                except Exception as ee:
                    print(f"[polling] {extra_proto} error: {ee}")

            # 작업 7: 폴링 사이클마다 새 자산 감지
            await _check_new_reserves()

            # EOA-bridge 재계산 (누적된 event_store 로 cross-protocol 고래 다리 갱신)
            try:
                bridge_disc = _eoa_bridge_discovery.discover_eoa_bridges()
                b_nodes = _eoa_bridge_discovery.discovery_to_module_nodes(bridge_disc)
                b_edges = _eoa_bridge_discovery.discovery_to_module_edges(bridge_disc)
                bridge_path = ROOT / "integration" / "output" / "discovered_eoa_bridges.json"
                bridge_path.write_text(
                    json.dumps({"nodes": b_nodes, "edges": b_edges, "_meta": bridge_disc}, indent=2, ensure_ascii=False),
                    encoding="utf-8",
                )
                if bridge_disc.get("bridges_count", 0) > 0:
                    refresh_module_graph()
                    print(f"[polling] eoa-bridges: {bridge_disc['bridges_count']} bridges "
                          f"({sum(1 for b in bridge_disc['bridges'] if b['tier']=='realized')} realized)")
            except Exception as be:
                print(f"[polling] eoa-bridge error: {be}")

            # 포지션 co-presence — 무거운 RPC 라 일 1회만 (rate limit 보호)
            _copresence_cycle += 1
            if _copresence_cycle % _COPRESENCE_EVERY_CYCLES == 1:  # 첫 사이클 + 이후 24 사이클마다
                await _refresh_copresence()
        except Exception as e:
            _polling_stats["last_error"] = str(e)
            print(f"[polling] error: {e}")

        await _aio.sleep(POLLING_INTERVAL_MINUTES * 60)


def _startup_polling():
    """startup: 정기 폴링 백그라운드 태스크 시작."""
    import asyncio as _aio
    if POLLING_INTERVAL_MINUTES > 0:
        _aio.create_task(_aave_polling_loop())


app = FastAPI(
    title="LST/LRT Depeg Simulator API",
    version="1.0.0",
    on_startup=[_startup_refresh_modules, _warmup, _startup_polling],
)

# In-memory gauge history (max 100 snapshots)
from collections import deque
from datetime import datetime, timezone
_gauge_history: deque = deque(maxlen=100)

# CORS origins:
#   - local dev: localhost / 127.0.0.1 / any private LAN IP (10.x, 192.168.x, 172.16-31.x) on any port
#   - production: any *.vercel.app deployment
#   - Set CORS_EXTRA_ORIGINS env var to add custom origins (comma-separated)
_extra_origins = [o.strip() for o in os.getenv("CORS_EXTRA_ORIGINS", "").split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://localhost:3000",
        "http://127.0.0.1:5173",
        "http://127.0.0.1:3000",
        *_extra_origins,
    ],
    # Regex covers: Vercel deploys + private LAN IPs (LAN dev sharing with team)
    allow_origin_regex=(
        r"https://.*\.vercel\.app"
        r"|http://(?:localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+"
        r"|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2[0-9]|3[0-1])\.\d+\.\d+)"
        r"(?::\d+)?"
    ),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health():
    return {"status": "ok"}


# ── Backtest endpoints ────────────────────────────────────────────────────────

@app.get("/api/backtest/incidents")
def list_backtest_incidents():
    """List contagion (DebtRank) backtest incidents — each with its own historical graph."""
    import json as _json
    incidents = []

    def _add(snap, asset, scenario):
        ev = snap["event"]
        gt = snap["ground_truth"]
        incidents.append({
            "id": ev["id"], "type": "contagion", "asset": asset, "date": ev["date"],
            "scenario": scenario, "description": gt["headline"], "has_archive_data": True,
            "actual_bad_debt_usd": gt.get("aave_bad_debt_usd", gt.get("solvency_loss_total_usd", 0)),
            "actual_depeg_pct": round(ev["delta"] * 100, 1),
        })

    try:
        _add(_contagion.load_snapshot(), "USR", "usr_depeg_contagion")
    except Exception:
        pass
    try:
        _add(_contagion.load_kelp_snapshot(), "rsETH", "rseth_cross_protocol")
    except Exception:
        pass
    try:
        _add(_json.loads(_contagion.STETH_SNAPSHOT.read_text()), "stETH", "steth_held")
    except Exception:
        pass
    # non-solvency channel backtests (D1/D2/D3)
    try:
        from .core import channel_backtests as _ch
        for inc_id, asset, scenario, channel in _ch.CHANNEL_INCIDENT_META:
            try:
                p = _ch.CHANNEL_INCIDENTS[inc_id]()
                rows = p.get("comparison_rows", [])
                incidents.append({
                    "id": inc_id, "type": "channel", "channel": channel, "asset": asset,
                    "date": p["event"]["date"], "scenario": scenario,
                    "description": p.get("ground_truth", {}).get("headline", p.get("headline", "")),
                    "has_archive_data": True,
                    "actual_bad_debt_usd": next((r["actual_usd"] for r in rows if r.get("unit") == "usd"), 0),
                    "actual_depeg_pct": round(p["event"]["delta"] * 100, 1),
                })
            except Exception:
                pass
    except Exception:
        pass
    return {"incidents": incidents}


@app.get("/api/contagion-live/assets")
def get_live_shockable_assets():
    """Shock targets (live): collateral TOKENS only (oracles are a separate endpoint so the
    UI can search tokens and shared oracles independently)."""
    try:
        return {"assets": _live.list_shockable_assets()}
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Morpho live fetch failed: {e}")


@app.get("/api/contagion-live/oracles")
def get_live_shockable_oracles():
    """Shared oracles (common-mode shock targets) — searched separately from tokens."""
    try:
        return {"assets": _live.list_shockable_oracles()}
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Morpho live fetch failed: {e}")


@app.get("/api/contagion-live/runnable-assets")
def get_live_runnable_assets():
    """Supplied (loan) assets on Morpho — selectable targets for a LIQUIDITY run."""
    try:
        return {"assets": _live.list_runnable_assets()}
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Morpho live fetch failed: {e}")


@app.get("/api/contagion-live")
def get_live_contagion(asset: str, delta: float = 0.5,
                       venues: str = "morpho,aave,spark,skycdp", recovery: Optional[float] = None,
                       downstream: bool = True, channel: str = "depeg",
                       freeze: str = "", naive: bool = False,
                       include_discovered: bool = False):
    """
    LIVE what-if contagion: shock `asset` by `delta` on CURRENT state.
    channel:
      - depeg     가격 depeg δ가 원인 → 자산 성질에 맞는 cascade(M1 흡수 + M2 fire-sale +
                  M3 오라클지연 + M4 인출런환류)를 자동 적용. 실제 사건형 시뮬.
      - liquidity 인출런 ρ (가격 사건 아님, delta=ρ) — 동결 자본.
      (legacy solvency|both|mint 값은 depeg로 매핑됨)
    naive=true: depeg의 M1 흡수 바닥값만(증폭 제외) — 반증 기준선.
    include_discovered=true: 이벤트로 발견한 숨은 cross-protocol 의존성(공유고래 co-presence·
            EOA bridge)을 전파 그래프에 별도 tier로 주입(선언 회계가 못 보는 경로). 행동기반·근사.
    freeze: csv of collateral symbols to FREEZE (governance blocker — absorbs but does not
            propagate, e.g. Aave freezing rsETH during kelp).
    Model levers: venues (csv: morpho,aave,spark,skycdp), recovery (0-1 liquidation
    recovery factor), downstream (tier-2 recursion on/off).
    """
    if not (0.0 < delta <= 1.0):
        raise HTTPException(status_code=400, detail="delta must be in (0,1]")
    # recovery=None → per-asset AUTO base (liquidation-mechanics derived); else manual override.
    if recovery is not None and not (0.0 < recovery <= 1.0):
        raise HTTPException(status_code=400, detail="recovery must be in (0,1]")
    # legacy single-price channels collapse into the unified depeg cascade
    if channel in ("solvency", "both", "mint", "depeg"):
        channel = "depeg"
    elif channel != "liquidity":
        raise HTTPException(status_code=400, detail="channel must be depeg|liquidity")
    vlist = tuple(v.strip() for v in venues.split(",") if v.strip())
    fset = frozenset(s.strip() for s in freeze.split(",") if s.strip())
    try:
        return _live.run_live_contagion(asset, delta, venues=vlist,
                                        recovery=recovery, downstream=downstream,
                                        channel=channel, freeze=fset, naive=naive,
                                        include_discovered=include_discovered)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/contagion/{incident_id}")
def get_contagion(incident_id: str, mode: str = "solvency"):
    """
    Cross-protocol contagion backtest: DebtRank propagate() on a historical dependency
    graph. Returns mode(s) + ground-truth comparison + ready-to-render topology/animation.
    No parameter fitting. incident_id: resolv_usr_depeg_2026_03 | kelp_2026_contagion.
    """
    try:
        return _contagion.contagion_payload(incident_id, mode=mode)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Unknown contagion incident: {incident_id}")
    except FileNotFoundError:
        raise HTTPException(status_code=503, detail="snapshot missing — run the build script")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/graph")
async def get_graph():
    # Serve cached enriched graph if user has already refreshed
    cached = get_cached_graph()
    if cached:
        # cached 그래프에도 모듈 그래프를 머지
        merged_nodes, merged_edges, _ = merge_module_graph(
            cached.get("nodes", []),
            cached.get("edges", []),
            {n["id"]: n.get("position", {"x": 0, "y": 0}) for n in cached.get("nodes", [])},
        )
        return {"nodes": merged_nodes, "edges": merged_edges}

    # Default: static graph (instant, no on-chain calls) + 본인 모듈 머지
    base_nodes_with_pos = [
        {**n, "position": NODE_POSITIONS.get(n["id"], {"x": 0, "y": 0})}
        for n in NODES
    ]
    merged_nodes, merged_edges, _ = merge_module_graph(
        base_nodes_with_pos, EDGES, NODE_POSITIONS,
    )
    return {"nodes": merged_nodes, "edges": merged_edges}


@app.get("/api/graph/module-status")
async def get_module_status():
    """디버깅: integration/output/simulator_graph.json 로딩 상태."""
    return get_module_summary()


# ─────────────────────────────────────────────────────────────────
# Phase 3 — Layer 2 동적 이벤트 수집/조회 API
# ─────────────────────────────────────────────────────────────────

_COLLECTORS = {
    "aave-v3": AaveCollector(),
    "lido": LidoCollector(),
    "morpho": MorphoCollector(),
    "sky": SkyCollector(),
}


class CollectRequest(BaseModel):
    from_block: int = 19000000
    to_block: int = 19000100


@app.post("/api/events/collect/{protocol}")
async def collect_events(protocol: str, req: CollectRequest):
    """
    프로토콜 폴러 1회 실행.

    Body:
      {"from_block": 19000000, "to_block": 19000100}

    AAVE_V3_SUBGRAPH_URL 환경변수 미설정 시 mock 모드로 데모 데이터 생성.
    """
    collector = _COLLECTORS.get(protocol)
    if collector is None:
        raise HTTPException(404, f"collector for '{protocol}' not registered")

    edges, result = await collector.collect(req.from_block, req.to_block)
    new_count = _event_store.save_edges(edges)
    result.new_edges = new_count
    # 실제 데이터 소스 (subgraph / mock / mock-fallback)
    result.source = (
        collector.get_source() if hasattr(collector, "get_source") else getattr(collector, "mode", "subgraph")
    )
    return {
        "protocol": result.protocol,
        "from_block": result.from_block,
        "to_block": result.to_block,
        "edges_collected": result.edges_collected,
        "new_edges_saved": result.new_edges,
        "duration_seconds": result.duration_seconds,
        "source": result.source,
        "error": result.error,
    }


@app.get("/api/events/collectors")
async def list_collectors():
    """등록된 collector 목록 + 각자의 모드/소스 + 폴링 상태."""
    out = []
    for proto, c in _COLLECTORS.items():
        out.append({
            "protocol": proto,
            "mode": getattr(c, "mode", "unknown"),
            "last_source": getattr(c, "get_source", lambda: "n/a")(),
            "subgraph_url_set": bool(os.getenv(f"{proto.upper().replace('-', '_')}_SUBGRAPH_URL", "")),
        })
    return {
        "collectors": out,
        "polling": _polling_stats,
    }


@app.get("/api/events/subgraph-health")
async def subgraph_health():
    """
    Phase 5 (작업 6) — 각 collector 의 subgraph URL 실제 작동 확인.
    URL 미설정이면 mock 모드 명시.
    """
    import time as _t
    import httpx
    results = []
    for proto, c in _COLLECTORS.items():
        url_var = f"{proto.upper().replace('-', '_')}_SUBGRAPH_URL"
        url = os.getenv(url_var, "").strip()
        if not url:
            results.append({
                "protocol": proto,
                "url_set": False,
                "status": "mock_mode",
                "message": f"{url_var} 미설정 — collector 는 mock 모드로 작동.",
            })
            continue

        # 간단 introspection query 로 작동 확인
        t0 = _t.time()
        try:
            async with httpx.AsyncClient(timeout=8.0) as client:
                resp = await client.post(
                    url,
                    json={"query": "{ _meta { block { number } } }"},
                )
                ok = resp.status_code == 200 and "errors" not in (resp.json() or {})
                results.append({
                    "protocol": proto,
                    "url_set": True,
                    "url_host": url.split("/")[2] if "://" in url else url,
                    "status": "ok" if ok else f"http_{resp.status_code}",
                    "latency_ms": round((_t.time() - t0) * 1000, 1),
                    "message": "subgraph 응답 정상" if ok else "subgraph 응답 비정상 (mock fallback 자동 작동)",
                })
        except Exception as e:
            results.append({
                "protocol": proto,
                "url_set": True,
                "status": "unreachable",
                "latency_ms": round((_t.time() - t0) * 1000, 1),
                "error": str(e)[:120],
                "message": "subgraph 도달 불가 — collector 는 mock fallback 으로 작동",
            })
    return {"checks": results}


@app.get("/api/events/by-address/{address}")
async def events_by_address(address: str, limit: int = 200):
    """주소가 from 또는 to 로 등장하는 모든 엣지."""
    return {
        "address": address.lower(),
        "edges": _event_store.get_edges_by_address(address, limit=limit),
    }


@app.get("/api/events/by-asset/{asset}")
async def events_by_asset(asset: str, limit: int = 200):
    """자산 주소로 필터링한 엣지."""
    return {
        "asset": asset.lower(),
        "edges": _event_store.get_edges_by_asset(asset, limit=limit),
    }


@app.get("/api/events/stats")
async def events_stats():
    """이벤트 저장소 통계."""
    return _event_store.get_stats()


@app.post("/api/events/clear")
async def events_clear():
    """이벤트 저장소 전체 삭제 (디버그)."""
    return {"deleted": _event_store.clear_all()}


# ─────────────────────────────────────────────────────────────────
# Phase 4 — Focus 통합 검색 API
# ─────────────────────────────────────────────────────────────────

@app.get("/api/focus")
async def focus_auto(q: str):
    """
    통합 입력 — 자동 감지 후 알맞은 핸들러 호출.
    - 0x... 64자 → tx
    - 0x... 40자 → address
    - 그 외       → token (symbol/id/label)
    """
    return _focus.auto_focus(q)


@app.get("/api/focus/address/{address}")
async def focus_address(address: str, limit: int = 100):
    return _focus.focus_address(address, event_limit=limit)


@app.get("/api/focus/token/{query}")
async def focus_token(query: str, limit: int = 100):
    return _focus.focus_token(query, event_limit=limit)


@app.get("/api/focus/tx/{tx_hash}")
async def focus_tx(tx_hash: str):
    return _focus.focus_tx(tx_hash)


@app.post("/api/focus/cache/invalidate")
async def focus_cache_invalidate(refresh: bool = True):
    """
    포커스/그래프 캐시 무효화.
    refresh=true (기본) → integration/module_loader 도 함께 재실행
                         (새 팀원 모듈 JSON 추가 시 호출하면 백엔드 재시작 불필요).
    """
    result = {"focus_cache": "invalidated"}
    if refresh:
        result["module_refresh"] = refresh_module_graph()
    _focus.invalidate_graph_cache()
    return result


# ─────────────────────────────────────────────────────────────────
# Phase 5 (작업 4) — Aave on-chain 자동 발견
# ─────────────────────────────────────────────────────────────────

@app.post("/api/discovery/aave/run")
async def discovery_aave_run():
    """
    RPC 로 Aave V3 Main reserves 자동 발견 →
    integration/output/discovered_nodes_edges.json 으로 저장 →
    module 그래프 자동 재로드.
    """
    discovery = await _aave_discovery.discover_aave_reserves()
    nodes = _aave_discovery.discovery_to_module_nodes(discovery)
    edges = _aave_discovery.discovery_to_module_edges(discovery)

    # Save to integration/output/
    out_path = ROOT / "integration" / "output" / "discovered_nodes_edges.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(
        json.dumps({"nodes": nodes, "edges": edges, "_meta": discovery}, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )

    # 자동 머지 (module_loader 재실행)
    refresh = refresh_module_graph()
    _focus.invalidate_graph_cache()

    return {
        "ok": True,
        "discovery": {
            "reserves_found": discovery.get("count", 0),
            "error": discovery.get("error"),
        },
        "saved_to": str(out_path),
        "refresh": refresh,
    }


class FlowRunRequest(BaseModel):
    from_block: int
    to_block: int


@app.post("/api/discovery/flows/run")
async def discovery_flows_run(req: FlowRunRequest):
    """
    Cross-protocol 간접 연결 발견.
    wstETH/weETH 가 알려진 프로토콜 주소들 사이를 이동하는 transfer 를 모니터링 →
    cross-protocol 흐름 엣지 생성 (간접 의존). discovered_flows.json 저장 + 그래프 머지.
    """
    discovery = await _flow_discovery.discover_flows(req.from_block, req.to_block)
    nodes = _flow_discovery.discovery_to_module_nodes(discovery)
    edges = _flow_discovery.discovery_to_module_edges(discovery)

    out_path = ROOT / "integration" / "output" / "discovered_flows.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(
        json.dumps({"nodes": nodes, "edges": edges, "_meta": discovery}, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )

    refresh = refresh_module_graph()
    _focus.invalidate_graph_cache()

    return {
        "ok": True,
        "discovery": {
            "flows_found": discovery.get("flows_count", 0),
            "block_range": [req.from_block, req.to_block],
            "error": discovery.get("error"),
        },
        "saved_to": str(out_path),
        "refresh": refresh,
    }


@app.post("/api/discovery/copresence/run")
async def discovery_copresence_run():
    """
    포지션 스냅샷 기반 공유 고래(co-presence) 발견.
    Aave subgraph + Morpho API 의 top holder 주소 교집합 → latent bridge (즉시, 이벤트 누적 불필요).
    """
    discovery = await _copresence_discovery.discover_copresence()
    nodes = _copresence_discovery.discovery_to_module_nodes(discovery)
    edges = _copresence_discovery.discovery_to_module_edges(discovery)

    out_path = ROOT / "integration" / "output" / "discovered_copresence.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(
        json.dumps({"nodes": nodes, "edges": edges, "_meta": discovery}, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )

    refresh = refresh_module_graph()
    _focus.invalidate_graph_cache()

    return {
        "ok": True,
        "discovery": {
            "aave_holders": discovery.get("aave_holders", 0),
            "morpho_holders": discovery.get("morpho_holders", 0),
            "bridges": discovery.get("bridges", []),
            "error": discovery.get("error"),
        },
        "saved_to": str(out_path),
        "refresh": refresh,
    }


@app.post("/api/discovery/eoa-bridges/run")
async def discovery_eoa_bridges_run():
    """
    고래(EOA) 행동 기반 cross-protocol bridge 발견.
    event_store 의 프로토콜별 EOA 활동을 join → latent(공존)/realized(실제 이동) 엣지.
    mock 데이터 제외.
    """
    discovery = _eoa_bridge_discovery.discover_eoa_bridges()
    nodes = _eoa_bridge_discovery.discovery_to_module_nodes(discovery)
    edges = _eoa_bridge_discovery.discovery_to_module_edges(discovery)

    out_path = ROOT / "integration" / "output" / "discovered_eoa_bridges.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(
        json.dumps({"nodes": nodes, "edges": edges, "_meta": discovery}, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )

    refresh = refresh_module_graph()
    _focus.invalidate_graph_cache()

    return {
        "ok": True,
        "discovery": {
            "bridges_found": discovery.get("bridges_count", 0),
            "real_edges_scanned": discovery.get("total_real_edges_scanned", 0),
            "bridges": discovery.get("bridges", []),
            "error": discovery.get("error"),
        },
        "saved_to": str(out_path),
        "refresh": refresh,
    }


@app.post("/api/discovery/pendle/run")
async def discovery_pendle_run():
    """
    Pendle active markets 를 공개 API 로 발견 → SY/PT/YT/Market 노드 +
    underlying wrap/split 엣지 생성. discovered_pendle.json 저장 + 그래프 머지.
    """
    discovery = await _pendle_discovery.discover_pendle()
    nodes = _pendle_discovery.discovery_to_module_nodes(discovery)
    edges = _pendle_discovery.discovery_to_module_edges(discovery)

    out_path = ROOT / "integration" / "output" / "discovered_pendle.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(
        json.dumps({"nodes": nodes, "edges": edges, "_meta": discovery}, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )

    refresh = refresh_module_graph()
    _focus.invalidate_graph_cache()

    return {
        "ok": True,
        "discovery": {
            "markets_found": discovery.get("markets_count", 0),
            "nodes_created": len(nodes),
            "edges_created": len(edges),
            "error": discovery.get("error"),
        },
        "saved_to": str(out_path),
        "refresh": refresh,
    }


@app.post("/api/discovery/morpho/run")
async def discovery_morpho_run():
    """
    Morpho Blue 의 top markets + top vaults 를 GraphQL API 로 발견 →
    integration/output/discovered_morpho.json 으로 저장 →
    module 그래프 자동 재로드.
    """
    discovery = await _morpho_discovery.discover_morpho()
    nodes = _morpho_discovery.discovery_to_module_nodes(discovery)
    edges = _morpho_discovery.discovery_to_module_edges(discovery)

    out_path = ROOT / "integration" / "output" / "discovered_morpho.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(
        json.dumps({"nodes": nodes, "edges": edges, "_meta": discovery}, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )

    refresh = refresh_module_graph()
    _focus.invalidate_graph_cache()

    return {
        "ok": True,
        "discovery": {
            "markets_found": discovery.get("markets_count", 0),
            "vaults_found": discovery.get("vaults_count", 0),
            "error": discovery.get("error"),
        },
        "saved_to": str(out_path),
        "refresh": refresh,
    }


@app.post("/api/discovery/consumers/run")
async def discovery_consumers_run():
    """
    Generic token×consumer balance scanner.
    shared/address_book.json (tokens) × shared/consumer_registry.json (consumers) 모든 쌍에
    RPC balanceOf 호출 → 보유 관계 edges 자동 생성.

    Lido / Curve / Balancer / EigenLayer / Compound 등 token consumer 들이
    수동 instances.json 없이 그래프에 자동 연결됨.
    """
    discovery = await _consumer_discovery.discover_consumers()
    nodes = _consumer_discovery.discovery_to_module_nodes(discovery)
    edges = _consumer_discovery.discovery_to_module_edges(discovery)

    out_path = ROOT / "integration" / "output" / "discovered_consumers.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(
        json.dumps({"nodes": nodes, "edges": edges, "_meta": discovery}, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )

    refresh = refresh_module_graph()
    _focus.invalidate_graph_cache()

    return {
        "ok": True,
        "discovery": {
            "tokens_count": discovery.get("tokens_count", 0),
            "consumers_count": discovery.get("consumers_count", 0),
            "pairs_checked": discovery.get("pairs_checked", 0),
            "holdings_count": discovery.get("holdings_count", 0),
            "error": discovery.get("error"),
        },
        "saved_to": str(out_path),
        "refresh": refresh,
    }


@app.get("/api/discovery/morpho/status")
async def discovery_morpho_status():
    """디버깅: 마지막 morpho 발견 결과 요약."""
    discovery = await _morpho_discovery.discover_morpho()
    return {
        "discovered_at": discovery.get("discovered_at"),
        "markets_count": discovery.get("markets_count", 0),
        "vaults_count": discovery.get("vaults_count", 0),
        "error": discovery.get("error"),
    }


@app.get("/api/discovery/aave/status")
async def discovery_aave_status():
    """디버깅: 마지막 발견 시각 + reserve 수."""
    discovery = await _aave_discovery.discover_aave_reserves()
    return {
        "discovered_at": discovery.get("discovered_at"),
        "market_id": discovery.get("market_id"),
        "reserves_count": discovery.get("count", 0),
        "error": discovery.get("error"),
        "alchemy_key_set": bool(_aave_discovery.ALCHEMY_KEY),
        "last_seen_reserves_count": _last_reserves_count,
        "new_reserves_history": _new_reserves_history[-10:],  # 최근 10건
    }


@app.get("/api/focus/suggestions")
async def focus_suggestions(q: str = "", limit: int = 8):
    """입력 자동완성 — 토큰 심볼 / 라벨 prefix 매칭."""
    g = _focus._get_full_graph()
    q_lower = (q or "").lower().strip()
    out: list[dict] = []
    seen_ids: set = set()

    def _add(node: dict, score: int) -> None:
        if node["id"] in seen_ids:
            return
        seen_ids.add(node["id"])
        data = node.get("data") or {}
        out.append({
            "id": node["id"],
            "label": node.get("label", node["id"]),
            "type": node.get("type"),
            "symbol": data.get("symbol"),
            "category": data.get("category"),
            "score": score,
        })

    # 1) 정확 symbol match (highest)
    if q_lower:
        for n in g["nodes"]:
            sym = (n.get("data") or {}).get("symbol", "")
            if sym and sym.lower() == q_lower:
                _add(n, 100)
        # 2) symbol prefix
        for n in g["nodes"]:
            sym = (n.get("data") or {}).get("symbol", "")
            if sym and sym.lower().startswith(q_lower):
                _add(n, 80)
        # 3) label substring (토큰/오라클 우선)
        for n in g["nodes"]:
            if n.get("type") in ("token", "oracle"):
                if q_lower in n.get("label", "").lower():
                    _add(n, 60)
        # 4) label substring (모든 노드)
        for n in g["nodes"]:
            if q_lower in n.get("label", "").lower():
                _add(n, 40)
    else:
        # 빈 입력 — 인기 토큰들 default 추천
        defaults = ["wsteth", "weeth", "weth", "usdc", "gho", "steth", "cbeth"]
        for d in defaults:
            for n in g["nodes"]:
                if n["id"] == d:
                    _add(n, 50)

    out.sort(key=lambda x: -x["score"])
    return {"q": q, "suggestions": out[:limit]}


@app.post("/api/graph/refresh")
async def refresh_graph():
    """
    User-triggered: re-discover graph topology from on-chain + DeFiLlama.
    Returns the full enriched graph so the client can apply it immediately.
    """
    graph = await build_dynamic_graph(use_cache=False)
    return graph




@app.get("/api/wallet/{address}/portfolio")
async def get_wallet_portfolio(address: str):
    """
    LST/LRT portfolio scan: balanceOf for 13 tokens + Aave V3 aToken deposits.
    Uses DeBank Cloud API if DEBANK_ACCESS_KEY env var is set; otherwise eth_call.
    """
    from re import match
    if not match(r"^0x[0-9a-fA-F]{40}$", address):
        raise HTTPException(status_code=400, detail="유효하지 않은 이더리움 주소")
    result = await fetch_wallet_portfolio(address)
    return result


@app.get("/api/wallet/{address}/portfolio-simulate")
async def portfolio_simulate(address: str, scenarios: Optional[str] = None):
    """
    P0-3: Run multi-asset scenario simulation on a wallet's Aave V3 portfolio.

    Query params:
      scenarios: comma-separated scenario names (e.g. "bridge_hack,lido_validator_slashing").
                 If omitted, runs all scenarios applicable to the wallet's primary asset family.
    """
    from .core.portfolio_simulate import simulate_portfolio
    filter_list = [s.strip() for s in scenarios.split(",")] if scenarios else None
    try:
        return await simulate_portfolio(address, scenarios_filter=filter_list)
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))


@app.get("/api/wallet/{address}/position")
async def get_wallet_position(address: str):
    """
    Returns an individual wallet's Aave V3 rsETH position with scenario risk.
    Two eth_call calls: getUserAccountData + getUserReserveData(rsETH, address).
    """
    try:
        stats = await get_live_stats()
    except Exception as e:
        raise HTTPException(
            status_code=503,
            detail=f"Live oracle unavailable — cannot compute wallet position without fresh price. {e}",
        )

    result = await fetch_wallet_position(address, stats.oracle_price_usd)
    if "error" in result:
        raise HTTPException(status_code=400, detail=result["error"])
    return result
