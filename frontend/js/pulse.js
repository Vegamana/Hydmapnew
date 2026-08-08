/**
 * The rent pulse — average rent within a radius of wherever the map is looking.
 *
 * This is the product's one original instrument, so it gets the largest type on
 * screen. It updates on map idle (already debounced upstream), the value is
 * cached per ~1 km cell for a minute, and it dims rather than blanking while a
 * fresh sample loads, so the panel never flickers empty.
 */
import { fetchAvgRent } from "./api.js";
import { DEFAULTS } from "./config.js";
import { money } from "./format.js";

let radius = DEFAULTS.rentRadius;
let lastCenter = null;

const el = {};

function cacheNodes() {
  el.value  = document.getElementById("pulse-value");
  el.note   = document.getElementById("pulse-note");
  el.spread = document.getElementById("pulse-spread");
  el.median = document.getElementById("pulse-median");
  el.min    = document.getElementById("pulse-min");
  el.max    = document.getElementById("pulse-max");
}

export async function updatePulse(center) {
  if (!center) return;
  lastCenter = center;

  el.value.classList.add("is-stale");

  let stats;
  try {
    stats = await fetchAvgRent(center.lat, center.lng, radius);
  } catch (err) {
    console.error("rent pulse failed", err);
    el.value.classList.remove("is-stale");
    el.note.textContent = "Could not read rents here. Move the map to try again.";
    return;
  }

  el.value.classList.remove("is-stale");
  const sample = Number(stats?.sample_size ?? 0);

  if (!sample) {
    el.value.textContent = "—";
    el.spread.hidden = true;
    el.note.textContent = `No rentals within ${radius / 1000} km of here yet.`;
    return;
  }

  el.value.textContent = money(stats.avg_rent);
  el.min.textContent = money(stats.min_rent, { compact: true });
  el.max.textContent = money(stats.max_rent, { compact: true });

  // Place the median tick along the min–max track. Seeing the median sit left
  // of centre is the fastest way to read "a few expensive outliers".
  const span = Number(stats.max_rent) - Number(stats.min_rent);
  const position = span > 0
    ? ((Number(stats.median_rent) - Number(stats.min_rent)) / span) * 100
    : 50;
  el.median.style.left = `calc(${Math.max(0, Math.min(100, position))}% - 1px)`;
  el.spread.hidden = false;

  el.note.textContent = `Median ${money(stats.median_rent)} across ${sample} ${sample === 1 ? "rental" : "rentals"}.`;
}

export function initPulse() {
  cacheNodes();

  document.querySelector(".pulse__radius").addEventListener("click", (event) => {
    const button = event.target.closest("[data-radius]");
    if (!button) return;
    document.querySelectorAll(".pulse__radius button").forEach((b) => b.classList.remove("is-on"));
    button.classList.add("is-on");
    radius = Number(button.dataset.radius);
    updatePulse(lastCenter);
  });
}
