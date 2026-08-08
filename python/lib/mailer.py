"""Resend client + email_events bookkeeping, mirroring the edge function's
behaviour so a mail sent by cron is traceable exactly like one sent by an
edge function.

Templates live in emails/*.html at the repo root — one copy, read at runtime,
so the HTML never drifts between Deno and Python."""
from __future__ import annotations

import html
import re
from pathlib import Path
from typing import Any

import httpx
from tenacity import retry, stop_after_attempt, wait_exponential

from .config import ROOT, settings
from .db import query
from .log import get_logger

log = get_logger("mailer")
TEMPLATE_DIR = ROOT / "emails"
_API = "https://api.resend.com/emails"


def render(template_name: str, **values: Any) -> str:
    """Minimal {{placeholder}} substitution. All values are HTML-escaped unless
    the placeholder name ends in _raw."""
    raw = (TEMPLATE_DIR / template_name).read_text(encoding="utf-8")

    def sub(match: re.Match[str]) -> str:
        key = match.group(1).strip()
        value = values.get(key, "")
        return str(value) if key.endswith("_raw") else html.escape(str(value))

    return re.sub(r"\{\{\s*([a-z0-9_]+)\s*\}\}", sub, raw)


def reserve_token(conn, *, kind: str, to_email: str, listing_id: str | None = None,
                  interest_id: str | None = None, subject: str | None = None) -> dict:
    """Creates the email_events row up front so the token can go in the subject
    line and the action links before the mail is built."""
    rows = query(conn, """
        insert into email_events (kind, listing_id, interest_id, to_email, subject)
        values (%s, %s, %s, %s, %s)
        returning id, token
    """, (kind, listing_id, interest_id, to_email, subject))
    return rows[0]


@retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=2, max=12), reraise=True)
def _post(payload: dict) -> dict:
    with httpx.Client(timeout=20) as client:
        res = client.post(_API, json=payload,
                          headers={"Authorization": f"Bearer {settings.resend_api_key}"})
        if res.status_code >= 500:
            res.raise_for_status()          # retryable
        if res.status_code >= 400:
            raise RuntimeError(f"Resend {res.status_code}: {res.text}")  # not retryable
        return res.json()


def send(conn, *, to: str, subject: str, html_body: str, text_body: str = "",
         event_id: str | None = None, kind: str = "aging_reminder") -> dict:
    if settings.dry_run:
        log.info("DRY_RUN would send to=%s subject=%s", to, subject)
        return {"id": "dry-run"}

    payload = {
        "from": settings.resend_from,
        "to": [to],
        "subject": subject,
        "html": html_body,
        "tags": [{"name": "kind", "value": kind}],
    }
    if text_body:
        payload["text"] = text_body
    if settings.reply_to:
        payload["reply_to"] = settings.reply_to

    result = _post(payload)

    if event_id:
        query(conn, "update email_events set provider_id = %s, subject = %s where id = %s",
              (result.get("id"), subject, event_id))
    log.info("sent to=%s id=%s", to, result.get("id"))
    return result
