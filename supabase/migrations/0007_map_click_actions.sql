-- =====================================================================
-- 0007_map_click_actions.sql — the three actions behind the map-click
-- "Add something here" chooser: an anonymous rent data point, a seeker
-- pin, and a To-Let board sighting.
-- =====================================================================

-- ---------------------------------------------------------------------
-- rent_reports — "What rent are you paying?" A bare data point, no
-- listing attached, no contact info collected at all. Feeds avg_rent_nearby
-- alongside real listings below, which is the whole point: it is supposed
-- to make the pulse number more accurate, not just sit in its own table.
-- ---------------------------------------------------------------------
create table if not exists public.rent_reports (
  id          uuid primary key default gen_random_uuid(),
  price       numeric(12,2) not null check (price > 0),
  type        listing_type  not null default 'rent' check (type in ('rent', 'sharing')),
  bhk         text check (bhk in ('1','2','3','4','5+')),
  lat         double precision not null check (lat between -90 and 90),
  lng         double precision not null check (lng between -180 and 180),
  geog        geography(Point, 4326) generated always as
              (ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography) stored,
  reporter_ip text,                          -- rate-limit only; never granted to anon
  created_at  timestamptz not null default now()
);

create index if not exists rent_reports_geog_idx on public.rent_reports using gist (geog);

alter table public.rent_reports enable row level security;
revoke all on public.rent_reports from anon, authenticated;   -- goes through submit_rent_report only

