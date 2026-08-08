#!/usr/bin/env python3
"""aging_posts.py — keep the map honest.

Runs once a day, early morning IST. A listing is stale if nobody has confirmed
it in a while, so at 60, 90 and 120 days since last confirmation the owner gets
one email with two buttons: "Still available" or "It is rented".

  * reminder_stage on the listing records the last stage delivered, so an owner
    never gets the same reminder twice.
  * Replying "available" resets last_confirmed_at and reminder_stage to 0,
    which restarts the whole ladder from that date.
  * At 150 days with no answer at any stage, the listing is marked expired.
    Silence is treated as "probably gone" only after four ignored attempts.

Usage:
    python -m jobs.aging_posts
    python -m jobs.aging_posts --stages 60 90 --limit 25 --dry-run
"""
from __future__ import annotations

import argparse

from lib.config import settings
from lib.db import connect, execute, query
from lib.log import get_logger
from lib.mailer import render, reserve_token, send

log = get_logger("aging_posts")

DEFAULT_STAGES = (60, 90, 120)
EXPIRE_AFTER_DAYS = 150


def inr(value: float | int) -> str:
    """Indian digit grouping: 3,25,000 rather than 325,000. Python's locale
    module cannot be relied on inside a container, so group by hand."""
    digits = str(int(value))
    if len(digits) <= 3:
        return f"\u20b9{digits}"
    head, tail = digits[:-3], digits[-3:]
    groups = []
    while len(head) > 2:
        groups.insert(0, head[-2:])
        head = head[:-2]
    if head:
        groups.insert(0, head)
    return "\u20b9" + ",".join(groups + [tail])


def due_listings(conn, stage: int, limit: int) -> list[dict]:
    """Listings that crossed `stage` days since last confirmation and have not
    yet been sent this stage. The interest count goes in the email so the owner
    sees why keeping it accurate matters."""
    return query(conn, """
        select l.id, l.title, l.price, l.type, l.owner_email, l.locality,
               extract(day from now() - l.last_confirmed_at)::int as age_days,
               (select count(*) from interests i where i.listing_id = l.id) as interest_count
        from listings l
        where l.status = 'active'
          and l.reminder_stage < %(stage)s
          and l.last_confirmed_at < now() - make_interval(days => %(stage)s)
          and l.last_confirmed_at >= now() - make_interval(days => %(next_stage)s)
        order by l.last_confirmed_at
        limit %(limit)s
    """, {"stage": stage, "next_stage": stage + 30, "limit": limit})


def send_reminder(conn, listing: dict, stage: int) -> bool:
    event = reserve_token(
        conn,
        kind="aging_reminder",
        to_email=listing["owner_email"],
        listing_id=str(listing["id"]),
    )
    token = event["token"]

    price = inr(listing["price"])
    subject = f"[HPM-{token}] Still available? {listing['title']} (day {stage})"

    context = {
        "listing_title": listing["title"],
        "price": price,
        "days": stage,
        "interest_line": (
            f"and has had {listing['interest_count']} "
            f"{'enquiry' if listing['interest_count'] == 1 else 'enquiries'}"
            if listing["interest_count"] else "with no enquiries yet"
        ),
        "available_url": f"{settings.action_base}?token={token}&action=available",
        "rented_url": f"{settings.action_base}?token={token}&action=rented",
        "map_url": f"{settings.site_url}/?listing={listing['id']}",
    }

    html_body = render("aging_reminder.html", **context)
    text_body = (
        f"Is \"{listing['title']}\" still available? (day {stage}, {price})\n\n"
        f"Still available: {context['available_url']}\n"
        f"It is rented:    {context['rented_url']}\n\n"
        f'Or reply to this email with "available" or "rented".\n'
    )

    try:
        send(conn, to=listing["owner_email"], subject=subject, html_body=html_body,
             text_body=text_body, event_id=event["id"], kind="aging_reminder")
    except Exception as exc:  # noqa: BLE001
        log.error("reminder failed for %s: %s", listing["id"], exc)
        return False

    if not settings.dry_run:
        execute(conn, "update listings set reminder_stage = %s where id = %s", (stage, listing["id"]))
    return True


def expire_silent_listings(conn) -> int:
    """Four ignored reminders is an answer."""
    return execute(conn, """
        update listings
           set status = 'expired'
         where status = 'active'
           and reminder_stage >= 120
           and last_confirmed_at < now() - make_interval(days => %s)
    """, (EXPIRE_AFTER_DAYS,))


def main() -> None:
    parser = argparse.ArgumentParser(description="Send aging reminders to listing owners.")
    parser.add_argument("--stages", type=int, nargs="+", default=list(DEFAULT_STAGES))
    parser.add_argument("--limit", type=int, default=200, help="max emails per stage per run")
    parser.add_argument("--dry-run", action="store_true", help="log instead of sending")
    args = parser.parse_args()

    if args.dry_run:
        object.__setattr__(settings, "dry_run", True)

    total = 0
    with connect() as conn:
        # Oldest stage first: a 130-day-old listing should get the 120 mail, not the 60 one.
        for stage in sorted(args.stages, reverse=True):
            listings = due_listings(conn, stage, args.limit)
            log.info("stage %d: %d listings due", stage, len(listings))
            for listing in listings:
                if send_reminder(conn, listing, stage):
                    total += 1

        expired = expire_silent_listings(conn)
        log.info("sent %d reminders, expired %d silent listings", total, expired)


if __name__ == "__main__":
    main()
