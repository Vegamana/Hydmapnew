/**
 * "List my flat" — the owner-submission modal.
 *
 * Mirrors modal.js's shape (same field/validate/submit/open/close structure)
 * for one reason: this is the second and last place a stranger hands over
 * contact details, so it should feel like the same product, not a bolted-on
 * form. The one real difference is the location step — there is no address
 * field, because lat/lng is what the map actually needs, so the owner drops
 * a pin instead of typing a street name.
 *
 * Nothing here writes to `listings` directly — submit_listing inserts the
 * row as 'pending' and emails a confirm link. This module's job ends at
 * "saved, check your email."
 */
import { state } from "./map.js";
import { MAP } from "./config.js";
import { submitListing } from "./api.js";
import { toast } from "./toast.js";

let submitting = false;
let lastFocused = null;
let picking = false;
let cancelPicker = null;
let pickedLocation = null; // { lat, lng }

const el = {};

function cacheNodes() {
  el.modal  = document.getElementById("list-modal");
  el.scrim  = document.getElementById("list-scrim");
  el.body   = document.getElementById("list-modal-body");
  el.done   = document.getElementById("list-modal-done");
  el.error  = document.getElementById("list-modal-error");
  el.submit = document.getElementById("l-submit");
  el.pin    = document.getElementById("list-pin");
  el.pinLabel = document.getElementById("list-pin-label");
  el.priceUnit = document.getElementById("l-price-unit");
  el.fields = {
    title: document.getElementById("l-title"),
    type: document.getElementById("l-type"),
    price: document.getElementById("l-price"),
    bhk: document.getElementById("l-bhk"),
    furnishing: document.getElementById("l-furnishing"),
    deposit: document.getElementById("l-deposit"),
    parking: document.getElementById("l-parking"),
    sqft: document.getElementById("l-sqft"),
    gender: document.getElementById("l-gender"),
    gated: document.getElementById("l-gated"),
    desc: document.getElementById("l-desc"),
    email: document.getElementById("l-email"),
    phone: document.getElementById("l-phone"),
  };
}

// ── location picking ────────────────────────────────────────────────────
function inBounds(lat, lng) {
  return lat >= MAP.bounds.south && lat <= MAP.bounds.north
      && lng >= MAP.bounds.west  && lng <= MAP.bounds.east;
}

/** One bare-map click (marker clicks don't count — the user meant those). */
function armPicker(onPick) {
  const listener = state.maps.event.addListener(state.map, "click", (event) => {
    const target = event.domEvent?.target;
    if (target?.closest?.(".chip, .bubble, .poi")) return; // let that click do its own thing
    const lat = event.latLng.lat(), lng = event.latLng.lng();
    if (!inBounds(lat, lng)) {
      toast("That's outside the Hyderabad map area. Try again.", "bad");
      return;
    }
    state.maps.event.removeListener(listener);
    onPick({ lat, lng });
  });
  return () => state.maps.event.removeListener(listener);
}

function startPicking() {
  picking = true;
  document.body.classList.add("is-picking-location");
  el.pin.classList.add("is-picking");
  el.pin.classList.remove("is-set");
  el.pinLabel.textContent = "Tap the map…";
  el.modal.hidden = true;
  el.scrim.hidden = true;
  toast("Tap your building on the map.");

  cancelPicker = armPicker((point) => {
    pickedLocation = point;
    picking = false;
    document.body.classList.remove("is-picking-location");
    el.pin.classList.remove("is-picking");
    el.pin.classList.add("is-set");
    el.pinLabel.textContent = `📍 ${point.lat.toFixed(5)}, ${point.lng.toFixed(5)} — tap to change`;
    el.modal.hidden = false;
    el.scrim.hidden = false;
    toast("Location set.");
  });
}

function stopPicking() {
  if (!picking) return;
  picking = false;
  document.body.classList.remove("is-picking-location");
  el.pin.classList.remove("is-picking");
  cancelPicker?.();
  cancelPicker = null;
}

// ── validation ───────────────────────────────────────────────────────────
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^[6-9]\d{9}$/;

function num(field) {
  const v = field.value.trim();
  return v === "" ? null : Number(v);
}

