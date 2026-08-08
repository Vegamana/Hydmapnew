// POST /functions/v1/send_interest_email   { "interest_id": "<uuid>" }
//
// Standalone wrapper around the shared notifier. Used for:
//   * manual re-sends
//   * the retry sweep in python/jobs/email_processor.py
// Requires the service role key in the Authorization header — this is not a
// public endpoint (verify_jwt stays on for this function).
import { preflight, json, fail, readJson } from "../_shared/http.ts";
import { UUID_RE } from "../_shared/validate.ts";
import { notifyOwnerOfInterest } from "../_shared/notify.ts";

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return fail(req, "Use POST.", 405);

  const body = await readJson<{ interest_id?: string }>(req);
  const id = body?.interest_id ?? "";
  if (!UUID_RE.test(id)) return fail(req, "interest_id must be a uuid.");

  try {
    const result = await notifyOwnerOfInterest(id);
    return json(req, { ok: true, ...result });
  } catch (e) {
    console.error("send_interest_email failed", e);
    return fail(req, String(e), 502);
  }
});
