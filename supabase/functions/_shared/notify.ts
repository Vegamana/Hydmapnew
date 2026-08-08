// The one place that knows how to notify a listing owner about an enquiry.
// handle_interest_submission calls it inline (no extra cold start), and the
// send_interest_email function exposes it over HTTP for retries from Python.
import { db } from "./db.ts";
import { reserveToken, send } from "./resend.ts";
import { interestEmail, listingConfirmationEmail, seekerMatchEmail } from "./templates.ts";

export async function notifyOwnerOfInterest(interestId: string) {
  const sb = db();

  const { data: interest, error: iErr } = await sb
    .from("interests")
    .select("id, listing_id, name, phone, email, message, payment_status, created_at, email_sent_at")
    .eq("id", interestId)
    .single();
  if (iErr || !interest) throw new Error(`interest ${interestId} not found`);

  if (interest.email_sent_at) return { skipped: true as const, reason: "already sent" };

  const { data: listing, error: lErr } = await sb
    .from("listings")
    .select("id, title, price, type, locality, owner_email, lat, lng")
    .eq("id", interest.listing_id)
    .single();
  if (lErr || !listing) throw new Error(`listing ${interest.listing_id} not found`);

  const siteUrl    = Deno.env.get("SITE_URL") ?? "https://example.pages.dev";
  const actionBase = `${Deno.env.get("SUPABASE_URL")}/functions/v1/listing_action`;

  const ev = await reserveToken({
    to: listing.owner_email,
    kind: "interest_notification",
    listingId: listing.id,
    interestId: interest.id,
  });

  const mail = interestEmail({
    token: ev.token,
    listingTitle: listing.title,
    listingPrice: Number(listing.price),
    listingType: listing.type,
    listingLocality: listing.locality,
    mapUrl: `${siteUrl}/?listing=${listing.id}`,
    actionBase,
    name: interest.name,
    phone: interest.phone,
    email: interest.email,
    message: interest.message ?? undefined,
    paid: interest.payment_status === "success",
    createdAt: new Date(interest.created_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
  });

  try {
    await send({
      to: listing.owner_email,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
      // Replies land in the inbox that email_processor.py polls; the token in
      // the subject line is what maps a reply back to this listing.
      replyTo: interest.email,
      kind: "interest_notification",
      listingId: listing.id,
      interestId: interest.id,
      eventId: ev.id,
      token: ev.token,
    });

    await sb.from("interests")
      .update({ email_sent_at: new Date().toISOString(), email_error: null })
      .eq("id", interest.id);

    return { skipped: false as const, token: ev.token };
  } catch (e) {
    // Never lose the lead: record the failure and let the Python retry job
    // pick it up from the interests_undelivered_idx index.
    await sb.from("interests")
      .update({ email_error: String(e).slice(0, 500) })
      .eq("id", interest.id);
    throw e;
  }
}

/** The confirm-to-publish email a new listing's owner gets right after submitting. */
export async function notifyOwnerToConfirmListing(listingId: string) {
  const sb = db();

  const { data: listing, error } = await sb
    .from("listings")
    .select("id, title, price, type, owner_email, status")
    .eq("id", listingId)
    .single();
  if (error || !listing) throw new Error(`listing ${listingId} not found`);

  const actionBase = `${Deno.env.get("SUPABASE_URL")}/functions/v1/listing_action`;

  const ev = await reserveToken({
    to: listing.owner_email,
    kind: "listing_confirmation",
    listingId: listing.id,
  });

  const mail = listingConfirmationEmail({
    token: ev.token,
    listingTitle: listing.title,
    listingPrice: Number(listing.price),
    listingType: listing.type,
    confirmUrl: `${actionBase}?token=${ev.token}&action=confirm`,
  });

  await send({
    to: listing.owner_email,
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
    kind: "listing_confirmation",
    listingId: listing.id,
    eventId: ev.id,
    token: ev.token,
  });

  return { token: ev.token };
}

/**
 * Called right after a listing goes active (fresh confirm, or a
 * "still available" reconfirm) — finds seekers whose pin/budget/type match
 * and emails each one, once. A send failure for one seeker must not stop
 * the rest, and a DB failure recording the dedupe row must not crash the
 * caller: listing_action's real job (confirming the listing) already
 * succeeded by the time this runs.
 */
export async function notifySeekerMatches(listingId: string) {
  const sb = db();

  const { data: listing, error } = await sb
    .from("listings")
    .select("id, title, price, type")
    .eq("id", listingId)
    .single();
  if (error || !listing) return { matched: 0 };

  const { data: seekers, error: matchErr } = await sb.rpc("find_matching_seekers", { p_listing_id: listingId });
  if (matchErr || !seekers?.length) return { matched: 0 };

  const siteUrl = Deno.env.get("SITE_URL") ?? "https://example.pages.dev";
  const mail = seekerMatchEmail({
    listingTitle: listing.title,
    listingPrice: Number(listing.price),
    listingType: listing.type,
    mapUrl: `${siteUrl}/?listing=${listing.id}`,
  });

  let sent = 0;
  for (const seeker of seekers as { id: string; email: string }[]) {
    try {
      await send({ to: seeker.email, subject: mail.subject, html: mail.html, text: mail.text, kind: "seeker_match" });
      await sb.from("seeker_notifications").insert({ seeker_id: seeker.id, listing_id: listing.id });
      sent += 1;
    } catch (e) {
      console.error("seeker match email failed", seeker.id, e);
    }
  }
  return { matched: sent };
}
