-- =====================================================================
-- 0008_get_clusters_listing_type.sql — get_clusters now returns
-- listing_type, so the frontend can colour an individual-listing chip
-- by its real category (rent/sharing/rent_paid) instead of only
-- recurring-vs-sale. NULL for aggregate tiers (cluster/price_range) —
-- a bucket can mix rent/sharing/rent_paid, so no single type describes
-- it; 0003_functions.sql already has this shape for a fresh install,
-- this migration is what actually applies it to a database that ran
-- 0003 before this column existed.
-- =====================================================================

-- Postgres won't let CREATE OR REPLACE change a function's return columns
-- (adding listing_type here) — the old signature has to go first.
drop function if exists public.get_clusters(
  double precision, double precision, double precision, double precision,
  integer, listing_type, numeric, numeric
);

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
             avg(f.lat)          as clat,
             avg(f.lng)          as clng,
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
           null::text
    from bucketed b
    order by b.n desc
    limit 300;
end $$;

-- DROP wipes grants along with the old function — reinstate them.
grant execute on function public.get_clusters(
  double precision, double precision, double precision, double precision,
  integer, listing_type, numeric, numeric
) to anon, authenticated, service_role;
