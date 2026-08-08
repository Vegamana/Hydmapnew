/**
 * The map-click chooser: tap any bare spot on the map and pick one of four
 * things to add there. "List my flat" hands off to listingForm.js (already
 * a full form of its own); the other three are lightweight enough to share
 * one small modal whose fields swap based on which action was picked.
 *
 * Bare-map clicks only — a click that lands on a chip, cluster bubble or
 * POI marker is that marker's business, not this chooser's, and is
 * excluded the same way listingForm.js's own pin-picker excludes them.
 */
import { state, viewport } from "./map.js";
import { MAP } from "./config.js";
import { submitRentReport, submitSeeker, submitBoardSighting, fetchBoardSightings } from "./api.js";
import { createMarker } from "./markers.js";
import { openListingForm } from "./listingForm.js";
import { debounce } from "./format.js";
import { toast } from "./toast.js";

let pending = null; // { lat, lng } — the point that opened the chooser
let currentAction = null;
let submitting = false;
let lastFocused = null;
const el = {};

function cacheNodes() {
  el.chooserModal = document.getElementById("chooser-modal");
  el.chooserScrim = document.getElementById("chooser-scrim");

  el.qaModal = document.getElementById("qa-modal");
  el.qaScrim = document.getElementById("qa-scrim");
  el.qaBody  = document.getElementById("qa-body");
  el.qaDone  = document.getElementById("qa-done");
  el.qaError = document.getElementById("qa-error");
  el.qaEyebrow = document.getElementById("qa-eyebrow");
  el.qaTitle = document.getElementById("qa-title");
  el.qaSub   = document.getElementById("qa-sub");
  el.qaSubmit = document.getElementById("qa-submit");
  el.qaDoneTitle = document.getElementById("qa-done-title");
  el.qaDoneCopy  = document.getElementById("qa-done-copy");
  el.qaFieldGroups = document.querySelectorAll(".qa-fields");
}

// ── bare-map click → open the chooser ───────────────────────────────────
function inBounds(lat, lng) {
  return lat >= MAP.bounds.south && lat <= MAP.bounds.north
      && lng >= MAP.bounds.west  && lng <= MAP.bounds.east;
}

function wireMapClick() {
  state.map.addListener("click", (event) => {
    // listingForm.js's own pin-picker is mid-flight; that click is its, not ours.
    if (document.body.classList.contains("is-picking-location")) return;
    // Marker elements (chip/bubble/poi/sighting) stop propagation themselves
    // (see markers.js's onMarkerClick) so a click on one never reaches here
    // in the first place. This is defense in depth for anything that
    // doesn't — domEvent.target is not reliable to filter on: Maps
    // reconstructs its own event for a bubbled click and reports target as
    // null rather than the element actually clicked.
    const target = event.domEvent?.target;
    if (target?.closest?.(".chip, .bubble, .poi, .sighting")) return;

    const lat = event.latLng.lat(), lng = event.latLng.lng();
    if (!inBounds(lat, lng)) return; // silently ignore — no need to scold for a stray click
    openChooser({ lat, lng });
  });
}

// ── chooser ──────────────────────────────────────────────────────────────
function openChooser(point) {
  pending = point;
  lastFocused = document.activeElement;
  el.chooserModal.hidden = false;
  el.chooserScrim.hidden = false;
  document.addEventListener("keydown", onChooserKeydown);
}

function closeChooser() {
  el.chooserModal.hidden = true;
  el.chooserScrim.hidden = true;
  document.removeEventListener("keydown", onChooserKeydown);
  lastFocused?.focus();
}

function onChooserKeydown(event) {
  if (event.key === "Escape") closeChooser();
}

const ACTION_COPY = {
  rent_report:    { eyebrow: "10 seconds",        title: "What rent are you paying?", sub: "Anonymous — no name, no email. Just folds into the average for this area." },
  seeker:         { eyebrow: "Get matched",        title: "I'm looking for a flat",     sub: "We'll email you the moment something matching goes live near this pin." },
  board_sighting: { eyebrow: "Spotted a board?",   title: "Add the phone number",       sub: "Goes live on the map immediately — thanks for the tip." },
};

function chooseAction(action) {
  closeChooser();

  if (action === "list_flat") {
    openListingForm(pending);
    return;
  }

  currentAction = action;
  const copy = ACTION_COPY[action];
  el.qaEyebrow.textContent = copy.eyebrow;
  el.qaTitle.textContent = copy.title;
  el.qaSub.textContent = copy.sub;
  el.qaFieldGroups.forEach((g) => { g.hidden = g.dataset.for !== action; });
  showQaError(null);

  el.qaBody.hidden = false;
  el.qaDone.hidden = true;
  el.qaModal.hidden = false;
  el.qaScrim.hidden = false;
  lastFocused = document.activeElement;
  document.addEventListener("keydown", onQaKeydown);
  setTimeout(() => el.qaModal.querySelector("input, select")?.focus(), 40);
}

function closeQa() {
  el.qaModal.hidden = true;
  el.qaScrim.hidden = true;
  document.removeEventListener("keydown", onQaKeydown);
  lastFocused?.focus();
}

function onQaKeydown(event) {
  if (event.key === "Escape") closeQa();
}

