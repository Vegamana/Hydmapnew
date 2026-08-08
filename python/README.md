# Python automation

    python -m venv .venv && source .venv/bin/activate
    pip install -r requirements.txt
    cp ../.env.example ../.env      # fill in DATABASE_URL, keys
    python -m jobs.analytics --report

Every job is idempotent and safe to re-run. Add `--dry-run` (aging_posts) or
`DRY_RUN=true` in the environment to see what would be sent without sending it.

| Job                  | Schedule    | What it does                                            |
|----------------------|-------------|---------------------------------------------------------|
| `email_processor`    | every 15m   | IMAP replies -> listing status; retries failed notifies |
| `aging_posts`        | daily 09:30 | 60/90/120-day "still available?" mails, expires silence |
| `cache_warmer`       | daily 04:00 | pre-fetches Google Places for hot areas, budget-capped  |
| `analytics`          | nightly     | rebuilds `area_stats`, prints a health line             |
| `tools/build_transit_data.py` | manual | regenerates `frontend/data/transit.json` from OSM |
