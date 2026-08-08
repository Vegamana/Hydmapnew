# Hyderabad Property Map

A map of what rent actually costs in Hyderabad, street by street. No login, no
public phone numbers, no chat. Someone finds a flat, sends their details, and
the owner gets an email.

Rebuilt from the Next.js + Firebase + Vercel original onto static HTML on
Cloudflare Pages, Supabase Postgres with PostGIS, and Python cron workers.

---

## Architecture

```
  Browser (Cloudflare Pages, static)
      │  anon key + RLS                    ┌─ Google Places  (server key only)
      ├──────────────► PostgREST ──────────┤
      │                 RPCs               ├─ Resend         (all outbound mail)
      └──────────────► Edge Functions ─────┤
                        (Deno)             └─ Razorpay       (₹1, optional)
                            │
                       Postgres + PostGIS
                            │
                    Python cron workers
              (replies · reminders · cache · stats)
```

**Why each piece:**

| Choice | Reason |
|---|---|
| Server-side clustering (PostGIS RPC) | The original clustered in Node memory with a 45s TTL that vanished on every cold start. Grid aggregation in Postgres is consistent, indexed, and one round trip. |
| Column-level grants, not just RLS | Everyone holds the anon key, so it is public. RLS filters rows; only column grants can keep `owner_email` out of a hand-crafted PostgREST query. |
| All Google Places calls server-side | One cache table, one key, one place to enforce a spending fence. The browser never holds a Places key. |
| Email as the transport | Async, spam-resistant, and it works when the owner is a landlord with a feature phone and a Gmail address. Tokens in the subject line make replies machine-readable without any thread plumbing. |
| Python for the repetitive work | Reminders, reply parsing, cache warming and stats are cron-shaped, not request-shaped. They do not belong in an edge function with a 60-second ceiling. |
| No framework on the frontend | Nine ES modules, no build step, no dependency tree to patch. The one build action is stamping environment variables into `config.js`. |

---

## Structure

```
.
├── frontend/                     # Cloudflare Pages root
│   ├── index.html
│   ├── css/app.css
│   ├── js/
│   │   ├── config.js             # placeholders stamped at deploy time
│   │   ├── api.js                # the only module that touches the network
│   │   ├── map.js                # Maps API bootstrap, viewport, smooth zoom
│   │   ├── markers.js            # OverlayView subclass + chip builders
│   │   ├── controls.js           # metro / train / bus / satellite / AQI / heatmap
│   │   ├── search.js             # Places Autocomplete with session tokens
│   │   ├── pulse.js              # average rent within a radius
│   │   ├── nearby.js             # cached biryani / gyms / hospitals
│   │   ├── listing.js            # detail sheet + comments
│   │   ├── modal.js              # "I'm interested" flow
│   │   ├── payments.js           # Razorpay checkout
│   │   ├── format.js, toast.js
│   │   └── app.js                # wiring
│   ├── data/transit.json         # static metro/rail/bus, regenerated from OSM
│   ├── _headers                  # CSP + cache policy
│   └── _redirects                # SPA fallback, /listing/:id deep links
│
├── supabase/
│   ├── config.toml               # per-function verify_jwt settings
│   ├── migrations/
│   │   ├── 0001_schema.sql       # tables, enums, indexes
│   │   ├── 0002_rls.sql          # RLS + column grants
│   │   ├── 0003_functions.sql    # clustering, avg rent, cache, email actions
│   │   └── 0004_seed.sql
│   └── functions/
│       ├── _shared/              # http, db, validate, resend, templates, razorpay, notify
│       ├── handle_interest_submission/
│       ├── send_interest_email/
│       ├── fetch_places_with_cache/
│       ├── create_razorpay_order/
│       ├── razorpay_webhook/
│       ├── listing_action/       # one-click "rented" / "still available"
│       └── fetch_aqi/
│
├── python/
│   ├── lib/                      # config, db, mailer, logging
│   ├── jobs/                     # email_processor, aging_posts, cache_warmer, analytics, cleanup
│   ├── tools/build_transit_data.py
│   └── crontab.example
│
├── emails/                       # HTML templates, read at runtime by Python
├── scripts/build-config.sh       # the entire frontend build
└── docs/DEPLOYMENT.md, docs/ENV.md
```

