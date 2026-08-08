/**
 * The only module that talks to the network.
 *
 * Three cost controls live here, because this is the choke point:
 *   1. inflight coalescing — a repeated identical request while one is in
 *      flight returns the same promise instead of a second call
 *   2. a small in-memory response cache with per-endpoint TTLs, so panning
 *      back to where you just were is free
 *   3. AbortController on cluster requests, so a fast pan cancels the stale
 *      query instead of racing it
 */
import { CONFIG } from "./config.js";

const REST = `${CONFIG.SUPABASE_URL}/rest/v1`;
const FNS = `${CONFIG.SUPABASE_URL}/functions/v1`;

const headers = () => ({
  apikey: CONFIG.SUPABASE_ANON_KEY,
  Authorization: `Bearer ${CONFIG.SUPABASE_ANON_KEY}`,
  "Content-Type": "application/json",
});

// ── tiny cache ────────────────────────────────────────────────────────
const cache = new Map();     // key -> { value, expires }
const inflight = new Map();  // key -> Promise

function cached(key, ttlMs, producer) {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return Promise.resolve(hit.value);
  if (inflight.has(key)) return inflight.get(key);

  const promise = producer()
    .then((value) => {
      cache.set(key, { value, expires: Date.now() + ttlMs });
      return value;
    })
    .finally(() => inflight.delete(key));

  inflight.set(key, promise);
  return promise;
}

async function request(url, options = {}) {
  const res = await fetch(url, { ...options, headers: { ...headers(), ...(options.headers || {}) } });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const message = body?.error || body?.message || `Request failed (${res.status})`;
    throw Object.assign(new Error(message), { status: res.status, body });
  }
  return body;
}

const rpc = (name, args) =>
  request(`${REST}/rpc/${name}`, { method: "POST", body: JSON.stringify(args) });

const invoke = (fn, payload) =>
  request(`${FNS}/${fn}`, { method: "POST", body: JSON.stringify(payload) });

// ── clusters ──────────────────────────────────────────────────────────
let clusterAbort = null;

/**
 * Server-side grid aggregation. Bounds are rounded to 3 decimals so small pans
 * reuse the same cache key rather than issuing a fresh query per pixel.
 */
export function fetchClusters(bounds, zoom, filters = {}) {
  const r = (n) => Math.round(n * 1000) / 1000;
  const args = {
    min_lat: r(bounds.south), min_lng: r(bounds.west),
    max_lat: r(bounds.north), max_lng: r(bounds.east),
    zoom: Math.round(zoom),
    p_type: filters.type ?? null,
    p_min_price: filters.minPrice ?? null,
    p_max_price: filters.maxPrice ?? null,
  };
  const key = `clusters:${JSON.stringify(args)}`;

  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return Promise.resolve(hit.value);

  clusterAbort?.abort();                 // a newer viewport supersedes the old one
  clusterAbort = new AbortController();

  return request(`${REST}/rpc/get_clusters`, {
    method: "POST",
    body: JSON.stringify(args),
    signal: clusterAbort.signal,
  }).then((value) => {
    cache.set(key, { value, expires: Date.now() + 45_000 });
    return value;
  });
}

// ── listings ──────────────────────────────────────────────────────────
export function fetchListing(id) {
  return cached(`listing:${id}`, 120_000, async () => {
    const rows = await request(`${REST}/listings_public?id=eq.${encodeURIComponent(id)}&select=*&limit=1`);
    if (!rows.length) throw new Error("This listing is not on the map any more.");
    return rows[0];
  });
}

export function fetchListingPoints(bounds) {
  const r = (n) => Math.round(n * 100) / 100;
  const args = {
    min_lat: r(bounds.south), min_lng: r(bounds.west),
    max_lat: r(bounds.north), max_lng: r(bounds.east),
  };
  return cached(`points:${JSON.stringify(args)}`, 120_000, () => rpc("listings_in_bounds", args));
}

// ── the rent pulse ────────────────────────────────────────────────────
export function fetchAvgRent(lat, lng, radius) {
  // 2 decimals ≈ 1.1 km: nudging the map should not re-query the average.
  const key = `rent:${lat.toFixed(2)}:${lng.toFixed(2)}:${radius}`;
  return cached(key, 60_000, async () => {
    const rows = await rpc("avg_rent_nearby", {
      p_lat: lat, p_lng: lng, p_radius_m: radius, p_bhk: null,
    });
    return Array.isArray(rows) ? rows[0] : rows;
  });
}

// ── comments ──────────────────────────────────────────────────────────
export function fetchComments(listingId) {
  return cached(`comments:${listingId}`, 30_000, () =>
    request(`${REST}/comments?listing_id=eq.${listingId}&select=id,author,text,created_at&order=created_at.desc&limit=50`));
}

export async function postComment(listingId, author, text) {
  const created = await request(`${REST}/comments`, {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ listing_id: listingId, author: author || "Anonymous", text }),
  });
  cache.delete(`comments:${listingId}`);
  return Array.isArray(created) ? created[0] : created;
}

// ── edge functions ────────────────────────────────────────────────────
export const submitInterest      = (payload) => invoke("handle_interest_submission", payload);
export const submitListing       = (payload) => invoke("submit_listing", payload);
export const submitRentReport    = (payload) => invoke("submit_rent_report", payload);
export const submitSeeker        = (payload) => invoke("submit_seeker", payload);
export async function submitBoardSighting(payload) {
  const result = await invoke("submit_board_sighting", payload);
  // The 45s TTL below means the marker for this exact sighting wouldn't show
  // up until the cache aged out on its own — drop every cached viewport so
  // the very next fetch (mapActions.js re-queries right after a successful
  // submit) sees it immediately instead of the stale pre-submission result.
  for (const key of cache.keys()) if (key.startsWith("sightings:")) cache.delete(key);
  return result;
}

export function fetchBoardSightings(bounds) {
  const r = (n) => Math.round(n * 1000) / 1000;
  const args = {
    min_lat: r(bounds.south), min_lng: r(bounds.west),
    max_lat: r(bounds.north), max_lng: r(bounds.east),
  };
  return cached(`sightings:${JSON.stringify(args)}`, 45_000, () => rpc("board_sightings_in_bounds", args));
}

export function fetchNearbyPlaces(type, lat, lng, radius) {
  // Snap to the same 3-decimal grid the edge function caches on, so the
  // browser cache and the database cache agree on what "the same place" is.
  const key = `places:${type}:${lat.toFixed(3)}:${lng.toFixed(3)}:${radius}`;
  return cached(key, 10 * 60_000, () =>
    invoke("fetch_places_with_cache", { type, lat, lng, radius }));
}

export function fetchAqi(lat, lng) {
  const key = `aqi:${lat.toFixed(2)}:${lng.toFixed(2)}`;
  return cached(key, 15 * 60_000, () => invoke("fetch_aqi", { lat, lng }));
}
