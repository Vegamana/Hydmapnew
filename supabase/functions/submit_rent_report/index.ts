// POST /functions/v1/submit_rent_report
//
// "What rent are you paying?" — the lightest of the four map-click actions.
// No email, no confirmation loop: it's a bare data point that folds straight
// into avg_rent_nearby (see 0007_map_click_actions.sql). The only thing
// worth guarding against is one IP hammering the average with junk, so the
// rate limit is by IP instead of by email like everywhere else — there's no
// email here to limit by.
import { preflight, json, fail, readJson, clientIp } from "../_shared/http.ts";
import { db } from "../_shared/db.ts";
import { parseRentReport } from "../_shared/validate.ts";

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return fail(req, "Use POST.", 405);

  const parsed = parseRentReport(await readJson<Record<string, unknown>>(req));
  if (parsed.error || !parsed.data) return fail(req, parsed.error!);
  const input = parsed.data;

  const sb = db();
  const ip = clientIp(req);

  const { count: recent } = await sb
    .from("rent_reports")
    .select("id", { count: "exact", head: true })
    .eq("reporter_ip", ip)
    .gte("created_at", new Date(Date.now() - 3600 * 1000).toISOString());

  if ((recent ?? 0) >= 5) {
    return fail(req, "Too many reports from this connection. Try again in an hour.", 429);
  }

  const { error } = await sb.from("rent_reports").insert({
    price: input.price,
    type: input.type,
    bhk: input.bhk,
    lat: input.lat,
    lng: input.lng,
    reporter_ip: ip,
  });

  if (error) {
    console.error("rent report insert failed", error);
    return fail(req, "Could not save that. Try again.", 500);
  }

  return json(req, { ok: true, message: "Thanks — that's folded into the average for this area now." });
});
