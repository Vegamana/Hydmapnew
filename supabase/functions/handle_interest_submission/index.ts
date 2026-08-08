// POST /functions/v1/handle_interest_submission
//
// The single write path for the "I'm Interested" flow.
//   1. validate
//   2. rate-limit (same email + listing within 24h)
//   3. insert the interest        <- lead is safe from here on
//   4. optionally open a ₹1 Razorpay order
//   5. email the owner
//
// Step 4 and 5 can both fail without failing the request. Payment must never
// block submission, and an undelivered email is a retry job, not a lost lead.
import { preflight, json, fail, readJson, clientIp } from "../_shared/http.ts";
import { db } from "../_shared/db.ts";
import { parseInterest } from "../_shared/validate.ts";
import { createOrder } from "../_shared/razorpay.ts";
import { notifyOwnerOfInterest } from "../_shared/notify.ts";

const INTEREST_AMOUNT_PAISE = Number(Deno.env.get("INTEREST_AMOUNT_PAISE") ?? "100"); // ₹1
const PAYMENTS_ENABLED = (Deno.env.get("PAYMENTS_ENABLED") ?? "true") === "true";

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return fail(req, "Use POST.", 405);

  const parsed = parseInterest(await readJson<Record<string, unknown>>(req));
  if (parsed.error || !parsed.data) return fail(req, parsed.error!);
  const input = parsed.data;

  const sb = db();

  // --- listing must exist and be live -------------------------------------
  const { data: listing } = await sb
    .from("listings")
    .select("id, title, status")
    .eq("id", input.listing_id)
    .maybeSingle();

  if (!listing) return fail(req, "That listing could not be found.", 404);
  if (listing.status !== "active") {
    return fail(req, "This listing is closed. The owner marked it as no longer available.", 409);
  }

  // --- rate limit ---------------------------------------------------------
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { count: recent } = await sb
    .from("interests")
    .select("id", { count: "exact", head: true })
    .eq("listing_id", input.listing_id)
    .eq("email", input.email)
    .gte("created_at", since);

  if ((recent ?? 0) > 0) {
    return fail(req, "You already sent your details for this listing. The owner has them.", 429);
  }

  // Ceiling across all listings, so one address cannot flood every owner's inbox.
  const { count: fromEmail } = await sb
    .from("interests")
    .select("id", { count: "exact", head: true })
    .gte("created_at", new Date(Date.now() - 3600 * 1000).toISOString())
    .eq("email", input.email);
  if ((fromEmail ?? 0) > 10) {
    console.warn("rate limit hit", { ip: clientIp(req), email: input.email });
    return fail(req, "Too many enquiries from this address. Try again in an hour.", 429);
  }

  // --- 3. store the lead --------------------------------------------------
  const wantsToPay = PAYMENTS_ENABLED && input.wants_to_pay;

  const { data: interest, error: insErr } = await sb
    .from("interests")
    .insert({
      listing_id: input.listing_id,
      name: input.name,
      phone: input.phone,
      email: input.email,
      message: input.message || null,
      amount_paise: wantsToPay ? INTEREST_AMOUNT_PAISE : 0,
      payment_status: wantsToPay ? "pending" : "skipped",
    })
    .select("id, created_at")
    .single();

  if (insErr || !interest) {
    console.error("interest insert failed", insErr);
    return fail(req, "Could not save your details. Try again.", 500);
  }

  // --- 4. optional ₹1 order ----------------------------------------------
  let payment: Record<string, unknown> | null = null;
  if (wantsToPay) {
    try {
      const order = await createOrder({
        amountPaise: INTEREST_AMOUNT_PAISE,
        receipt: interest.id,
        notes: { interest_id: interest.id, listing_id: input.listing_id },
      });
      await sb.from("interests").update({ razorpay_order_id: order.id }).eq("id", interest.id);
      payment = {
        order_id: order.id,
        amount: order.amount,
        currency: order.currency,
        key_id: Deno.env.get("RAZORPAY_KEY_ID"),
      };
    } catch (e) {
      // Payment is a nice-to-have. Downgrade and carry on.
      console.error("razorpay order failed", e);
      await sb.from("interests").update({ payment_status: "skipped", amount_paise: 0 }).eq("id", interest.id);
    }
  }

  // --- 5. notify the owner ------------------------------------------------
  let emailed = false;
  try {
    await notifyOwnerOfInterest(interest.id);
    emailed = true;
  } catch (e) {
    console.error("owner notification failed", e); // retried by python/jobs/email_processor.py
  }

  return json(req, {
    ok: true,
    interest_id: interest.id,
    emailed,
    payment,
    message: "Your details are with the owner. They will email or call you.",
  });
});
