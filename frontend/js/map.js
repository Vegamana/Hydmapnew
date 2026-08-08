/**
 * Map lifecycle: load the API, hold the map instance, keep the marker layer in
 * sync with the viewport.
 *
 * The whole rendering strategy is "ask the server what belongs in this
 * rectangle at this zoom, then draw exactly that". No client-side clustering,
 * no full listing set in memory.
 */
import { CONFIG, MAP, DEFAULTS } from "./config.js";
import { fetchClusters } from "./api.js";
import { debounce } from "./format.js";
import { initOverlay, createMarker, bubbleElement, rangeElement, listingElement } from "./markers.js";

export const state = {
  map: null,
  maps: null,
  markers: [],
  filters: {},
  activeListingId: null,
  onListingClick: () => {},
  onIdle: () => {},
  drill: null, // { lat, lng, hopsLeft, prevZoom } — see refreshMarkers()
};

// ── loading the Maps JS API ───────────────────────────────────────────
// The inline bootstrap loader: one small script tag written at runtime, then
// libraries pulled on demand with importLibrary. Loading "visualization" only
// when the heatmap is switched on keeps the first paint light.
function bootstrapLoader() {
  if (window.google?.maps?.importLibrary) return;

  ((g) => {
    let h, a, k, p = "The Google Maps JavaScript API", c = "google", l = "importLibrary",
      q = "__ib__", m = document, b = window;
    b = b[c] || (b[c] = {});
    const d = b.maps || (b.maps = {}), r = new Set(), e = new URLSearchParams(),
      u = () => h || (h = new Promise(async (f, n) => {
        a = m.createElement("script");
        e.set("libraries", [...r] + "");
        for (k in g) e.set(k.replace(/[A-Z]/g, (t) => "_" + t[0].toLowerCase()), g[k]);
        e.set("callback", c + ".maps." + q);
        a.src = `https://maps.${c}apis.com/maps/api/js?` + e;
        d[q] = f;
        a.onerror = () => (h = n(Error(p + " could not load.")));
        a.nonce = m.querySelector("script[nonce]")?.nonce || "";
        m.head.append(a);
      }));
    d[l] ? console.warn(p + " only loads once. Ignoring:", g)
         : (d[l] = (f, ...n) => r.add(f) && u().then(() => d[l](f, ...n)));
  })({ key: CONFIG.GOOGLE_MAPS_API_KEY, v: "weekly", region: "IN", language: "en" });
}

export async function initMap(container) {
  bootstrapLoader();
  const maps = await google.maps.importLibrary("maps");
  state.maps = google.maps;
  initOverlay(state.maps);

  state.map = new maps.Map(container, {
    center: MAP.center,
    zoom: MAP.zoom,
    minZoom: MAP.minZoom,
    maxZoom: MAP.maxZoom,
    restriction: { latLngBounds: MAP.bounds, strictBounds: false },
    disableDefaultUI: true,
    zoomControl: true,
    zoomControlOptions: { position: google.maps.ControlPosition.RIGHT_CENTER },
    gestureHandling: "greedy",
    clickableIcons: false,
  });

  // One debounced handler for everything that depends on the viewport.
  const onIdle = debounce(() => {
    refreshMarkers();
    state.onIdle(viewport());
  }, DEFAULTS.mapIdleDebounceMs);

  state.map.addListener("idle", onIdle);
  // A manual drag mid-drill means the user took over navigation; don't yank
  // the view back toward the drill target on the next idle event.
  state.map.addListener("dragstart", () => { state.drill = null; });
  return state.map;
}

export function viewport() {
  const b = state.map.getBounds();
  if (!b) return null;
  const ne = b.getNorthEast(), sw = b.getSouthWest();
  const centre = state.map.getCenter();
  return {
    bounds: { north: ne.lat(), east: ne.lng(), south: sw.lat(), west: sw.lng() },
    zoom: state.map.getZoom(),
    center: { lat: centre.lat(), lng: centre.lng() },
  };
}

// ── marker layer ──────────────────────────────────────────────────────
function clearMarkers() {
  state.markers.forEach((m) => m.setMap(null));
  state.markers = [];
}

