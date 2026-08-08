// POST /functions/v1/create_razorpay_order   { "interest_id": "<uuid>" }
//
// Used when someone submits without paying and then changes their mind, or
// when the checkout is retried after a network drop. Amount comes from the
// server, never from the client.
import { preflight, json, fail, readJson } from "../_shared/http.ts";
import { db } from "../_shared/db.ts";
import { UUID_RE } from "../_shared/validate.ts";
import { createOrder } from "../_shared/razorpay.ts";

const AMOUNT = Number(Deno.env.get("INTEREST_AMOUNT_PAISE") ?? "100");

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return fail(req, "Use POST.", 405);
  if ((Deno.env.get("PAYMENTS_ENABLED") ?? "true") !== "true") {
    return fail(req, "Payments are switched off.", 503);
  }

  const body = await readJson<{ interest_id?: string }>(req);
  const id = body?.interest_id ?? "";
  if (!UUID_RE.test(id)) return fail(req, "interest_id must be a uuid.");

  const sb = db();
  const { data: interest } = await sb
    .from("interests")
    .select("id, payment_status, razorpay_order_id, listing_id")
    .eq("id", id)
    .maybeSingle();

  if (!interest) return fail(req, "Enquiry not found.", 404);
  if (interest.payment_status === "success") {
    return json(req, { ok: true, already_paid: true });
  }

  try {
    const order = await createOrder({
      amountPaise: AMOUNT,
      receipt: interest.id,
      notes: { interest_id: interest.id, listing_id: interest.listing_id },
    });
    await sb.from("interests")
      .update({ razorpay_order_id: order.id, payment_status: "pending", amount_paise: AMOUNT })
      .eq("id", interest.id);

    return json(req, {
      ok: true,
      order_id: order.id,
      amount: order.amount,
      currency: order.currency,
      key_id: Deno.env.get("RAZORPAY_KEY_ID"),
    });
  } catch (e) {
    console.error("create order failed", e);
    return fail(req, "Could not start the payment. Your enquiry is already saved.", 502);
  }
});
