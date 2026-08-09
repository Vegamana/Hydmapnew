# Deployment

Four things get deployed independently: the database, the edge functions, the
static site, and the cron host. Nothing depends on a build server.

---

## 1. Supabase (database + edge functions)

```bash
npm install -g supabase
supabase login
supabase link --project-ref <your-project-ref>
```

**Enable PostGIS** once, in the dashboard SQL editor or via the migration
(`0001_schema.sql` starts with `create extension if not exists postgis`).

**Push the schema:**

```bash
supabase db push          # runs supabase/migrations/*.sql in order
```

To verify RLS is doing its job, from the SQL editor:

```sql
set role anon;
select owner_email from listings limit 1;   -- must fail: permission denied
select * from interests limit 1;            -- must return nothing
reset role;
```

If either of those returns data, stop and re-run `0002_rls.sql`.

**Set the function secrets.** `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`
are not in this list on purpose — Supabase auto-injects both into every edge
function at runtime, and `supabase secrets set` refuses to override them
(prints "Env name cannot start with SUPABASE_, skipping" and does nothing):

```bash
supabase secrets set \
  GOOGLE_PLACES_API_KEY=<server-key> \
  RESEND_API_KEY=<resend-key> \
  RESEND_FROM="Hyderabad Property Map <notify@yourdomain.com>" \
  REPLY_TO_ADDRESS=replies@yourdomain.com \
  RAZORPAY_KEY_ID=<key-id> \
  RAZORPAY_KEY_SECRET=<key-secret> \
  RAZORPAY_WEBHOOK_SECRET=<webhook-secret> \
  PAYMENTS_ENABLED=true \
  INTEREST_AMOUNT_PAISE=100 \
  WAQI_TOKEN=<waqi-token> \
  SITE_URL=https://hyd-map.pages.dev \
  ALLOWED_ORIGINS=https://hyd-map.pages.dev
```

**Deploy the functions.** Two of them must skip JWT verification, because the
callers (Razorpay's servers, a mail client) cannot present a Supabase token:

```bash
supabase functions deploy handle_interest_submission
supabase functions deploy send_interest_email
supabase functions deploy fetch_places_with_cache
supabase functions deploy create_razorpay_order
supabase functions deploy fetch_aqi
supabase functions deploy submit_listing
supabase functions deploy submit_rent_report
supabase functions deploy submit_seeker
supabase functions deploy submit_board_sighting

supabase functions deploy razorpay_webhook --no-verify-jwt
supabase functions deploy listing_action   --no-verify-jwt
```

Smoke test:

```bash
curl -X POST https://<ref>.supabase.co/functions/v1/fetch_places_with_cache \
  -H "Authorization: Bearer <anon-key>" -H "Content-Type: application/json" \
  -d '{"type":"biryani","lat":17.4485,"lng":78.3908,"radius":1500}'
# first call: "source":"google"   second call: "source":"cache"
```

---

## 2. Cloudflare Pages (frontend)

**Connect the repo** in the Pages dashboard, then set:

| Setting | Value |
|---|---|
| Build command | `bash scripts/build-config.sh` |
| Build output directory | `frontend` |
| Root directory | *(repo root)* |

**Environment variables** (Settings → Environment variables, for both Production
and Preview):

```
SUPABASE_URL              https://<ref>.supabase.co
SUPABASE_ANON_KEY         <anon-key>
GOOGLE_MAPS_BROWSER_KEY   <browser-key>
RAZORPAY_KEY_ID           <key-id>
PAYMENTS_ENABLED          true
```

The build script stamps these into `frontend/js/config.js` and fails the build
if any placeholder survives, so a misconfigured deploy never reaches users.

Or deploy directly:

```bash
SUPABASE_URL=... SUPABASE_ANON_KEY=... GOOGLE_MAPS_BROWSER_KEY=... \
  bash scripts/build-config.sh
npx wrangler pages deploy frontend --project-name hyd-map
```

`_headers` and `_redirects` in `frontend/` are picked up automatically: CSP and
cache policy from the first, SPA fallback and `/listing/:id` deep links from the
second.

**After the first deploy**, go back and restrict the Google browser key to
`https://hyd-map.pages.dev/*` (and your custom domain). An unrestricted Maps key
in a public JS file will be scraped and billed to you.

---

## 3. Razorpay

1. Dashboard → Settings → Webhooks → **Add New Webhook**
2. URL: `https://<ref>.supabase.co/functions/v1/razorpay_webhook`
3. Events: `payment.captured`, `payment.failed`, `order.paid`
4. Copy the webhook secret into `RAZORPAY_WEBHOOK_SECRET`

Test in test mode with card `4111 1111 1111 1111`, any future expiry, any CVV.
Then confirm the row updated:

```sql
select payment_status, razorpay_payment_id from interests order by created_at desc limit 1;
```

---

## 4. Resend

1. Add and verify your sending domain (SPF + DKIM records). Until the domain is
   verified, sends fail — this was an outstanding gap in the previous system.
2. Point `replies@yourdomain.com` at a real mailbox. This is the inbox
   `email_processor.py` polls, and the address owners reply to.
3. Create the API key with **Sending access** only.

---

## 5. Cron host

Any small VM works — a €4 VPS, a Fly machine, an EC2 nano. The jobs are
short-lived processes with no inbound ports.

```bash
git clone <repo> /srv/hyd-map && cd /srv/hyd-map
python3 -m venv .venv
.venv/bin/pip install -r python/requirements.txt

cp .env.example .env && $EDITOR .env      # DATABASE_URL, service key, IMAP, Resend
mkdir -p /var/log/hyd-map

# Verify before scheduling anything:
cd python && ../.venv/bin/python -m jobs.analytics --report
DRY_RUN=true ../.venv/bin/python -m jobs.aging_posts

crontab /srv/hyd-map/python/crontab.example
```

For Gmail, `IMAP_PASSWORD` must be an **App Password** with 2FA enabled, not the
account password.

### If you would rather not run a VM

`aging_posts`, `cache_warmer`, `analytics` and `cleanup` are pure database +
HTTP work and port cleanly to GitHub Actions on a schedule — add
`DATABASE_URL` and the keys as repository secrets. `email_processor` needs a
persistent IMAP connection often enough that a small always-on host is simpler.

---

## Rollback

| Layer | How |
|---|---|
| Frontend | Pages → Deployments → **Rollback** to the previous build |
| Edge function | `supabase functions deploy <name>` from the previous commit |
| Schema | Write a forward migration. Never edit an applied one. |
| Cron | `crontab -r`, fix, reinstall |

---

## Health checks

```sql
-- leads that never got emailed (should be 0 or very small)
select count(*) from interests where email_sent_at is null and created_at < now() - interval '1 hour';

-- cache effectiveness: hits per stored row, higher is cheaper
select round(sum(hit_count)::numeric / greatest(count(*), 1), 1) as hits_per_row from places_cache;

-- how many owners actually answer reminders
select reply_intent, count(*) from email_events
 where kind = 'aging_reminder' and sent_at > now() - interval '30 days'
 group by 1;
```

`python -m jobs.analytics` prints the same numbers to the cron log every night.
