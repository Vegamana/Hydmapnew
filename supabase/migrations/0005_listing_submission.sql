-- =====================================================================
-- 0005_listing_submission.sql — lets an owner post a flat themselves.
--
-- Same no-login philosophy as the rest of the app: a new listing goes in
-- as 'pending' (invisible — the public read policy in 0002_rls.sql only
-- shows status = 'active'), the owner gets an email with a one-click
-- confirm link, and only clicking that link publishes it. That single
-- step is the only thing standing between "anyone can type a form" and
-- a listing actually appearing with someone's contact details attached —
-- it stops a stranger from posting a flat against an email they don't
-- control, the same way email verification works everywhere else.
-- =====================================================================

alter type public.listing_status add value if not exists 'pending';

-- email_events.kind gets a third value for the confirmation send.
alter table public.email_events drop constraint if exists email_events_kind_check;
alter table public.email_events add constraint email_events_kind_check
  check (kind in ('interest_notification', 'aging_reminder', 'comment_notification', 'listing_confirmation'));

-- apply_email_action gains a 'confirm' branch: pending -> active, and puts
-- the listing on the same 30-day aging ladder as any other confirmation.
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

  if p_action = 'confirm' then
    if lst.status = 'active' then
      return query select true, lst.title, 'Already confirmed — this listing is live on the map.';
      return;
    end if;
    if lst.status <> 'pending' then
      return query select false, lst.title, 'This listing is no longer waiting on confirmation.';
      return;
    end if;
    update public.listings
       set status            = 'active',
           last_confirmed_at = now(),
           expires_at        = now() + interval '30 days',
           reminder_stage    = 0
     where id = lst.id;

  elsif p_action = 'rented' then
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
         reply_intent = case p_action when 'confirm' then 'available' else p_action end,
         action_taken = p_action
   where id = ev.id;

  return query select true, lst.title,
    case p_action
      when 'confirm'   then 'Listing confirmed. It is live on the map now.'
      when 'rented'    then 'Listing closed. It no longer appears on the map.'
      else 'Listing confirmed. It stays on the map for another 30 days.'
    end;
end $$;
