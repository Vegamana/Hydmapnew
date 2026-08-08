-- =====================================================================
-- 0001_schema.sql — tables, types, indexes
-- Run with: supabase db push   (or paste into the SQL editor)
-- =====================================================================

create extension if not exists postgis;      -- geography type + spatial index
create extension if not exists pgcrypto;     -- gen_random_uuid / gen_random_bytes

-- ---------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------
do $$ begin
  create type listing_type   as enum ('rent', 'sale', 'sharing', 'rent_paid');
exception when duplicate_object then null; end $$;

do $$ begin
  create type listing_status as enum ('active', 'rented', 'expired', 'deleted');
exception when duplicate_object then null; end $$;

-- 'skipped' = user chose not to pay. Interest is still valid: payment never blocks.
do $$ begin
  create type payment_status as enum ('skipped', 'pending', 'success', 'failed');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------
-- listings
-- owner_email is PRIVATE. It is never granted to the `anon` role
-- (see 0002_rls.sql — column-level grants), so it cannot leak through
-- PostgREST even if someone crafts their own query.
-- ---------------------------------------------------------------------
create table if not exists public.listings (
  id                uuid primary key default gen_random_uuid(),
  title             text        not null check (char_length(title) between 3 and 140),
  type              listing_type not null default 'rent',
  price             numeric(12,2) not null check (price >= 0),

  lat               double precision not null check (lat  between -90  and 90),
  lng               double precision not null check (lng  between -180 and 180),
  -- Generated geography column: one source of truth, always in sync with lat/lng.
  geog              geography(Point, 4326)
                    generated always as
                    (ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography) stored,

  -- optional flat detail (mirrors the legacy Property model)
  bhk               text        check (bhk in ('1','2','3','4','5+')),
  furnishing        text        check (furnishing in ('furnished','semi','unfurnished')),
  gated             boolean,
  deposit           numeric(12,2) check (deposit >= 0),
  parking           smallint      check (parking between 0 and 10),
  square_footage    integer       check (square_footage between 0 and 100000),
  gender_preference text          check (gender_preference in ('male','female','any')),
  description       text          check (char_length(description) <= 2000),
  photo_urls        text[]        not null default '{}',
  locality          text,                        -- filled by python/jobs/analytics.py

  owner_email       text        not null check (position('@' in owner_email) > 1),
  owner_phone       text,                        -- private, for admin use only

  status            listing_status not null default 'active',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  -- Refreshed whenever the owner replies "still available" to a reminder.
  last_confirmed_at timestamptz not null default now(),
  expires_at        timestamptz,
  -- 0 = none sent, 60 / 90 / 120 = last aging reminder stage delivered
  reminder_stage    smallint    not null default 0
);

create index if not exists listings_geog_idx
  on public.listings using gist (geog)
  where status = 'active';

create index if not exists listings_bbox_idx
  on public.listings (lat, lng)
  where status = 'active';

create index if not exists listings_status_created_idx
  on public.listings (status, created_at desc);

create index if not exists listings_owner_email_idx
  on public.listings (lower(owner_email));

-- ---------------------------------------------------------------------
-- interests — "I'm Interested" submissions
-- Written ONLY by the handle_interest_submission edge function.
-- ---------------------------------------------------------------------
create table if not exists public.interests (
  id                  uuid primary key default gen_random_uuid(),
  listing_id          uuid not null references public.listings(id) on delete cascade,
  name                text not null check (char_length(name) between 2 and 80),
  phone               text not null check (phone ~ '^[0-9]{10}$'),
  email               text not null check (position('@' in email) > 1),
  message             text check (char_length(message) <= 500),

  amount_paise        integer not null default 0 check (amount_paise >= 0),
  payment_status      payment_status not null default 'skipped',
  razorpay_order_id   text,
  razorpay_payment_id text,

  email_sent_at       timestamptz,          -- null => the notify email still owes delivery
  email_error         text,
  created_at          timestamptz not null default now()
);