function validate() {
  const title = el.fields.title.value.trim();
  const price = num(el.fields.price);
  const email = el.fields.email.value.trim().toLowerCase();
  const phone = el.fields.phone.value.replace(/\D/g, "");

  const problems = [];
  if (!pickedLocation) problems.push([el.pin, "Tap the map to set where this flat is."]);
  if (title.length < 3) problems.push([el.fields.title, "Give it a short title."]);
  if (!price || price <= 0) problems.push([el.fields.price, "Enter a price."]);
  if (!EMAIL_RE.test(email)) problems.push([el.fields.email, "Enter a valid email address."]);
  if (phone && !PHONE_RE.test(phone)) problems.push([el.fields.phone, "Enter a 10-digit mobile number, or leave it blank."]);

  Object.values(el.fields).forEach((f) => f.removeAttribute?.("aria-invalid"));

  if (problems.length) {
    const [field, message] = problems[0];
    field.setAttribute?.("aria-invalid", "true");
    field.focus?.();
    showError(message);
    return null;
  }

  showError(null);
  return {
    title,
    type: el.fields.type.value,
    price,
    lat: pickedLocation.lat,
    lng: pickedLocation.lng,
    bhk: el.fields.bhk.value || null,
    furnishing: el.fields.furnishing.value || null,
    gated: el.fields.gated.checked,
    deposit: num(el.fields.deposit),
    parking: num(el.fields.parking),
    square_footage: num(el.fields.sqft),
    gender_preference: el.fields.gender.value || null,
    description: el.fields.desc.value.trim() || null,
    owner_email: email,
    owner_phone: phone || null,
  };
}

function showError(message) {
  el.error.hidden = !message;
  el.error.textContent = message ?? "";
}

// ── open / close ─────────────────────────────────────────────────────────
/**
 * @param {{lat:number,lng:number}=} prefill — passed when opened from the
 * map-click chooser (mapActions.js), whose click already IS the location.
 * Without it (opened from the standalone "List my flat" button), the
 * pin-picker step runs as usual.
 */
export function openListingForm(prefill) {
  lastFocused = document.activeElement;
  pickedLocation = prefill ?? null;

  el.pin.classList.remove("is-set", "is-picking");
  if (prefill) {
    el.pin.classList.add("is-set");
    el.pinLabel.textContent = `📍 ${prefill.lat.toFixed(5)}, ${prefill.lng.toFixed(5)} — tap to change`;
  } else {
    el.pinLabel.textContent = "Tap to set the location";
  }
  el.body.hidden = false;
  el.done.hidden = true;
  showError(null);

  el.modal.hidden = false;
  el.scrim.hidden = false;
  document.addEventListener("keydown", onKeydown);
  setTimeout(() => el.fields.title.focus(), 40);
}

export function closeListingForm() {
  stopPicking();
  el.modal.hidden = true;
  el.scrim.hidden = true;
  document.removeEventListener("keydown", onKeydown);
  lastFocused?.focus();
}

function onKeydown(event) {
  if (event.key === "Escape") { closeListingForm(); return; }
  if (event.key !== "Tab") return;

  const focusable = el.modal.querySelectorAll(
    'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href]');
  if (!focusable.length) return;
  const first = focusable[0], last = focusable[focusable.length - 1];

  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault(); last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault(); first.focus();
  }
}

// ── submit ───────────────────────────────────────────────────────────────
async function submit() {
  if (submitting) return;
  const payload = validate();
  if (!payload) return;

  submitting = true;
  el.submit.disabled = true;
  el.submit.textContent = "Sending…";

  try {
    const result = await submitListing(payload);
    el.body.hidden = true;
    el.done.hidden = false;
    document.getElementById("list-done-copy").textContent = result.message
      ?? "One click on that link and your listing goes live on the map.";
  } catch (err) {
    console.error("listing submission failed", err);
    showError(err.message || "Could not save that listing. Check your connection and try again.");
  } finally {
    el.submit.disabled = false;
    el.submit.textContent = "Send confirmation link";
    submitting = false;
  }
}

export function initListingForm() {
  cacheNodes();

  // Not `addEventListener("click", openListingForm)` — that would pass the
  // click's MouseEvent through as `prefill`, and `prefill.lat.toFixed()`
  // would blow up on a property that doesn't exist on a MouseEvent.
  document.getElementById("list-open").addEventListener("click", () => openListingForm());
  document.getElementById("list-modal-close").addEventListener("click", closeListingForm);
  document.getElementById("list-done-close").addEventListener("click", closeListingForm);
  el.scrim.addEventListener("click", closeListingForm);

  el.pin.addEventListener("click", startPicking);
  el.submit.addEventListener("click", submit);

  el.fields.type.addEventListener("change", () => {
    el.priceUnit.textContent = el.fields.type.value === "sale" ? "(₹ total)" : "(₹ / month)";
  });

  el.fields.phone.addEventListener("input", () => {
    const cleaned = el.fields.phone.value.replace(/\D/g, "").slice(0, 10);
    if (cleaned !== el.fields.phone.value) el.fields.phone.value = cleaned;
  });

  el.modal.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && event.target.tagName === "INPUT") {
      event.preventDefault();
      submit();
    }
  });
}
