-- =====================================================================
-- 0003_functions.sql — RPCs callable from the browser (anon) and from
-- edge functions / Python (service role).
--
-- The legacy app clustered in Node memory with a 45s TTL that vanished on
-- every cold start. Here the grid aggregation happens inside Postgres, so
-- it is consistent, indexed, and costs one round trip.
-- =====================================================================

-- ---------------------------------------------------------------------
-- get_clusters — 3 tiers, matching the product's existing UX:
--   zoom <= 10 : count bubbles          (kind = 'cluster')
--   zoom 11-15 : price-range pills      (kind = 'price_range')
--   zoom >  15 : individual listing chips (kind = 'listing')
--
-- Recurring prices (rent / sharing / rent_paid) and one-time prices
-- (sale) are NEVER averaged together — they are bucketed separately and
-- returned with a price_kind so the frontend can label them.
-- ---------------------------------------------------------------------
create or replace function public.get_clusters(
  min_lat    double precision,
  min_lng    double precision,
  max_lat    double precision,
  max_lng    double precision,
  zoom       integer,
  p_type     listing_type default null,
  p_min_price numeric      default null,
  p_max_price numeric      default null
)
returns table (
  kind          text,
  lat           double precision,
  lng           double precision,
  point_count   integer,
  min_price     numeric,
  max_price     numeric,
  avg_price     numeric,
  price_kind    text,
  listing_id    uuid,
  title         text,
  listing_type  text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  grid double precision;
begin
  -- Degrees per grid cell. Roughly 22 km at zoom 8 down to 2 km at zoom 15,
  -- halving with each zoom level so bubbles stay visually separated.
  grid := case
    when zoom <=  6 then 1.000
    when zoom <=  8 then 0.500
    when zoom <= 10 then 0.200
    when zoom  = 11 then 0.100
    when zoom  = 12 then 0.050
    when zoom  = 13 then 0.025
    when zoom  = 14 then 0.012
    when zoom  = 15 then 0.006
    else 0.0
  end;

  -- Tier 3: individual listings. listing_type is real here (one row = one
  -- listing) — this is what lets the frontend colour a chip by its actual
  -- category (rent/sharing/rent_paid) instead of just recurring-vs-sale.
  if grid = 0.0 then
    return query
      select 'listing'::text,
             l.lat, l.lng, 1,
             l.price, l.price, l.price,
             case when l.type = 'sale' then 'one_time' else 'recurring' end,
             l.id, l.title, l.type::text
      from public.listings l
      where l.status = 'active'
        and l.lat between min_lat and max_lat
        and l.lng between min_lng and max_lng
        and (p_type      is null or l.type  =  p_type)
        and (p_min_price is null or l.price >= p_min_price)
        and (p_max_price is null or l.price <= p_max_price)
      order by l.created_at desc
      limit 400;
    return;
  end if;

  -- Tiers 1 & 2: snap to a grid, aggregate per cell.
  return query
    with filtered as (
      select l.lat, l.lng, l.price,
             case when l.type = 'sale' then 'one_time' else 'recurring' end as pk
      from public.listings l
      where l.status = 'active'
        and l.lat between min_lat and max_lat
        and l.lng between min_lng and max_lng
        and (p_type      is null or l.type  =  p_type)
        and (p_min_price is null or l.price >= p_min_price)
        and (p_max_price is null or l.price <= p_max_price)
      limit 20000
    ),
    bucketed as (
      select floor(f.lat / grid) as gy,
             floor(f.lng / grid) as gx,
             f.pk,
             count(*)::integer   as n,
             avg(f.lat)          as clat,   -- centroid, not cell centre:
             avg(f.lng)          as clng,   -- the bubble sits on real supply
             min(f.price)        as pmin,
             max(f.price)        as pmax,
             avg(f.price)        as pavg
      from filtered f
      group by 1, 2, 3
    )
    select case when zoom <= 10 then 'cluster' else 'price_range' end,
           b.clat, b.clng, b.n,
           round(b.pmin), round(b.pmax), round(b.pavg),
           b.pk,
           null::uuid, null::text,
           null::text   -- a bucket can mix rent/sharing/rent_paid; no single type describes it
    from bucketed b
    order by b.n desc
    limit 300;
end $$;

grant execute on function public.get_clusters(
  double precision, double precision, double precision, double precision,
  integer, listing_type, numeric, numeric
) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------
-- avg_rent_nearby — the "rent pulse" readout under the map.
-- True geodesic radius via PostGIS (ST_DWithin on geography), which is
-- exact where the old haversine scan was approximate and O(n).
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
  select count(*)::integer,
         round(avg(l.price)),
         round(percentile_cont(0.5) within group (order by l.price)::numeric),
         min(l.price),
         max(l.price),
         least(greatest(p_radius_m, 250), 25000)
  from public.listings l
  where l.status = 'active'
    and l.type in ('rent', 'sharing', 'rent_paid')   -- never mix in sale prices
    and (p_bhk is null or l.bhk = p_bhk)
    and ST_DWithin(
          l.geog,
          ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography,
          least(greatest(p_radius_m, 250), 25000)
        );
$$;

grant execute on function public.avg_rent_nearby(double precision, double precision, integer, text)
  to anon, authenticated, service_role;

-- ---------------------------------------------------------------------
-- listings_in_bounds — points for the heatmap layer (id/lat/lng/price only)
-- ---------------------------------------------------------------------
create or replace function public.listings_in_bounds(
  min_lat double precision, min_lng double precision,
  max_lat double precision, max_lng double precision
)
returns table (id uuid, lat double precision, lng double precision, price numeric)
language sql stable security definer set search_path = public as $$
  select l.id, l.lat, l.lng, l.price
  from public.listings l
  where l.status = 'active'
    and l.lat between min_lat and max_lat
    and l.lng between min_lng and max_lng
  limit 3000;
$$;

grant execute on function public.listings_in_bounds(
  double precision, double precision, double precision, double precision
) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------
-- get_cached_places — used by the fetch_places_with_cache edge function.
-- Bumps hit_count so cache_warmer.py can rank what to pre-fetch.
-- ---------------------------------------------------------------------
create or replace function public.get_cached_places(
  p_type   text,
  p_lat    double precision,
  p_lng    double precision,
  p_radius integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  hit jsonb;
begin
  update public.places_cache
     set hit_count = hit_count + 1
   where type    = p_type
     and lat_key = round(p_lat::numeric, 3)
     and lng_key = round(p_lng::numeric, 3)
     and radius  = p_radius
     and expires_at > now()
  returning data into hit;

  return hit;    -- null => caller must hit Google and then store the result
end $$;

revoke execute on function public.get_cached_places(text, double precision, double precision, integer) from anon, authenticated;
grant  execute on function public.get_cached_places(text, double precision, double precision, integer) to service_role;

-- ---------------------------------------------------------------------
-- resolve_email_token — one-click actions from an email, no login.
-- Called by the listing_action edge function.
-- ---------------------------------------------------------------------
create or replace function public.apply_email_action(p_token text, p_action text)
returns table (ok boolean, listing_title text, message text)
language plpgsql
security definer
set search_path = public
as $$
declare
  ev  public.email_events%rowtype;
  lst public.listings%rowtype;
begin
  select * into ev from public.email_events where token = p_token;
  if not found then
    return query select false, null::text, 'This link is not valid any more.';
    return;
  end if;

  select * into lst from public.listings where id = ev.listing_id;
  if not found then
    return query select false, null::text, 'That listing no longer exists.';
    return;
  end if;

  if p_action = 'rented' then
    update public.listings
       set status = 'rented', updated_at = now()
     where id = lst.id;
  elsif p_action = 'available' then
    update public.listings
       set last_confirmed_at = now(),
           reminder_stage    = 0,
           status            = 'active',
           expires_at        = now() + interval '30 days'
     where id = lst.id;
  else
    return query select false, lst.title, 'Unknown action.';
    return;
  end if;

  update public.email_events
     set replied_at   = coalesce(replied_at, now()),
         reply_intent = p_action,
         action_taken = p_action
   where id = ev.id;

  return query select true, lst.title,
    case when p_action = 'rented'
         then 'Listing closed. It no longer appears on the map.'
         else 'Listing confirmed. It stays on the map for another 30 days.' end;
end $$;

revoke execute on function public.apply_email_action(text, text) from anon, authenticated;
grant  execute on function public.apply_email_action(text, text) to service_role;