create index if not exists interests_listing_idx on public.interests (listing_id, created_at desc);
create index if not exists interests_email_idx   on public.interests (lower(email), created_at desc);
create index if not exists interests_order_idx   on public.interests (razorpay_order_id);
-- Retry queue for python/jobs (any interest whose email never went out).
create index if not exists interests_undelivered_idx
  on public.interests (created_at) where email_sent_at is null;

-- ---------------------------------------------------------------------
-- places_cache — every Google Places response we have ever paid for
-- lat/lng are rounded to 3 decimals (~110 m) so nearby requests collapse
-- onto the same cache row instead of billing a new call per pixel.
-- ---------------------------------------------------------------------
create table if not exists public.places_cache (
  id          uuid primary key default gen_random_uuid(),
  type        text not null check (type in ('biryani','gym','hospital','school','supermarket','pharmacy','aqi')),
  lat         double precision not null,
  lng         double precision not null,
  lat_key     numeric(6,3) generated always as (round(lat::numeric, 3)) stored,
  lng_key     numeric(6,3) generated always as (round(lng::numeric, 3)) stored,
  radius      integer not null check (radius between 100 and 20000),
  data        jsonb   not null,
  hit_count   integer not null default 0,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '30 days'
);

create unique index if not exists places_cache_key_idx
  on public.places_cache (type, lat_key, lng_key, radius);

create index if not exists places_cache_expiry_idx on public.places_cache (expires_at);

-- ---------------------------------------------------------------------
-- comments — anonymous, no login
-- ---------------------------------------------------------------------
create table if not exists public.comments (
  id         uuid primary key default gen_random_uuid(),
  listing_id uuid not null references public.listings(id) on delete cascade,
  author     text not null default 'Anonymous' check (char_length(author) between 1 and 40),
  text       text not null check (char_length(text) between 1 and 1000),
  created_at timestamptz not null default now()
);

create index if not exists comments_listing_idx on public.comments (listing_id, created_at desc);

-- ---------------------------------------------------------------------
-- email_events — the spine of the email-driven workflow
-- Every outbound mail gets a random token. The token is embedded in the
-- subject line ([HPM-xxxx]) and in the action links, so:
--   * python/jobs/email_processor.py can map an IMAP reply back to a listing
--   * one-click "Rented" / "Still available" links need no login
-- ---------------------------------------------------------------------
create table if not exists public.email_events (
  id           uuid primary key default gen_random_uuid(),
  token        text unique not null default encode(gen_random_bytes(9), 'hex'),
  kind         text not null check (kind in ('interest_notification','aging_reminder','comment_notification')),
  listing_id   uuid references public.listings(id) on delete cascade,
  interest_id  uuid references public.interests(id) on delete set null,
  to_email     text not null,
  subject      text,
  provider_id  text,                    -- Resend message id
  sent_at      timestamptz not null default now(),
  replied_at   timestamptz,
  reply_intent text check (reply_intent in ('available','rented','unknown')),
  action_taken text
);

create index if not exists email_events_listing_idx on public.email_events (listing_id, sent_at desc);
create index if not exists email_events_open_idx    on public.email_events (sent_at desc) where replied_at is null;

-- ---------------------------------------------------------------------
-- area_stats — materialised nightly by python/jobs/analytics.py
-- ---------------------------------------------------------------------
create table if not exists public.area_stats (
  id            uuid primary key default gen_random_uuid(),
  locality      text not null,
  lat           double precision not null,
  lng           double precision not null,
  listing_count integer not null,
  avg_rent      numeric(12,2),
  median_rent   numeric(12,2),
  density_km2   numeric(10,3),
  computed_at   timestamptz not null default now()
);

create unique index if not exists area_stats_locality_idx on public.area_stats (locality);

-- ---------------------------------------------------------------------
-- updated_at trigger
-- ---------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists listings_touch_updated_at on public.listings;
create trigger listings_touch_updated_at
  before update on public.listings
  for each row execute function public.touch_updated_at();
