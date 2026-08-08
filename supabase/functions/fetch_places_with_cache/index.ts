// POST /functions/v1/fetch_places_with_cache
//   { "type": "biryani" | "gym" | "hospital", "lat": 17.44, "lng": 78.39, "radius": 1500 }
//
// This is the only place in the system that spends money on Google Places.
// Cost controls, in order of effect:
//   1. Coordinates are snapped to 3 decimals (~110 m) before the cache lookup,
//      so panning a few pixels reuses the same row instead of billing again.
//   2. Radius is snapped to a fixed ladder (500/1000/1500/3000 m).
//   3. Results live for 30 days; hit_count feeds cache_warmer.py.
//   4. Only the fields we render are requested (Places API field masking).
//   5. The Places key never reaches the browser.
import { preflight, json, fail, readJson } from "../_shared/http.ts";
import { db } from "../_shared/db.ts";

const PLACES_URL = "https://places.googleapis.com/v1/places:searchNearby";
const TEXT_URL   = "https://places.googleapis.com/v1/places:searchText";

// Product categories -> Google's vocabulary. Biryani has no place type, so it
// is a text search; everything else is a cheaper nearby search.
const CATEGORIES: Record<string, { placeType?: string; textQuery?: string; emoji: string; label: string }> = {
  biryani:  { textQuery: "biryani restaurant", emoji: "🍗", label: "Biryani" },
  gym:      { placeType: "gym",                emoji: "💪", label: "Gyms" },
  hospital: { placeType: "hospital",           emoji: "🏥", label: "Hospitals" },
  pharmacy: { placeType: "pharmacy",           emoji: "💊", label: "Pharmacies" },
  supermarket: { placeType: "supermarket",     emoji: "🛒", label: "Supermarkets" },
  school:   { placeType: "school",             emoji: "🎒", label: "Schools" },
};

const RADIUS_LADDER = [500, 1000, 1500, 3000];
const FIELD_MASK = "places.id,places.displayName,places.location,places.rating,places.userRatingCount,places.formattedAddress,places.priceLevel";

function snapRadius(r: number): number {
  return RADIUS_LADDER.reduce((best, step) =>
    Math.abs(step - r) < Math.abs(best - r) ? step : best, RADIUS_LADDER[0]);
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return fail(req, "Use POST.", 405);

  const body = await readJson<{ type?: string; lat?: number; lng?: number; radius?: number }>(req);
  const type = String(body?.type ?? "");
  const category = CATEGORIES[type];
  if (!category) return fail(req, `Unknown category. Try one of: ${Object.keys(CATEGORIES).join(", ")}`);

  const lat = Number(body?.lat), lng = Number(body?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return fail(req, "lat and lng are required.");
  if (lat < 16.5 || lat > 18.5 || lng < 77.5 || lng > 79.5) {
    return fail(req, "Coordinates are outside the Hyderabad service area.");   // hard cost fence
  }

  const radius = snapRadius(Number(body?.radius ?? 1500));
  const sb = db();

  // ---- 1. cache ----------------------------------------------------------
  const { data: cached } = await sb.rpc("get_cached_places", {
    p_type: type, p_lat: round3(lat), p_lng: round3(lng), p_radius: radius,
  });

  if (cached) {
    return json(req, { ok: true, source: "cache", type, radius, ...category, places: cached });
  }

  // ---- 2. Google ---------------------------------------------------------
  const key = Deno.env.get("GOOGLE_PLACES_API_KEY");
  if (!key) return fail(req, "Places lookup is not configured.", 500);

  const headers = {
    "Content-Type": "application/json",
    "X-Goog-Api-Key": key,
    "X-Goog-FieldMask": FIELD_MASK,
  };

  const locationBias = { circle: { center: { latitude: lat, longitude: lng }, radius } };

  let res: Response;
  if (category.textQuery) {
    res = await fetch(TEXT_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({ textQuery: category.textQuery, locationBias, maxResultCount: 12, languageCode: "en" }),
    });
  } else {
    res = await fetch(PLACES_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({
        includedTypes: [category.placeType],
        maxResultCount: 12,
        locationRestriction: { circle: { center: { latitude: lat, longitude: lng }, radius } },
        rankPreference: "POPULARITY",
      }),
    });
  }

  if (!res.ok) {
    console.error("places api error", res.status, await res.text());
    return fail(req, "Could not load nearby places right now.", 502);
  }

  const raw = await res.json();

  // Keep only what the UI draws — smaller rows, smaller responses, no PII.
  const places = (raw.places ?? []).map((p: Record<string, any>) => ({
    id: p.id,
    name: p.displayName?.text ?? "",
    lat: p.location?.latitude,
    lng: p.location?.longitude,
    rating: p.rating ?? null,
    reviews: p.userRatingCount ?? null,
    address: p.formattedAddress ?? null,
    price_level: p.priceLevel ?? null,
  })).filter((p: any) => Number.isFinite(p.lat) && Number.isFinite(p.lng));

  // ---- 3. store ----------------------------------------------------------
  const { error: cacheErr } = await sb.from("places_cache").upsert({
    type, lat: round3(lat), lng: round3(lng), radius, data: places,
    expires_at: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
  }, { onConflict: "type,lat_key,lng_key,radius" });

  if (cacheErr) console.error("cache write failed", cacheErr);  // serve anyway

  return json(req, { ok: true, source: "google", type, radius, ...category, places });
});
