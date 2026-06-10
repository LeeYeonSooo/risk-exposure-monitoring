"""
EventStore — 수집된 동적 엣지를 SQLite 에 적재 / 조회.

Phase 3 PoC 용 단순 저장소. Phase 4 가 토큰/주소 포커스 쿼리에 사용.
프로덕션은 PostgreSQL 권장.
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Optional

from .base import DynamicEdge

_DB_PATH = Path(__file__).resolve().parent.parent.parent / "data" / "events.db"


def _conn() -> sqlite3.Connection:
    _DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(_DB_PATH))
    conn.row_factory = sqlite3.Row
    return conn


def init_schema() -> None:
    with _conn() as c:
        c.execute("""
        CREATE TABLE IF NOT EXISTS edges (
            edge_id TEXT PRIMARY KEY,
            edge_type TEXT NOT NULL,
            from_address TEXT NOT NULL,
            to_address TEXT NOT NULL,
            asset TEXT,
            amount_raw TEXT,
            amount_decimal REAL,
            block_number INTEGER,
            tx_hash TEXT,
            log_index INTEGER,
            timestamp INTEGER,
            protocol TEXT NOT NULL,
            market_id TEXT,
            metadata_json TEXT
        )
        """)
        for col in ("from_address", "to_address", "asset", "protocol", "block_number"):
            c.execute(f"CREATE INDEX IF NOT EXISTS idx_edges_{col} ON edges({col})")


def save_edges(edges: list[DynamicEdge]) -> int:
    """엣지들을 적재. PRIMARY KEY 충돌 (이미 있는 edge_id) 은 skip. 새로 적재된 개수 반환."""
    init_schema()
    new_count = 0
    with _conn() as c:
        for e in edges:
            try:
                c.execute("""
                INSERT INTO edges
                  (edge_id, edge_type, from_address, to_address, asset,
                   amount_raw, amount_decimal, block_number, tx_hash, log_index,
                   timestamp, protocol, market_id, metadata_json)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (
                    e.edge_id, e.edge_type, e.from_address, e.to_address, e.asset,
                    e.amount_raw, e.amount_decimal, e.block_number, e.tx_hash, e.log_index,
                    e.timestamp, e.protocol, e.market_id, json.dumps(e.metadata, ensure_ascii=False),
                ))
                new_count += 1
            except sqlite3.IntegrityError:
                # 중복 edge_id — skip
                pass
    return new_count


def _row_to_dict(row: sqlite3.Row) -> dict:
    d = dict(row)
    try:
        d["metadata"] = json.loads(d.pop("metadata_json") or "{}")
    except Exception:
        d["metadata"] = {}
    return d


def get_edges_by_address(address: str, limit: int = 200) -> list[dict]:
    address = (address or "").lower()
    init_schema()
    with _conn() as c:
        rows = c.execute("""
            SELECT * FROM edges
            WHERE from_address = ? OR to_address = ?
            ORDER BY block_number DESC, log_index DESC
            LIMIT ?
        """, (address, address, limit)).fetchall()
    return [_row_to_dict(r) for r in rows]


def get_edges_by_asset(asset: str, limit: int = 200) -> list[dict]:
    asset = (asset or "").lower()
    init_schema()
    with _conn() as c:
        rows = c.execute("""
            SELECT * FROM edges
            WHERE asset = ?
            ORDER BY block_number DESC, log_index DESC
            LIMIT ?
        """, (asset, limit)).fetchall()
    return [_row_to_dict(r) for r in rows]


def get_stats() -> dict:
    init_schema()
    with _conn() as c:
        total = c.execute("SELECT COUNT(*) FROM edges").fetchone()[0]
        by_type = c.execute("""
            SELECT edge_type, COUNT(*) AS n FROM edges GROUP BY edge_type ORDER BY n DESC
        """).fetchall()
        by_protocol = c.execute("""
            SELECT protocol, COUNT(*) AS n FROM edges GROUP BY protocol ORDER BY n DESC
        """).fetchall()
        block_range = c.execute("""
            SELECT MIN(block_number) AS min_b, MAX(block_number) AS max_b FROM edges
        """).fetchone()
        unique_addrs = c.execute("""
            SELECT COUNT(*) FROM (
              SELECT from_address AS a FROM edges
              UNION
              SELECT to_address AS a FROM edges
            )
        """).fetchone()[0]
    return {
        "total_edges": total,
        "unique_addresses": unique_addrs,
        "by_type": [{"type": r[0], "count": r[1]} for r in by_type],
        "by_protocol": [{"protocol": r[0], "count": r[1]} for r in by_protocol],
        "block_range": {"min": block_range["min_b"], "max": block_range["max_b"]},
        "db_path": str(_DB_PATH),
    }


def clear_all() -> int:
    """테이블 전체 삭제 (디버그/리셋용). 삭제된 행 수 반환."""
    init_schema()
    with _conn() as c:
        n = c.execute("SELECT COUNT(*) FROM edges").fetchone()[0]
        c.execute("DELETE FROM edges")
    return n
