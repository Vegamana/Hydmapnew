#!/usr/bin/env python3
"""analytics.py — nightly rollup into area_stats.

Answers the two questions the map cannot answer per-pixel:
  * what does a flat actually cost in this locality
  * where is supply concentrated

Localities come from a static polygon-free lookup: each listing is assigned to
the nearest named centre within 3.5 km (PostGIS distance, not a bounding box),
which is accurate enough for a rent average and costs no geocoding calls.
Anything further than that stays unassigned rather than being forced into the
wrong neighbourhood.

Sale prices are excluded from rent averages everywhere. Mixing a ₹95,00,000
sale into a ₹32,000 rent average is the classic way to make this number useless.

Usage:
    python -m jobs.analytics                 # recompute area_stats
    python -m jobs.analytics --report        # also print a summary table
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from lib.db import connect, execute, query
from lib.log import get_logger

log = get_logger("analytics")

MAX_ASSIGN_METRES = 3500

LOCALITIES: list[tuple[str, float, float]] = [
    ("Hitec City", 17.4485, 78.3908), ("Gachibowli", 17.4400, 78.3489),
    ("Kondapur", 17.4615, 78.3600),   ("Madhapur", 17.4483, 78.3915),
    ("Kukatpally", 17.4948, 78.3996), ("Miyapur", 17.4960, 78.3580),
    ("Ameerpet", 17.4374, 78.4487),   ("Begumpet", 17.4400, 78.4600),
    ("Banjara Hills", 17.4126, 78.4370), ("Jubilee Hills", 17.4310, 78.4070),
    ("Manikonda", 17.4040, 78.3690),  ("Kokapet", 17.4100, 78.3300),
    ("Secunderabad", 17.4399, 78.4983), ("Uppal", 17.3980, 78.5590),
    ("LB Nagar", 17.3510, 78.5520),   ("Attapur", 17.3650, 78.4270),
    ("Nallagandla", 17.4700, 78.3100), ("Bachupally", 17.5480, 78.3830),
    ("Charminar", 17.3616, 78.4747),  ("Kompally", 17.5400, 78.4870),
]


def assign_localities(conn) -> int:
    """Nearest named centre within MAX_ASSIGN_METRES, via the geography index.
    Centres are passed as arrays and unnested, so nothing is string-interpolated
    into the SQL."""
    names = [name for name, _, _ in LOCALITIES]
    lats = [lat for _, lat, _ in LOCALITIES]
    lngs = [lng for _, _, lng in LOCALITIES]

    return execute(conn, """
        with centres as (
          select * from unnest(%(names)s::text[], %(lats)s::float8[], %(lngs)s::float8[])
                       as t(name, lat, lng)
        ),
        nearest as (
          select l.id,
                 (select c.name
                    from centres c
                   where ST_DWithin(l.geog,
                                    ST_SetSRID(ST_MakePoint(c.lng, c.lat), 4326)::geography,
                                    %(max_m)s)
                order by l.geog <-> ST_SetSRID(ST_MakePoint(c.lng, c.lat), 4326)::geography
                   limit 1) as locality
            from listings l
           where l.status = 'active'
        )
        update listings l
           set locality = n.locality
          from nearest n
         where l.id = n.id
           and l.locality is distinct from n.locality
    """, {"names": names, "lats": lats, "lngs": lngs, "max_m": MAX_ASSIGN_METRES})


def rebuild_area_stats(conn) -> int:
    """Median as well as mean: rent distributions are skewed and the median is
    the number a renter should actually plan around."""
    return execute(conn, """
        insert into area_stats (locality, lat, lng, listing_count, avg_rent, median_rent, density_km2, computed_at)
        select l.locality,
               avg(l.lat), avg(l.lng),
               count(*)::int,
               round(avg(l.price) filter (where l.type in ('rent','sharing','rent_paid'))),
               round((percentile_cont(0.5) within group (
                        order by l.price) filter (where l.type in ('rent','sharing','rent_paid')))::numeric),
               round((count(*) / greatest(
                        ST_Area(ST_ConvexHull(ST_Collect(l.geog::geometry))::geography) / 1000000.0,
                        0.25))::numeric, 3),
               now()
          from listings l
         where l.status = 'active' and l.locality is not null
         group by l.locality
        on conflict (locality) do update
           set lat = excluded.lat, lng = excluded.lng,
               listing_count = excluded.listing_count,
               avg_rent = excluded.avg_rent,
               median_rent = excluded.median_rent,
               density_km2 = excluded.density_km2,
               computed_at = excluded.computed_at
    """)


def funnel(conn) -> dict:
    """Operational health, printed to the cron log every night."""
    rows = query(conn, """
        select
          (select count(*) from listings  where status = 'active')                             as active_listings,
          (select count(*) from listings  where status = 'rented')                             as rented_listings,
          (select count(*) from listings  where status = 'expired')                            as expired_listings,
          (select count(*) from interests where created_at > now() - interval '7 days')        as interests_7d,
          (select count(*) from interests where created_at > now() - interval '7 days'
                                           and payment_status = 'success')                     as paid_7d,
          (select count(*) from interests where email_sent_at is null
                                           and created_at < now() - interval '1 hour')         as undelivered,
          (select count(*) from email_events where sent_at > now() - interval '30 days')       as mails_30d,
          (select count(*) from email_events where sent_at > now() - interval '30 days'
                                              and replied_at is not null)                      as replies_30d,
          (select count(*) from places_cache)                                                  as cache_rows,
          (select coalesce(sum(hit_count), 0) from places_cache)                               as cache_hits
    """)
    return rows[0]


def main() -> None:
    parser = argparse.ArgumentParser(description="Recompute locality statistics.")
    parser.add_argument("--report", action="store_true", help="print the stats table")
    parser.add_argument("--export", type=str, help="also write JSON to this path")
    args = parser.parse_args()

    with connect() as conn:
        tagged = assign_localities(conn)
        rows = rebuild_area_stats(conn)
        stats = funnel(conn)

        log.info("tagged %d listings, refreshed %d localities", tagged, rows)
        log.info(
            "active=%(active_listings)d rented=%(rented_listings)d expired=%(expired_listings)d "
            "interests_7d=%(interests_7d)d paid_7d=%(paid_7d)d undelivered=%(undelivered)d",
            stats,
        )
        reply_rate = (stats["replies_30d"] / stats["mails_30d"] * 100) if stats["mails_30d"] else 0
        cache_hits = stats["cache_hits"]
        log.info("email reply rate 30d: %.1f%% | cache rows=%d hits=%d (saved calls)",
                 reply_rate, stats["cache_rows"], cache_hits)

        if args.report or args.export:
            table = query(conn, """
                select locality, listing_count, avg_rent, median_rent, density_km2
                from area_stats order by listing_count desc
            """)
            if args.report:
                print(f"\n{'Locality':<16}{'Posts':>7}{'Avg rent':>12}{'Median':>10}{'Per km2':>10}")
                print("-" * 55)
                for r in table:
                    print(f"{r['locality']:<16}{r['listing_count']:>7}"
                          f"{('₹' + format(int(r['avg_rent']), ',')) if r['avg_rent'] else '—':>12}"
                          f"{('₹' + format(int(r['median_rent']), ',')) if r['median_rent'] else '—':>10}"
                          f"{float(r['density_km2'] or 0):>10.2f}")
                print()
            if args.export:
                path = Path(args.export)
                path.write_text(json.dumps([dict(r) for r in table], default=str, indent=2), encoding="utf-8")
                log.info("wrote %s", path)


if __name__ == "__main__":
    main()
