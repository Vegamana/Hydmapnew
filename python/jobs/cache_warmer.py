#!/usr/bin/env python3
"""cache_warmer.py — pay for Google Places at 4 a.m. instead of at click time.

Two sources of work:

  1. A fixed seed list of Hyderabad localities where listings actually cluster.
  2. Whatever the data says is popular: any cache row with a high hit_count that
     is close to expiring gets refreshed before a user finds it cold.

It also warms the neighbourhood *around* every active listing, because "nearby
places" is opened from a listing popup far more often than from empty map.

Every write goes through the same edge function the browser uses, so the cache
key derivation, radius ladder and field mask can never drift between the two.

Usage:
    python -m jobs.cache_warmer                     # seeds + popular + listings
    python -m jobs.cache_warmer --only seeds --types biryani gym
    python -m jobs.cache_warmer --budget 150        # hard ceiling on API calls
"""
from __future__ import annotations

import argparse
import time

import httpx

from lib.config import settings
from lib.db import connect, query
from lib.log import get_logger

log = get_logger("cache_warmer")

TYPES = ("biryani", "gym", "hospital")
RADIUS = 1500
CALL_DELAY_SECONDS = 0.25   # stay well inside Places QPS limits

# Where supply and searches concentrate. Coordinates snapped to 3 decimals so
# they land on the same cache keys the frontend will generate.
SEED_LOCATIONS: list[tuple[str, float, float]] = [
    ("Hitec City",    17.448, 78.391),
    ("Gachibowli",    17.440, 78.349),
    ("Kondapur",      17.462, 78.360),
    ("Madhapur",      17.448, 78.392),
    ("Kukatpally",    17.494, 78.399),
    ("Miyapur",       17.496, 78.358),
    ("Ameerpet",      17.437, 78.449),
    ("Begumpet",      17.440, 78.460),
    ("Banjara Hills", 17.412, 78.437),
    ("Jubilee Hills", 17.431, 78.407),
    ("Manikonda",     17.404, 78.369),
    ("Kokapet",       17.410, 78.330),
    ("Secunderabad",  17.440, 78.498),
    ("Uppal",         17.398, 78.559),
    ("LB Nagar",      17.351, 78.552),
    ("Attapur",       17.365, 78.427),
    ("Nallagandla",   17.470, 78.310),
    ("Bachupally",    17.548, 78.383),
]


def popular_targets(conn, limit: int = 60) -> list[tuple[str, float, float, int]]:
    """Rows people keep asking for that will go cold within a week."""
    rows = query(conn, """
        select type, lat, lng, radius, hit_count
        from places_cache
        where expires_at < now() + interval '7 days'
          and hit_count >= 3
          and type <> 'aqi'
        order by hit_count desc
        limit %s
    """, (limit,))
    return [(r["type"], float(r["lat"]), float(r["lng"]), int(r["radius"])) for r in rows]


def listing_targets(conn, limit: int = 200) -> list[tuple[float, float]]:
    """One warm-up point per active listing, deduplicated onto the 3-decimal
    cache grid so a whole apartment block costs one call, not forty."""
    rows = query(conn, """
        select distinct round(lat::numeric, 3) as lat, round(lng::numeric, 3) as lng
        from listings
        where status = 'active'
        limit %s
    """, (limit,))
    return [(float(r["lat"]), float(r["lng"])) for r in rows]


def warm(client: httpx.Client, place_type: str, lat: float, lng: float, radius: int) -> str:
    """Returns 'cache' | 'google' | 'error'. Only 'google' costs money."""
    try:
        res = client.post(
            f"{settings.supabase_url}/functions/v1/fetch_places_with_cache",
            headers={
                "Authorization": f"Bearer {settings.service_role_key}",
                "Content-Type": "application/json",
            },
            json={"type": place_type, "lat": lat, "lng": lng, "radius": radius},
        )
        if res.status_code != 200:
            log.error("warm failed %s@%s,%s: %s %s", place_type, lat, lng, res.status_code, res.text[:160])
            return "error"
        return res.json().get("source", "unknown")
    except Exception as exc:  # noqa: BLE001
        log.error("warm crashed %s@%s,%s: %s", place_type, lat, lng, exc)
        return "error"


def main() -> None:
    parser = argparse.ArgumentParser(description="Pre-fetch Google Places data into the cache.")
    parser.add_argument("--types", nargs="+", default=list(TYPES))
    parser.add_argument("--only", choices=["seeds", "popular", "listings"], help="run one source only")
    parser.add_argument("--budget", type=int, default=400, help="max fresh Google calls this run")
    args = parser.parse_args()

    targets: list[tuple[str, float, float, int]] = []

    with connect() as conn:
        if args.only in (None, "seeds"):
            for name, lat, lng in SEED_LOCATIONS:
                for t in args.types:
                    targets.append((t, lat, lng, RADIUS))
            log.info("queued %d seed targets", len(SEED_LOCATIONS) * len(args.types))

        if args.only in (None, "popular"):
            popular = popular_targets(conn)
            targets.extend(popular)
            log.info("queued %d expiring-popular targets", len(popular))

        if args.only in (None, "listings"):
            points = listing_targets(conn)
            for lat, lng in points:
                for t in args.types:
                    targets.append((t, lat, lng, RADIUS))
            log.info("queued %d listing neighbourhoods", len(points))

    # Deduplicate before spending anything.
    seen: set[tuple] = set()
    unique = []
    for t in targets:
        key = (t[0], round(t[1], 3), round(t[2], 3), t[3])
        if key not in seen:
            seen.add(key)
            unique.append(t)

    log.info("%d unique targets after dedupe", len(unique))

    counts = {"cache": 0, "google": 0, "error": 0, "unknown": 0}
    with httpx.Client(timeout=30) as client:
        for place_type, lat, lng, radius in unique:
            if counts["google"] >= args.budget:
                log.warning("budget of %d fresh calls reached — stopping", args.budget)
                break
            source = warm(client, place_type, lat, lng, radius)
            counts[source] = counts.get(source, 0) + 1
            if source == "google":
                time.sleep(CALL_DELAY_SECONDS)

    log.info("done: %d already cached, %d fetched from Google, %d errors",
             counts["cache"], counts["google"], counts["error"])


if __name__ == "__main__":
    main()
