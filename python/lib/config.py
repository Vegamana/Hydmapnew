"""Central config. Every job imports settings from here, nothing reads os.environ
directly, so a missing variable fails loudly at startup instead of at 3 a.m."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[2]
load_dotenv(ROOT / ".env")


def _req(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is missing. Copy .env.example to .env and fill it in.")
    return value


def _opt(name: str, default: str = "") -> str:
    return os.getenv(name, default).strip()


@dataclass(frozen=True)
class Settings:
    database_url: str = field(default_factory=lambda: _req("DATABASE_URL"))
    supabase_url: str = field(default_factory=lambda: _req("SUPABASE_URL"))
    service_role_key: str = field(default_factory=lambda: _req("SUPABASE_SERVICE_ROLE_KEY"))

    resend_api_key: str = field(default_factory=lambda: _req("RESEND_API_KEY"))
    resend_from: str = field(default_factory=lambda: _opt("RESEND_FROM", "Hyderabad Property Map <notify@example.com>"))
    reply_to: str = field(default_factory=lambda: _opt("REPLY_TO_ADDRESS"))

    google_places_key: str = field(default_factory=lambda: _opt("GOOGLE_PLACES_API_KEY"))
    site_url: str = field(default_factory=lambda: _opt("SITE_URL", "https://example.pages.dev"))

    imap_host: str = field(default_factory=lambda: _opt("IMAP_HOST", "imap.gmail.com"))
    imap_user: str = field(default_factory=lambda: _opt("IMAP_USER"))
    imap_password: str = field(default_factory=lambda: _opt("IMAP_PASSWORD"))
    imap_folder: str = field(default_factory=lambda: _opt("IMAP_FOLDER", "INBOX"))

    dry_run: bool = field(default_factory=lambda: _opt("DRY_RUN", "false").lower() == "true")

    @property
    def action_base(self) -> str:
        return f"{self.supabase_url}/functions/v1/listing_action"


settings = Settings()
