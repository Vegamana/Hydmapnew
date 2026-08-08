"""Postgres access. psycopg 3 with a short-lived connection per job run —
these are cron jobs, not a server, so a pool would just hold sockets open."""
from __future__ import annotations

from contextlib import contextmanager
from typing import Any, Iterator, Sequence

import psycopg
from psycopg.rows import dict_row

from .config import settings


@contextmanager
def connect() -> Iterator[psycopg.Connection]:
    conn = psycopg.connect(settings.database_url, row_factory=dict_row, connect_timeout=10)
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def query(conn: psycopg.Connection, sql: str, params: Sequence[Any] | dict | None = None) -> list[dict]:
    with conn.cursor() as cur:
        cur.execute(sql, params)
        return cur.fetchall() if cur.description else []


def execute(conn: psycopg.Connection, sql: str, params: Sequence[Any] | dict | None = None) -> int:
    with conn.cursor() as cur:
        cur.execute(sql, params)
        return cur.rowcount
