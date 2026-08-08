/**
 * Nearby places, drawn around the open listing.
 *
 * Every result comes from fetch_places_with_cache, so the first person to open
 * a chip in a neighbourhood pays for the Google call and everyone after them
 * reads it out of Postgres. The chips only appear once a listing is open —
 * "biryani near the map centre" is a query nobody actually wants.
 */
import { fetchNearbyPlaces } from "./api.js";
import { DEFAULTS } from "./config.js";
import { state } from "./map.js";
import { createMarker, poiElement } from "./markers.js";
import { toast } from "./toast.js";

const drawn = new Map();   // type -> markers[]
let anchor = null;

function clear(type) {
  (drawn.get(type) || []).forEach((m) => m.setMap(null));
  drawn.delete(type);
}

export function clearNearby() {
  [...drawn.keys()].forEach(clear);
  document.querySelectorAll(".nearby__chip").forEach((c) => c.setAttribute("aria-pressed", "false"));
}

export function setAnchor(point) {
  anchor = point;
  clearNearby();
  document.getElementById("nearby").hidden = !point;
}

async function toggle(type, chip) {
  if (drawn.has(type)) {
    clear(type);
    chip.setAttribute("aria-pressed", "false");
    return;
  }
  if (!anchor) return;

  chip.dataset.busy = "true";
  try {
    const result = await fetchNearbyPlaces(type, anchor.lat, anchor.lng, DEFAULTS.nearbyRadius);
    const markers = (result.places || []).map((place) => {
      const label = place.rating ? `${place.name} — ${place.rating}★` : place.name;
      const marker = createMarker(state.maps, place, poiElement(result.emoji, label));
      marker.setMap(state.map);
      return marker;
    });

    drawn.set(type, markers);
    chip.setAttribute("aria-pressed", "true");

    if (!markers.length) toast(`Nothing found within ${DEFAULTS.nearbyRadius / 1000} km.`);
  } catch (err) {
    console.error("nearby failed", err);
    toast("Could not load nearby places. Try again in a moment.", "bad");
  } finally {
    delete chip.dataset.busy;
  }
}

export function initNearby() {
  document.getElementById("nearby").addEventListener("click", (event) => {
    const chip = event.target.closest("[data-place]");
    if (chip) toggle(chip.dataset.place, chip);
  });
}