---

## The interest flow

```
click "I'm interested"
        ↓
modal: name, phone, email, optional message, optional ₹1 toggle
        ↓
POST handle_interest_submission
        ├─ validate + rate limit (same email/listing per 24h; 10/hour overall)
        ├─ INSERT interests                 ← the lead is safe from here
        ├─ optional: create Razorpay order
        └─ email the owner via Resend, with a token in the subject
        ↓
if the ₹1 toggle was on, Razorpay checkout opens
        ↓
success screen — whatever the payment did
```

Payment never gates anything. If Razorpay is down, the order call fails, the
enquiry is downgraded to `payment_status = 'skipped'`, and the owner is emailed
anyway. If the email fails, `email_sent_at` stays null and
`jobs/email_processor.py` retries it within 15 minutes. The webhook, not the
browser callback, is what writes the final payment status.

The owner's address appears in exactly one place: the `to` field of that email.

---

## The email loop

Every outbound message carries `[HPM-<token>]` in its subject, backed by a row
in `email_events`. That single token does three jobs:

- **Reply parsing** — the token survives `Re:`, so `email_processor.py` can map
  a free-text reply to a listing and act on "still available" or "rented".
- **One-click links** — `listing_action` needs no login because the token *is*
  the credential, and it only ever resolves to one listing.
- **Measurement** — `analytics.py` reports the reply rate as a health metric.

Reminders go out at 60, 90 and 120 days since last confirmation. A confirmation
resets the ladder. Four ignored reminders and the listing quietly expires, so
nobody calls about a flat that went last spring.

---

## Cost control

Google Maps and Places are the only meaningful variable cost, so:

- Places calls happen **only** server-side, and only through
  `fetch_places_with_cache`.
- Coordinates snap to 3 decimals (~110 m) before the cache lookup, and radii
  snap to a fixed ladder. Panning a few pixels reuses the row.
- Requests outside the Hyderabad bounding box are refused outright.
- Only rendered fields are requested (Places field masking).
- Autocomplete uses **session tokens**: a whole search plus the final place
  lookup bills as one session rather than one call per keystroke. Queries under
  three characters never leave the browser.
- Cluster queries round bounds to 3 decimals and cache for 45 seconds in memory,
  with `AbortController` cancelling superseded viewports.
- `cache_warmer.py` pre-buys the hot neighbourhoods overnight under a hard
  `--budget` ceiling.
- Transit overlays are a static JSON file, not an API.

---

## Running it

Local:

```bash
supabase start && supabase db push
cp .env.example .env                       # then fill it in
supabase functions serve --env-file .env

SUPABASE_URL=http://localhost:54321 \
SUPABASE_ANON_KEY=<local-anon-key> \
GOOGLE_MAPS_BROWSER_KEY=<key> \
  bash scripts/build-config.sh

python3 -m http.server 5173 --directory frontend
```

Production: see [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).
Every variable: see [`docs/ENV.md`](docs/ENV.md).

---

## What was deliberately dropped

- **Firebase Auth and the admin gate.** A single hardcoded admin email
  duplicated by hand into `firestore.rules` is a permission model waiting to
  drift. Listing state is now changed by the owner, by email, with a token.
- **Nominatim geocoding.** Replaced with Places Autocomplete for quality, made
  affordable with session tokens.
- **The demo-data fallback.** A map silently showing ten fake flats is worse
  than a map saying it could not load.
- **Client-side clustering.** Moved into Postgres.

## Known gaps

- No listing-creation UI ships here — listings are inserted by an owner-facing
  flow that is not part of this rebuild. `0004_seed.sql` fills the map for now.
- `frontend/data/transit.json` is a trimmed sample. Run
  `python tools/build_transit_data.py` for the full network.
- Comments are anonymous and unmoderated beyond length checks. If this gets
  abused, move the insert behind an edge function with the same rate limiting
  the interest flow already has.
