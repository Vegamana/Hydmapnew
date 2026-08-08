-- =====================================================================
-- 0002_rls.sql — Row Level Security
--
-- Threat model: there is no login, so every browser holds the `anon` key.
-- Assume it is public. Therefore:
--   * anon may READ active listings, but only the columns we grant.
--   * anon may NEVER read owner_email / owner_phone — enforced by
--     column-level GRANT, which RLS alone cannot do.
--   * anon may NEVER read or write `interests` (leads are private) or
--     `places_cache` (that data cost money).
--   * Everything privileged goes through an edge function using the
--     service role key, which lives only in Supabase secrets.
-- =====================================================================

alter table public.listings     enable row level security;
alter table public.interests    enable row level security;
alter table public.places_cache enable row level security;
alter table public.comments     enable row level security;
alter table public.email_events enable row level security;
alter table public.area_stats   enable row level security;

-- ---------------------------------------------------------------------
-- listings: public read of active rows, safe columns only
-- ---------------------------------------------------------------------
revoke all on public.listings from anon, authenticated;

grant select (
  id, title, type, price, lat, lng, bhk, furnishing, gated, deposit,
  parking, square_footage, gender_preference, description, photo_urls,
  locality, status, created_at
) on public.listings to anon, authenticated;

drop policy if exists listings_public_read on public.listings;
create policy listings_public_read on public.listings
  for select to anon, authenticated
  using (status = 'active');

-- Convenience view for the frontend. security_invoker keeps the caller's
-- privileges, so the grants above still apply — the view is sugar, not a
-- privilege escalation.
create or replace view public.listings_public
  with (security_invoker = on) as
select id, title, type, price, lat, lng, bhk, furnishing, gated, deposit,
       parking, square_footage, gender_preference, description, photo_urls,
       locality, created_at
from public.listings
where status = 'active';

grant select on public.listings_public to anon, authenticated;

-- ---------------------------------------------------------------------
-- interests: no anon access at all. Service role bypasses RLS.
-- ---------------------------------------------------------------------
revoke all on public.interests    from anon, authenticated;
revoke all on public.places_cache from anon, authenticated;
revoke all on public.email_events from anon, authenticated;

-- ---------------------------------------------------------------------
-- comments: anonymous read + write, constrained by CHECKs on the table
-- ---------------------------------------------------------------------
revoke all on public.comments from anon, authenticated;
grant select (id, listing_id, author, text, created_at) on public.comments to anon, authenticated;
grant insert (listing_id, author, text) on public.comments to anon, authenticated;

drop policy if exists comments_public_read on public.comments;
create policy comments_public_read on public.comments
  for select to anon, authenticated using (true);

drop policy if exists comments_public_insert on public.comments;
create policy comments_public_insert on public.comments
  for insert to anon, authenticated
  with check (
    exists (select 1 from public.listings l
            where l.id = listing_id and l.status = 'active')
  );

-- ---------------------------------------------------------------------
-- area_stats: read-only aggregate, safe to expose
-- ---------------------------------------------------------------------
grant select on public.area_stats to anon, authenticated;

drop policy if exists area_stats_public_read on public.area_stats;
create policy area_stats_public_read on public.area_stats
  for select to anon, authenticated using (true);
