# Environment variables

Three consumers, three places to set things. A variable in the wrong column is
either a broken deploy or a leak.

| Variable | Where it is set | Public? | Purpose |
|---|---|---|---|
| `SUPABASE_URL` | Pages env, Supabase secrets, cron `.env` | yes | Project URL. Also the base for edge function and action URLs. |
| `SUPABASE_ANON_KEY` | Pages env | **yes** | Browser key. Protected by RLS and column grants, not by secrecy. |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase secrets, cron `.env` | **no** | Bypasses RLS. Edge functions and Python only. |
| `DATABASE_URL` | cron `.env` | **no** | Direct Postgres for the jobs. Use the pooler (port 6543). |
| `GOOGLE_MAPS_BROWSER_KEY` | Pages env | **yes** | Maps JS + Autocomplete. Must be restricted by HTTP referrer. |
| `GOOGLE_PLACES_API_KEY` | Supabase secrets | **no** | Server-side Places. Never reaches a browser. |
| `RESEND_API_KEY` | Supabase secrets, cron `.env` | **no** | Sending access only. |
| `RESEND_FROM` | Supabase secrets, cron `.env` | yes | Must be on a domain verified in Resend. |
| `REPLY_TO_ADDRESS` | Supabase secrets, cron `.env` | yes | Mailbox `email_processor.py` polls. |
| `RAZORPAY_KEY_ID` | Pages env, Supabase secrets | **yes** | Publishable half of the pair. |
| `RAZORPAY_KEY_SECRET` | Supabase secrets | **no** | Signs order creation. |
| `RAZORPAY_WEBHOOK_SECRET` | Supabase secrets | **no** | Verifies the webhook HMAC. |
| `PAYMENTS_ENABLED` | Pages env, Supabase secrets | yes | Master switch. `false` hides the ₹1 toggle and makes order creation refuse. |
| `INTEREST_AMOUNT_PAISE` | Supabase secrets | — | `100` = ₹1. Server-side only, so the client cannot choose the amount. |
| `WAQI_TOKEN` | Supabase secrets | **no** | Free token from aqicn.org. |
| `SITE_URL` | Supabase secrets, cron `.env` | yes | Base for links in emails. |
| `ALLOWED_ORIGINS` | Supabase secrets | — | CORS allowlist. `*` for local development only. |
| `IMAP_HOST` / `IMAP_USER` / `IMAP_PASSWORD` / `IMAP_FOLDER` | cron `.env` | **no** | Reply intake. Gmail needs an App Password. |
| `DRY_RUN` | cron `.env` | — | `true` logs mail instead of sending it. |
| `LOG_LEVEL` | cron `.env` | — | `DEBUG` / `INFO` / `WARNING`. |

## Rules

1. **Nothing marked "no" belongs in `frontend/`.** `scripts/build-config.sh`
   only substitutes the five public placeholders; there is no path for a secret
   to reach `config.js` by accident.
2. **Two Google keys, always.** The browser key is restricted by referrer and
   scoped to Maps JS + Places API (New). The server key is scoped to Places and
   restricted by IP where possible. Sharing one key means a scraped browser key
   can spend your Places budget.
3. **Rotating the service role key** requires `supabase secrets set` *and*
   updating the cron host's `.env`. Miss the second and every job fails
   silently at the next tick.

## Local development

Copy `.env.example` to `.env` at the repo root — `python/lib/config.py` loads it
from there, and `supabase functions serve --env-file .env` reads the same file.
For CORS during local work, set `ALLOWED_ORIGINS=*`.
