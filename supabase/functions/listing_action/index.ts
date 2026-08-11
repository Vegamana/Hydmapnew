// GET /functions/v1/listing_action?token=<token>&action=rented|available|confirm
//
// The one-click endpoint behind every email CTA. No login, no session — the
// random 18-char token in email_events is the credential, and it only ever
// maps to a single listing.
//
// This does its job, then redirects to the frontend rather than serving its
// own HTML page: Supabase's hosted edge gateway overrides an edge function's
// Content-Type on an HTML response (forces text/plain, plus a sandboxed CSP)
// as a platform-level hardening measure we don't control — the browser then
// correctly refuses to render it and shows the raw markup as text instead of
// a page. Redirecting to our own frontend, which we do control, sidesteps
// that entirely; app.js reads the result out of the query string and shows
// it as a toast.
//
// Deploy with --no-verify-jwt: this URL is opened straight from a mail client.
import { corsHeaders } from "../_shared/http.ts";
import { db } from "../_shared/db.ts";
import { notifySeekerMatches } from "../_shared/notify.ts";

function redirectTo(title: string, message: string, ok: boolean, req: Request) {
  const base = Deno.env.get("SITE_URL") ?? "/";
  const url = new URL(base);
  url.searchParams.set("action_result", ok ? "ok" : "fail");
  url.searchParams.set("action_title", title);
  url.searchParams.set("action_message", message);
  return new Response(null, {
    status: 302,
    headers: { ...corsHeaders(req.headers.get("origin")), Location: url.toString() },
  });
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const token  = (url.searchParams.get("token")  ?? "").trim();
  const action = (url.searchParams.get("action") ?? "").trim();

  if (!/^[a-f0-9]{18}$/.test(token) || !["rented", "available", "confirm"].includes(action)) {
    return redirectTo("That link did not work", "Check that you copied the whole link from the email.", false, req);
  }

  const { data, error } = await db().rpc("apply_email_action", { p_token: token, p_action: action });
  if (error) {
    console.error("apply_email_action failed", error);
    return redirectTo("Something went wrong", "Try the link again in a minute.", false, req);
  }

  const row = Array.isArray(data) ? data[0] : data;
  const title = row?.ok
    ? (action === "rented" ? "Listing closed" : "Listing confirmed")
    : "That link is no longer valid";

  // The listing just went active (confirm, or an "available" reconfirm) —
  // tell anyone whose seeker pin matches. Best-effort: the confirmation
  // itself already succeeded, so a matching failure here shouldn't turn
  // into an error page for the owner who just clicked their own email.
  if (row?.ok && (action === "confirm" || action === "available")) {
    try {
      const { data: ev } = await db().from("email_events").select("listing_id").eq("token", token).single();
      if (ev?.listing_id) await notifySeekerMatches(ev.listing_id);
    } catch (e) {
      console.error("seeker match dispatch failed", e);
    }
  }

  return redirectTo(title, row?.message ?? "", Boolean(row?.ok), req);
});
