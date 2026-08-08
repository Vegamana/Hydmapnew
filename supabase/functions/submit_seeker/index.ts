// POST /functions/v1/submit_seeker
//
// "I'm looking for a flat" — a demand-side pin. No confirmation loop (the
// downside of a bad seeker row is a stray email match, not a fake listing
// with someone else's contact details attached, so the stakes are lower
// than submit_listing). Matching itself happens in listing_action, the
// moment a listing goes active — see find_matching_seekers.
import { preflight, json, fail, readJson } from "../_shared/http.ts";
import { db } from "../_shared/db.ts";
import { parseSeeker } from "../_shared/validate.ts";

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return fail(req, "Use POST.", 405);

  const parsed = parseSeeker(await readJson<Record<string, unknown>>(req));
  if (parsed.error || !parsed.data) return fail(req, parsed.error!);
  const input = parsed.data;

  const sb = db();

  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { count: recent } = await sb
    .from("seekers")
    .select("id", { count: "exact", head: true })
    .eq("email", input.email)
    .gte("created_at", since);

  if ((recent ?? 0) >= 3) {
    return fail(req, "You already have pins saved from this address today. Try again tomorrow.", 429);
  }

  const { error } = await sb.from("seekers").insert({
    email: input.email,
    type: input.type,
    budget_min: input.budget_min,
    budget_max: input.budget_max,
    bhk: input.bhk,
    lat: input.lat,
    lng: input.lng,
    radius_m: input.radius_m,
  });

  if (error) {
    console.error("seeker insert failed", error);
    return fail(req, "Could not save that. Try again.", 500);
  }

  return json(req, {
    ok: true,
    message: "Saved. We'll email you the moment a matching flat goes live nearby.",
  });
});
