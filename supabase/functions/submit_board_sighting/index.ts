// POST /functions/v1/submit_board_sighting
//
// "Spotted a To-Let board?" Phone number off a physical sign, plus a pin.
// Goes live immediately — no confirm loop, because there's no owner
// identity to protect here the way submit_listing protects one. See
// 0007_map_click_actions.sql for why this is the one place in the schema
// a phone number is shown publicly.
//
// No photo upload yet: that needs a Storage bucket and a moderation pass
// this function deliberately doesn't take on. Text-only for now.
import { preflight, json, fail, readJson, clientIp } from "../_shared/http.ts";
import { db } from "../_shared/db.ts";
import { parseBoardSighting } from "../_shared/validate.ts";

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return fail(req, "Use POST.", 405);

  const parsed = parseBoardSighting(await readJson<Record<string, unknown>>(req));
  if (parsed.error || !parsed.data) return fail(req, parsed.error!);
  const input = parsed.data;

  const sb = db();
  const ip = clientIp(req);

  const { count: recent } = await sb
    .from("board_sightings")
    .select("id", { count: "exact", head: true })
    .eq("reporter_ip", ip)
    .gte("created_at", new Date(Date.now() - 3600 * 1000).toISOString());

  if ((recent ?? 0) >= 5) {
    return fail(req, "Too many reports from this connection. Try again in an hour.", 429);
  }

  const { error } = await sb.from("board_sightings").insert({
    phone: input.phone,
    note: input.note,
    lat: input.lat,
    lng: input.lng,
    reporter_ip: ip,
  });

  if (error) {
    console.error("board sighting insert failed", error);
    return fail(req, "Could not save that. Try again.", 500);
  }

  return json(req, { ok: true, message: "On the map now — thanks for the tip." });
});
