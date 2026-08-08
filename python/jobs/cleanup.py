#!/usr/bin/env python3
"""cleanup.py — weekly housekeeping.

Drops cache rows that expired more than a week ago and prunes email_events for
listings that no longer exist. Small table, fast queries, predictable costs.

Usage:
    python -m jobs.cleanup
"""
from __future__ import annotations

from lib.db import connect, execute
from lib.log import get_logger

log = get_logger("cleanup")


def main() -> None:
    with connect() as conn:
        stale_cache = execute(conn, """
            delete from places_cache where expires_at < now() - interval '7 days'
        """)
        old_events = execute(conn, """
            delete from email_events
             where sent_at < now() - interval '18 months'
               and replied_at is null
        """)
        log.info("removed %d expired cache rows and %d old email events", stale_cache, old_events)


if __name__ == "__main__":
    main()