-- ---------------------------------------------------------------------
-- seekers — "I'm looking for a flat". A demand-side pin: budget, type,
-- optional BHK, a radius, an email. seeker_notifications is the dedupe
-- ledger so a seeker is never emailed the same listing twice.
-- ---------------------------------------------------------------------
create table if not exists public.seekers (
  id          uuid primary key default gen_random_uuid(),
  email       text not null check (position('@' in email) > 1),
  type        listing_type not null default 'rent' check (type in ('rent', 'sharing', 'sale')),
  budget_min  numeric(12,2) check (budget_min >= 0),
  budget_max  numeric(12,2) check (budget_max >= 0),
  bhk         text check (bhk in ('1','2','3','4','5+')),
  lat         double precision not null check (lat between -90 and 90),
  lng         double precision not null check (lng between -180 and 180),
  geog        geography(Point, 4326) generated always as
              (ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography) stored,
  radius_m    integer not null default 3000 check (radius_m between 250 and 25000),
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

create index if not exists seekers_geog_idx on public.seekers using gist (geog) where active;
create index if not exists seekers_email_idx on public.seekers (lower(email));

create table if not exists public.seeker_notifications (
  id         uuid primary key default gen_random_uuid(),
  seeker_id  uuid not null references public.seekers(id)  on delete cascade,
  listing_id uuid not null references public.listings(id) on delete cascade,
  sent_at    timestamptz not null default now(),
  unique (seeker_id, listing_id)
);

alter table public.seekers              enable row level security;
alter table public.seeker_notifications enable row level security;
revoke all on public.seekers              from anon, authenticated;
revoke all on public.seeker_notifications from anon, authenticated;

-- ---------------------------------------------------------------------
-- board_sightings — "Spotted a To-Let board?" A phone number spotted on
-- a physical sign in public, plus a pin. No photo upload yet — that needs
-- a Storage bucket and a moderation pass this migration deliberately
-- does not take on; text-only for now (see conversation).
--
-- The phone number here is shown PUBLICLY on the map, unlike owner_phone
-- everywhere else in this schema. That is a deliberate, narrow exception:
-- the number was already posted on a physical sign in public space by
-- whoever put the board up, not collected from a form the way an owner's
-- contact details are. It is not the same privacy question.
-- ---------------------------------------------------------------------
create table if not exists public.board_sightings (
  id          uuid primary key default gen_random_uuid(),
  phone       text not null check (phone ~ '^[6-9][0-9]{9}$'),
  note        text check (char_length(note) <= 300),
  lat         double precision not null check (lat between -90 and 90),
  lng         double precision not null check (lng between -180 and 180),
  reporter_ip text,
  created_at  timestamptz not null default now()
);

alter table public.board_sightings enable row level security;
revoke all on public.board_sightings from anon, authenticated;

-- Public read: this is the one place in the schema a phone number is
-- meant to be visible on the map, by design (see comment above).
grant select (id, phone, note, lat, lng, created_at) on public.board_sightings to anon, authenticated;

drop policy if exists board_sightings_public_read on public.board_sightings;
create policy board_sightings_public_read on public.board_sightings
  for select to anon, authenticated using (true);

-- service_role needs base grants on all three, per 0006's fix.
grant all on public.rent_reports, public.seekers, public.seeker_notifications, public.board_sightings
  to service_role;

-- ---------------------------------------------------------------------
-- avg_rent_nearby now blends rent_reports in alongside real listings —
-- same radius, same recurring-only rule, one combined sample.
-- ---------------------------------------------------------------------
create or replace function public.avg_rent_nearby(
  p_lat      double precision,
  p_lng      double precision,
  p_radius_m integer default 3000,
  p_bhk      text    default null
)
returns table (
  sample_size integer,
  avg_rent    numeric,
  median_rent numeric,
  min_rent    numeric,
  max_rent    numeric,
  radius_m    integer
)
language sql
stable
security definer
set search_path = public
as $$
  with pooled as (
    select l.price
    from public.listings l
    where l.status = 'active'
      and l.type in ('rent', 'sharing', 'rent_paid')
      and (p_bhk is null or l.bhk = p_bhk)
      and ST_DWithin(l.geog, ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography,
                      least(greatest(p_radius_m, 250), 25000))
    union all
    select r.price
    from public.rent_reports r
    where r.type in ('rent', 'sharing')
      and (p_bhk is null or r.bhk = p_bhk)
      and ST_DWithin(r.geog, ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography,
                      least(greatest(p_radius_m, 250), 25000))
  )
  select count(*)::integer,
         round(avg(price)),
         round(percentile_cont(0.5) within group (order by price)::numeric),
         min(price),
         max(price),
         least(greatest(p_radius_m, 250), 25000)
  from pooled;
$$;

grant execute on function public.avg_rent_nearby(double precision, double precision, integer, text)
  to anon, authenticated, service_role;

-- ---------------------------------------------------------------------
-- find_matching_seekers — called from listing_action right after a
-- listing is confirmed/reconfirmed active, so matches go out the moment
-- a flat actually becomes available rather than on a batch delay.
-- ---------------------------------------------------------------------
create or replace function public.find_matching_seekers(p_listing_id uuid)
returns table (id uuid, email text)
language sql
stable
security definer
set search_path = public
as $$
  select s.id, s.email
  from public.listings l
  join public.seekers s
    on s.active
   and s.type = l.type
   and (s.bhk is null or l.bhk is null or s.bhk = l.bhk)
   -- 9999999999.99 is the max numeric(12,2) can hold — budget_max and
   -- l.price are both that type, so the fallback has to fit inside it too
   -- or the comparison overflows instead of just "matching everything".
   and l.price between coalesce(s.budget_min, 0) and coalesce(s.budget_max, 9999999999.99)
   and ST_DWithin(s.geog, l.geog, s.radius_m)
  where l.id = p_listing_id
    and not exists (
      select 1 from public.seeker_notifications sn
      where sn.seeker_id = s.id and sn.listing_id = l.id
    );
$$;

revoke execute on function public.find_matching_seekers(uuid) from anon, authenticated;
grant  execute on function public.find_matching_seekers(uuid) to service_role;

-- ---------------------------------------------------------------------
-- board_sightings_in_bounds — points for the frontend marker layer.
-- ---------------------------------------------------------------------
create or replace function public.board_sightings_in_bounds(
  min_lat double precision, min_lng double precision,
  max_lat double precision, max_lng double precision
)
returns table (id uuid, lat double precision, lng double precision, phone text, note text)
language sql stable security definer set search_path = public as $$
  select b.id, b.lat, b.lng, b.phone, b.note
  from public.board_sightings b
  where b.lat between min_lat and max_lat
    and b.lng between min_lng and max_lng
  order by b.created_at desc
  limit 500;
$$;

grant execute on function public.board_sightings_in_bounds(
  double precision, double precision, double precision, double precision
) to anon, authenticated, service_role;
