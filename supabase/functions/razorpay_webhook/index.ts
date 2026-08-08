// POST /functions/v1/razorpay_webhook
//
// Razorpay is the source of truth for payment state, not the browser. The
// checkout callback is a hint; this webhook is the record. Deploy with
// --no-verify-jwt (Razorpay cannot send a Supabase JWT) — the HMAC signature
// is the authentication.
import { preflight, json, fail } from "../_shared/http.ts";
import { db } from "../_shared/db.ts";
import { verifySignature } from "../_shared/razorpay.ts";

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return fail(req, "Use POST.", 405);

  const secret = Deno.env.get("RAZORPAY_WEBHOOK_SECRET");
  if (!secret) return fail(req, "Webhook secret is not configured.", 500);

  const raw = await req.text();                       // sign the raw body, not a reparse
  const signature = req.headers.get("x-razorpay-signature") ?? "";
  if (!await verifySignature(raw, signature, secret)) {
    console.warn("rejected webhook: bad signature");
    return fail(req, "Invalid signature.", 401);
  }

  const event = JSON.parse(raw);
  const entity = event?.payload?.payment?.entity ?? {};
  const orderId   = entity.order_id;
  const paymentId = entity.id;
  const interestId = entity.notes?.interest_id;

  if (!orderId && !interestId) return json(req, { ok: true, ignored: true });

  const status =
    event.event === "payment.captured" || event.event === "order.paid" ? "success" :
    event.event === "payment.failed" ? "failed" : null;

  if (!status) return json(req, { ok: true, ignored: event.event });

  const sb = db();
  const q = sb.from("interests")
    .update({ payment_status: status, razorpay_payment_id: paymentId ?? null });

  const { error } = interestId
    ? await q.eq("id", interestId)
    : await q.eq("razorpay_order_id", orderId);

  if (error) {
    console.error("webhook update failed", error);
    return fail(req, "Update failed.", 500);
  }
  return json(req, { ok: true, status });
});
