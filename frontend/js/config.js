/**
 * Runtime configuration.
 *
 * There is no build step, so this file is the deploy-time seam: Cloudflare
 * Pages runs `scripts/build-config.sh` (see docs/DEPLOYMENT.md) which rewrites
 * the placeholders below from the project's environment variables.
 *
 * Everything here is public by design and safe to ship to a browser:
 *   - the Supabase anon key is protected by RLS, not by secrecy
 *   - the Maps key must be restricted to your domain in the Google console
 *   - the Razorpay key_id is the publishable half of the pair
 * The Places server key, the service role key and the Razorpay secret are NOT
 * here and must never be.
 */
export const CONFIG = {
  SUPABASE_URL:          "__SUPABASE_URL__",
  SUPABASE_ANON_KEY:     "__SUPABASE_ANON_KEY__",
  GOOGLE_MAPS_API_KEY:   "__GOOGLE_MAPS_BROWSER_KEY__",
  RAZORPAY_KEY_ID:       "__RAZORPAY_KEY_ID__",
  PAYMENTS_ENABLED:      "__PAYMENTS_ENABLED__" === "true",
};

export const MAP = {
  center: { lat: 17.4065, lng: 78.4772 },   // Hyderabad
  zoom: 12,
  minZoom: 9,
  maxZoom: 19,
  // Hard bounds: this is a Hyderabad product, and an unbounded map is an
  // unbounded API bill.
  bounds: { north: 17.75, south: 17.10, east: 78.85, west: 78.05 },
};

export const DEFAULTS = {
  rentRadius: 3000,
  nearbyRadius: 1500,
  searchDebounceMs: 280,
  mapIdleDebounceMs: 220,
  aqiDebounceMs: 900,
};
