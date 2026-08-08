-- =====================================================================
-- 0006_service_role_grants.sql — service_role is missing base table
-- grants on every table in this project, not just the ones touched by
-- 0005.
--
-- RLS-bypass and table-level GRANT are two independent gates in Postgres:
-- `service_role` bypassing RLS (it does, by role attribute) says nothing
-- about whether it may touch the table at all. 0002_rls.sql revoked from
-- and re-granted to `anon`/`authenticated` explicitly, but never granted
-- anything to `service_role` — it was relying on an ambient grant that
-- does not exist on this stack. Every edge function that writes through
-- the service-role client (handle_interest_submission, submit_listing,
-- listing_action, the comment insert path, etc.) would hit "permission
-- denied for table X" the moment it actually ran.
-- =====================================================================

grant all on
  public.listings,
  public.interests,
  public.comments,
  public.email_events,
  public.places_cache,
  public.area_stats
to service_role;
