#!/usr/bin/env python3
"""email_processor.py — turn owner replies into database state.

Runs every 15 minutes. Two responsibilities:

  1. Read unseen mail over IMAP. Every message we send carries a token in the
     subject line as [HPM-<token>]; a reply keeps that token in "Re: ...", which
     is how a free-text reply gets attached to the right listing without any
     login, thread ID, or plus-addressing setup.

     Intent is classified from the first few lines of the reply body:
        "still available", "yes available", "open"   -> available
        "rented", "gone", "taken", "let out"          -> rented
     Anything else is stored as 'unknown' and left alone. This job never guesses.

  2. Sweep interests whose notification email failed at submission time and
     retry them, so a Resend outage costs a delay rather than a lead.

Usage:
    python -m jobs.email_processor            # process + retry
    python -m jobs.email_processor --retries-only
"""
from __future__ import annotations

import argparse
import email
import imaplib
import re
from email.header import decode_header, make_header
from email.message import Message

import httpx

from lib.config import settings
from lib.db import connect, execute, query
from lib.log import get_logger

log = get_logger("email_processor")

TOKEN_RE = re.compile(r"\[HPM-([a-f0-9]{18})\]", re.IGNORECASE)

AVAILABLE_PATTERNS = [
    r"\bstill (?:available|there|open|vacant)\b",
    r"\b(?:yes|yep|yeah)[,.\s-]*(?:it'?s )?available\b",
    r"\bavailable\b(?!\s*(?:no|not))",
    r"\bvacant\b",
    r"\bopen\b",
]
RENTED_PATTERNS = [
    r"\brented\b",
    r"\b(?:already )?(?:taken|gone|occupied|let out|leased|booked)\b",
    r"\bno longer available\b",
    r"\bnot available\b",
    r"\bsold\b",
    r"\bclose (?:the )?(?:listing|post)\b",
]


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------
def decode(value: str | None) -> str:
    if not value:
        return ""
    try:
        return str(make_header(decode_header(value)))
    except Exception:
        return value


def plain_body(msg: Message) -> str:
    """Prefer text/plain; fall back to a crude tag strip of text/html."""
    if msg.is_multipart():
        for part in msg.walk():
            if part.get_content_type() == "text/plain" and "attachment" not in str(part.get("Content-Disposition")):
                return part.get_payload(decode=True).decode(part.get_content_charset() or "utf-8", "replace")
        for part in msg.walk():
            if part.get_content_type() == "text/html":
                raw = part.get_payload(decode=True).decode(part.get_content_charset() or "utf-8", "replace")
                return re.sub(r"<[^>]+>", " ", raw)
        return ""
    payload = msg.get_payload(decode=True)
    return payload.decode(msg.get_content_charset() or "utf-8", "replace") if payload else ""


def strip_quoted(body: str) -> str:
    """Owners answer in one line at the top. Everything below the quote marker
    is our own email coming back, and matching against it would be a bug."""
    lines: list[str] = []
    for line in body.splitlines():
        stripped = line.strip()
        if stripped.startswith(">"):
            break
        if re.match(r"^\s*(on .+wrote:|-{2,}\s*original message|from:\s)", stripped, re.I):
            break
        lines.append(stripped)
        if len(lines) > 12:
            break
    return " ".join(lines).lower()


def classify(text: str) -> str:
    """rented wins ties: closing a listing that is actually gone is the safer
    error than keeping a dead listing alive."""
    if any(re.search(p, text) for p in RENTED_PATTERNS):
        return "rented"
    if any(re.search(p, text) for p in AVAILABLE_PATTERNS):
        return "available"
    return "unknown"


