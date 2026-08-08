// GET /functions/v1/listing_action?token=<token>&action=rented|available
//
// The one-click endpoint behind every email CTA. No login, no session — the
// random 18-char token in email_events is the credential, and it only ever
// maps to a single listing.
//
// Deploy with --no-verify-jwt: this URL is opened straight from a mail client.
import { corsHeaders } from "../_shared/http.ts";
import { db } from "../_shared/db.ts";
import { notifySeekerMatches } from "../_shared/notify.ts";

function page(title: string, body: string, ok: boolean) {
  const accent = ok ? "#0F6F5C" : "#B4472F";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>
  :root { color-scheme: light }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:#F3F5F4;
         font-family:ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif; color:#0E1A24; padding:24px }
  .card { max-width:440px; background:#fff; border:1px solid #E1E6E4; border-radius:16px; padding:32px; text-align:center }
  .mark { width:44px; height:44px; border-radius:50%; background:${accent}1a; color:${accent};
          display:grid; place-items:center; margin:0 auto 18px; font-size:22px }
  h1 { font-size:20px; margin:0 0 10px } p { margin:0 0 20px; line-height:1.6; color:#4A5A64 }
  a { color:${accent}; font-weight:600; text-decoration:none }
</style></head><body><div class="card">
<div class="mark">${ok ? "✓" : "!"}</div><h1>${title}</h1><p>${body}</p>
<a href="${Deno.env.get("SITE_URL") ?? "/"}">Open the map</a></div></body></html>`;
}

Deno.serve(async (req) => {
  const headers = { ...corsHeaders(req.headers.get("origin")), "Content-Type": "text/html; charset=utf-8" };
  const url = new URL(req.url);
  const token  = (url.searchParams.get("token")  ?? "").trim();
  const action = (url.searchParams.get("action") ?? "").trim();

  if (!/^[a-f0-9]{18}$/.test(token) || !["rented", "available", "confirm"].includes(action)) {
    return new Response(page("That link did not work", "Check that you copied the whole link from the email.", false),
      { status: 400, headers });
  }

  const { data, error } = await db().rpc("apply_email_action", { p_token: token, p_action: action });
  if (error) {
    console.error("apply_email_action failed", error);
    return new Response(page("Something went wrong", "Try the link again in a minute.", false), { status: 500, headers });
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

  return new Response(page(title, row?.message ?? "", Boolean(row?.ok)), { status: row?.ok ? 200 : 410, headers });
});
