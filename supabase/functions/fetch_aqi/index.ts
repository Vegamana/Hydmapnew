// POST /functions/v1/fetch_aqi   { "lat": 17.44, "lng": 78.39 }
//
// Air quality for the AQI overlay. Same cache table as Places, with a short
// TTL because AQI actually changes: rows are written with type='aqi' and a
// 45-minute expiry, keyed on coordinates rounded to 3 decimals.
import { preflight, json, fail, readJson } from "../_shared/http.ts";
import { db } from "../_shared/db.ts";

const round3 = (n: number) => Math.round(n * 1000) / 1000;
const TTL_MINUTES = 45;

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return fail(req, "Use POST.", 405);

  const body = await readJson<{ lat?: number; lng?: number }>(req);
  const lat = Number(body?.lat), lng = Number(body?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return fail(req, "lat and lng are required.");

  const sb = db();
  const { data: cached } = await sb.rpc("get_cached_places", {
    p_type: "aqi", p_lat: round3(lat), p_lng: round3(lng), p_radius: 1000,
  });
  if (cached) return json(req, { ok: true, source: "cache", ...cached });

  const token = Deno.env.get("WAQI_TOKEN");
  if (!token) return fail(req, "AQI is not configured.", 500);

  const res = await fetch(`https://api.waqi.info/feed/geo:${lat};${lng}/?token=${token}`);
  const raw = await res.json().catch(() => null);
  if (!res.ok || raw?.status !== "ok") return fail(req, "Could not read air quality right now.", 502);

  const reading = {
    aqi: raw.data?.aqi ?? null,
    station: raw.data?.city?.name ?? null,
    updated: raw.data?.time?.iso ?? null,
    dominant: raw.data?.dominentpol ?? null,
  };

  await sb.from("places_cache").upsert({
    type: "aqi", lat: round3(lat), lng: round3(lng), radius: 1000, data: reading,
    expires_at: new Date(Date.now() + TTL_MINUTES * 60_000).toISOString(),
  }, { onConflict: "type,lat_key,lng_key,radius" });

  return json(req, { ok: true, source: "waqi", ...reading });
});