# ---------------------------------------------------------------------------
# Actions
# ---------------------------------------------------------------------------
def apply_reply(conn, token: str, intent: str, from_addr: str) -> bool:
    rows = query(conn, """
        select e.id, e.listing_id, e.replied_at, l.title, l.owner_email, l.status
        from email_events e
        join listings l on l.id = e.listing_id
        where e.token = %s
    """, (token,))
    if not rows:
        log.warning("token %s has no matching email_event", token)
        return False

    event = rows[0]

    # Only the owner may change listing state by email.
    sender = from_addr.lower()
    if event["owner_email"].lower() not in sender:
        log.warning("reply for %s came from %s, not the owner — recording only", token, sender)
        intent = "unknown"

    execute(conn, """
        update email_events
           set replied_at = coalesce(replied_at, now()),
               reply_intent = %s
         where id = %s
    """, (intent, event["id"]))

    if intent == "rented":
        execute(conn, "update listings set status = 'rented' where id = %s", (event["listing_id"],))
        log.info("closed listing %s (%s)", event["listing_id"], event["title"])
    elif intent == "available":
        execute(conn, """
            update listings
               set last_confirmed_at = now(),
                   reminder_stage = 0,
                   status = 'active',
                   expires_at = now() + interval '30 days'
             where id = %s
        """, (event["listing_id"],))
        log.info("refreshed listing %s (%s)", event["listing_id"], event["title"])
    else:
        log.info("reply for %s not understood — left for a human", token)
        return False

    execute(conn, "update email_events set action_taken = %s where id = %s", (intent, event["id"]))
    return True


def process_inbox(conn) -> dict[str, int]:
    stats = {"seen": 0, "matched": 0, "applied": 0}
    if not settings.imap_user or not settings.imap_password:
        log.warning("IMAP is not configured — skipping inbox scan")
        return stats

    with imaplib.IMAP4_SSL(settings.imap_host) as imap:
        imap.login(settings.imap_user, settings.imap_password)
        imap.select(settings.imap_folder)

        status, data = imap.search(None, "UNSEEN")
        if status != "OK":
            log.error("IMAP search failed: %s", status)
            return stats

        for num in data[0].split():
            stats["seen"] += 1
            status, raw = imap.fetch(num, "(RFC822)")
            if status != "OK" or not raw or not raw[0]:
                continue

            msg = email.message_from_bytes(raw[0][1])
            subject = decode(msg.get("Subject"))
            sender = decode(msg.get("From"))

            match = TOKEN_RE.search(subject)
            if not match:
                log.debug("no token in subject: %s", subject[:80])
                continue

            stats["matched"] += 1
            intent = classify(strip_quoted(plain_body(msg)))
            log.info("reply token=%s intent=%s from=%s", match.group(1), intent, sender[:60])

            if apply_reply(conn, match.group(1), intent, sender):
                stats["applied"] += 1

            imap.store(num, "+FLAGS", "\\Seen")

    return stats


def retry_failed_notifications(conn, limit: int = 50) -> int:
    """Any interest older than two minutes with no email_sent_at is a delivery
    that fell through. Hand it back to the edge function so the retry uses the
    exact same code path as the original send."""
    pending = query(conn, """
        select id from interests
         where email_sent_at is null
           and created_at < now() - interval '2 minutes'
           and created_at > now() - interval '7 days'
         order by created_at
         limit %s
    """, (limit,))

    if not pending:
        return 0

    url = f"{settings.supabase_url}/functions/v1/send_interest_email"
    headers = {
        "Authorization": f"Bearer {settings.service_role_key}",
        "Content-Type": "application/json",
    }

    sent = 0
    with httpx.Client(timeout=30) as client:
        for row in pending:
            if settings.dry_run:
                log.info("DRY_RUN would retry interest %s", row["id"])
                continue
            try:
                res = client.post(url, headers=headers, json={"interest_id": str(row["id"])})
                if res.status_code == 200:
                    sent += 1
                else:
                    log.error("retry failed for %s: %s %s", row["id"], res.status_code, res.text[:200])
            except Exception as exc:  # noqa: BLE001
                log.error("retry crashed for %s: %s", row["id"], exc)
    return sent


def main() -> None:
    parser = argparse.ArgumentParser(description="Process owner replies and retry failed notifications.")
    parser.add_argument("--retries-only", action="store_true", help="skip the IMAP scan")
    args = parser.parse_args()

    with connect() as conn:
        if not args.retries_only:
            stats = process_inbox(conn)
            log.info("inbox: seen=%(seen)d matched=%(matched)d applied=%(applied)d", stats)
        retried = retry_failed_notifications(conn)
        log.info("retried %d undelivered notifications", retried)


if __name__ == "__main__":
    main()