function showQaError(message) {
  el.qaError.hidden = !message;
  el.qaError.textContent = message ?? "";
}

// ── validation + submit per action ──────────────────────────────────────
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function buildRentReport() {
  const price = Number(document.getElementById("qa-rr-price").value);
  if (!price || price <= 0) return { error: "Enter what you actually pay." };
  return {
    data: {
      price,
      type: document.getElementById("qa-rr-type").value,
      bhk: document.getElementById("qa-rr-bhk").value || null,
      lat: pending.lat, lng: pending.lng,
    },
  };
}

function buildSeeker() {
  const email = document.getElementById("qa-sk-email").value.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return { error: "Enter a valid email address — matches land here." };
  const min = document.getElementById("qa-sk-min").value;
  const max = document.getElementById("qa-sk-max").value;
  return {
    data: {
      email,
      type: document.getElementById("qa-sk-type").value,
      bhk: document.getElementById("qa-sk-bhk").value || null,
      budget_min: min === "" ? null : Number(min),
      budget_max: max === "" ? null : Number(max),
      lat: pending.lat, lng: pending.lng,
      radius_m: 3000,
    },
  };
}

function buildBoardSighting() {
  const phone = document.getElementById("qa-bs-phone").value.replace(/\D/g, "");
  if (!/^[6-9]\d{9}$/.test(phone)) return { error: "Enter the 10-digit number from the board." };
  return {
    data: {
      phone,
      note: document.getElementById("qa-bs-note").value.trim() || null,
      lat: pending.lat, lng: pending.lng,
    },
  };
}

const ACTION_HANDLERS = {
  rent_report:    { build: buildRentReport,    submit: submitRentReport,    doneTitle: "Thanks",   doneCopy: "That's folded into the average rent for this area now." },
  seeker:         { build: buildSeeker,        submit: submitSeeker,        doneTitle: "Saved",     doneCopy: "We'll email you the moment a matching flat goes live nearby." },
  board_sighting: { build: buildBoardSighting, submit: submitBoardSighting, doneTitle: "On the map", doneCopy: "Thanks for the tip — that's visible on the map now." },
};

async function submitQa() {
  if (submitting || !currentAction) return;
  const handler = ACTION_HANDLERS[currentAction];
  const built = handler.build();
  if (built.error) { showQaError(built.error); return; }

  submitting = true;
  el.qaSubmit.disabled = true;
  el.qaSubmit.textContent = "Sending…";

  try {
    const result = await handler.submit(built.data);
    el.qaBody.hidden = true;
    el.qaDone.hidden = false;
    el.qaDoneTitle.textContent = handler.doneTitle;
    el.qaDoneCopy.textContent = result.message ?? handler.doneCopy;
    if (currentAction === "board_sighting") refreshSightings(); // show the new pin right away
  } catch (err) {
    console.error(`${currentAction} submission failed`, err);
    showQaError(err.message || "Could not send that. Check your connection and try again.");
  } finally {
    el.qaSubmit.disabled = false;
    el.qaSubmit.textContent = "Send";
    submitting = false;
  }
}

// ── board sighting markers ──────────────────────────────────────────────
let sightingMarkers = [];

function clearSightings() {
  sightingMarkers.forEach((m) => m.setMap(null));
  sightingMarkers = [];
}

async function refreshSightings() {
  const view = viewport();
  if (!view) return;
  let rows;
  try {
    rows = await fetchBoardSightings(view.bounds);
  } catch (err) {
    console.error("board sightings fetch failed", err);
    return;
  }

  clearSightings();
  for (const s of rows) {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "sighting";
    el.textContent = "📌";
    el.title = `${s.phone}${s.note ? " — " + s.note : ""}`;
    el.setAttribute("aria-label", `To-Let board: call ${s.phone}${s.note ? ", " + s.note : ""}`);
    // stopPropagation for the same reason markers.js's onMarkerClick does —
    // otherwise this click also reaches the map's own click listener and
    // pops the "Add something here" chooser right on top of this toast.
    el.addEventListener("click", (event) => {
      event.stopPropagation();
      toast(`📞 ${s.phone}${s.note ? " — " + s.note : ""}`);
    });

    const marker = createMarker(state.maps, { lat: s.lat, lng: s.lng }, el);
    marker.setMap(state.map);
    sightingMarkers.push(marker);
  }
}

export function initMapActions() {
  cacheNodes();
  wireMapClick();

  document.getElementById("chooser-close").addEventListener("click", closeChooser);
  el.chooserScrim.addEventListener("click", closeChooser);
  document.querySelectorAll(".chooser__opt").forEach((btn) => {
    btn.addEventListener("click", () => chooseAction(btn.dataset.action));
  });

  document.getElementById("qa-close").addEventListener("click", closeQa);
  document.getElementById("qa-done-close").addEventListener("click", closeQa);
  el.qaScrim.addEventListener("click", closeQa);
  el.qaSubmit.addEventListener("click", submitQa);

  el.qaModal.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && event.target.tagName === "INPUT") {
      event.preventDefault();
      submitQa();
    }
  });

  state.map.addListener("idle", debounce(refreshSightings, 300));
  refreshSightings();
}
