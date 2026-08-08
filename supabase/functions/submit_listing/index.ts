// POST /functions/v1/submit_listing
//
// The "List my flat" write path. A new row goes in as status = 'pending'
// (invisible — see 0002_rls.sql's `status = 'active'` read policy), then an
// email goes to owner_email with a one-click confirm link. Nothing appears
// on the map, and no contact details go anywhere, until that link is
// clicked — the only guard against a stranger posting a flat against an
// email address they don't control.
import { preflight, json, fail, readJson, clientIp } from "../_shared/http.ts";
import { db } from "../_shared/db.ts";
import { parseListingSubmission } from "../_shared/validate.ts";
import { notifyOwnerToConfirmListing } from "../_shared/notify.ts";

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return fail(req, "Use POST.", 405);

  const parsed = parseListingSubmission(await readJson<Record<string, unknown>>(req));
  if (parsed.error || !parsed.data) return fail(req, parsed.error!);
  const input = parsed.data;

  const sb = db();

  // --- rate limit -----------------------------------------------------
  // One address flooding the map with fake listings is the whole threat
  // model here, so the ceiling is tight and counts pending + active alike.
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { count: recent } = await sb
    .from("listings")
    .select("id", { count: "exact", head: true })
    .eq("owner_email", input.owner_email)
    .in("status", ["pending", "active"])
    .gte("created_at", since);

  if ((recent ?? 0) >= 5) {
    console.warn("listing rate limit hit", { ip: clientIp(req), email: input.owner_email });
    return fail(req, "Too many listings from this address today. Try again tomorrow.", 429);
  }

  // --- insert, pending confirmation ------------------------------------
  const { data: listing, error: insErr } = await sb
    .from("listings")
    .insert({
      title: input.title,
      type: input.type,
      price: input.price,
      lat: input.lat,
      lng: input.lng,
      bhk: input.bhk,
      furnishing: input.furnishing,
      gated: input.gated,
      deposit: input.deposit,
      parking: input.parking,
      square_footage: input.square_footage,
      gender_preference: input.gender_preference,
      description: input.description,
      owner_email: input.owner_email,
      owner_phone: input.owner_phone,
      status: "pending",
    })
    .select("id")
    .single();

  if (insErr || !listing) {
    console.error("listing insert failed", insErr);
    return fail(req, "Could not save that listing. Try again.", 500);
  }

  // --- email the confirm link -------------------------------------------
  let emailed = false;
  try {
    await notifyOwnerToConfirmListing(listing.id);
    emailed = true;
  } catch (e) {
    // The row exists but nobody can see it without confirming, so an
    // undelivered email just means it never gets confirmed — no lead is
    // lost the way a failed interest-notification would be. Log and move on;
    // the owner can be told to contact support if this keeps happening.
    console.error("listing confirmation email failed", e);
  }

  return json(req, {
    ok: true,
    listing_id: listing.id,
    emailed,
    message: emailed
      ? "Check your email for a link to confirm and publish this listing."
      : "Saved, but the confirmation email could not be sent. Contact support.",
  });
});