export async function refreshMarkers() {
  const view = viewport();
  if (!view) return;

  let clusters;
  try {
    clusters = await fetchClusters(view.bounds, view.zoom, state.filters);
  } catch (err) {
    if (err.name === "AbortError") return;      // superseded by a newer pan
    console.error("cluster fetch failed", err);
    return;
  }

  // Drilling in from a price-range chip (see below): a cluster's point is an
  // average of the listings inside it, which can be spread wide across a
  // coarse low-zoom grid cell. Keep stepping deeper automatically — so one
  // click reaches a real listing instead of landing on another aggregate and
  // needing a second click — but if a step overshoots into an empty patch
  // (the listings were further from that average than this narrower
  // viewport reaches), back out to the last zoom that actually had data and
  // stop, rather than leaving the user staring at a blank map.
  if (state.drill) {
    const hasIndividual = clusters.some((c) => c.kind !== "cluster" && c.kind !== "price_range");
    if (hasIndividual) {
      state.drill = null;
    } else if (clusters.length === 0) {
      const { lat, lng, prevZoom } = state.drill;
      state.drill = null;
      zoomTo(lat, lng, prevZoom, { pan: false });
      return; // that zoomTo's own idle event redraws with the restored view
    } else if (state.drill.hopsLeft > 0) {
      const { lat, lng } = state.drill;
      state.drill.hopsLeft -= 1;
      state.drill.prevZoom = view.zoom;
      zoomTo(lat, lng, view.zoom + 2, { pan: false });
      return; // let that zoomTo's idle event re-run this one level deeper
    } else {
      state.drill = null;
    }
  }

  clearMarkers();

  let listingTotal = 0;
  for (const cluster of clusters) {
    listingTotal += cluster.point_count ?? 1;
    let element;

    if (cluster.kind === "cluster") {
      element = bubbleElement(cluster.point_count, () => zoomTo(cluster.lat, cluster.lng, view.zoom + 3));
    } else if (cluster.kind === "price_range") {
      // A single "+2" step often lands on another price-range chip rather
      // than an actual listing — the click reads as doing nothing. Arm the
      // auto-drill above so refreshMarkers keeps stepping in on its own
      // until it reaches a real listing (or safely gives up).
      element = rangeElement(cluster, () => {
        state.drill = { lat: cluster.lat, lng: cluster.lng, hopsLeft: 2, prevZoom: view.zoom };
        zoomTo(cluster.lat, cluster.lng, Math.min(view.zoom + 2, 17));
      });
    } else {
      element = listingElement(cluster, () => {
        setActiveListing(cluster.listing_id);
        state.onListingClick(cluster.listing_id, { lat: cluster.lat, lng: cluster.lng });
      });
      if (cluster.listing_id === state.activeListingId) element.classList.add("chip--active");
    }

    const marker = createMarker(state.maps, { lat: cluster.lat, lng: cluster.lng }, element);
    marker.setMap(state.map);
    state.markers.push(marker);
  }

  document.dispatchEvent(new CustomEvent("markers:drawn", {
    detail: { total: listingTotal, groups: clusters.length, zoom: view.zoom },
  }));
}

export function setActiveListing(id) {
  state.activeListingId = id;
  document.querySelectorAll(".chip--active").forEach((el) => el.classList.remove("chip--active"));
  document.querySelector(`.chip[data-listing-id="${id}"]`)?.classList.add("chip--active");
}

// ── smooth zoom ───────────────────────────────────────────────────────
/**
 * The Maps API jumps between integer zoom levels. Stepping one level at a time
 * on a short timer reads as a glide and keeps the user oriented — the same
 * trick the previous app used, kept because it still works.
 */
export function zoomTo(lat, lng, targetZoom, { pan = true } = {}) {
  const target = Math.max(MAP.minZoom, Math.min(MAP.maxZoom, Math.round(targetZoom)));
  const start = state.map.getZoom();

  if (pan) state.map.panTo({ lat, lng });
  if (target === start) return;

  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    state.map.setZoom(target);
    return;
  }

  const step = target > start ? 1 : -1;
  let current = start;
  const tick = () => {
    current += step;
    state.map.setZoom(current);
    if (current !== target) setTimeout(tick, 90);
  };
  setTimeout(tick, 60);
}

export function panTo(lat, lng, zoom) {
  state.map.panTo({ lat, lng });
  if (zoom) zoomTo(lat, lng, zoom, { pan: false });
}

export function setFilters(filters) {
  state.filters = filters;
  refreshMarkers();
}
