/**
 * The "I'm interested" modal — the one place in the product where a stranger
 * hands over their details, so it is also the place where friction has to be
 * lowest and the promise has to be clearest.
 *
 * Order of operations, and why:
 *   1. Validate locally so nobody waits on a round trip to learn they typed
 *      nine digits.
 *   2. Submit. The lead is stored and the owner is emailed inside that one
 *      request. From this point the enquiry has succeeded no matter what.
 *   3. Only then open Razorpay, if the ₹1 toggle is on. Any outcome —
 *      declined, dismissed, script blocked — still lands on the success
 *      screen, with the copy adjusted.
 */
import { submitInterest } from "./api.js";
import { CONFIG } from "./config.js";
import { money } from "./format.js";
import { checkout } from "./payments.js";
import { toast } from "./toast.js";

let listing = null;
let submitting = false;
let lastFocused = null;

const el = {};

function cacheNodes() {
  el.modal   = document.getElementById("modal");
  el.scrim   = document.getElementById("scrim");
  el.body    = document.getElementById("modal-body");
  el.done    = document.getElementById("modal-done");
  el.error   = document.getElementById("modal-error");
  el.sub     = document.getElementById("modal-listing");
  el.submit  = document.getElementById("f-submit");
  el.doneCopy = document.getElementById("done-copy");
  el.fields  = {
    name: document.getElementById("f-name"),
    phone: document.getElementById("f-phone"),
    email: document.getElementById("f-email"),
    message: document.getElementById("f-message"),
    pay: document.getElementById("f-pay"),
  };
}

// ── validation ────────────────────────────────────────────────────────
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^[6-9]\d{9}$/;

function validate() {
  const name = el.fields.name.value.trim();
  const phone = el.fields.phone.value.replace(/\D/g, "");
  const email = el.fields.email.value.trim().toLowerCase();

  const problems = [];
  if (name.length < 2) problems.push([el.fields.name, "Enter your name."]);
  if (!PHONE_RE.test(phone)) problems.push([el.fields.phone, "Enter a 10-digit mobile number."]);
  if (!EMAIL_RE.test(email)) problems.push([el.fields.email, "Enter a valid email address."]);

  Object.values(el.fields).forEach((f) => f.removeAttribute?.("aria-invalid"));

  if (problems.length) {
    const [field, message] = problems[0];
    field.setAttribute("aria-invalid", "true");
    field.focus();
    showError(message);
    return null;
  }

  showError(null);
  return {
    listing_id: listing.id,
    name,
    phone,
    email,
    message: el.fields.message.value.trim(),
    wants_to_pay: CONFIG.PAYMENTS_ENABLED && el.fields.pay.checked,
  };
}

function showError(message) {
  el.error.hidden = !message;
  el.error.textContent = message ?? "";
}

// ── open / close ──────────────────────────────────────────────────────
export function openInterest(target) {
  listing = target;
  lastFocused = document.activeElement;

  el.sub.textContent = `${target.title} · ${money(target.price)}${target.type === "sale" ? "" : " / month"}`;
  el.body.hidden = false;
  el.done.hidden = true;
  showError(null);

  // The ₹1 toggle is a server-side switch; hide the row entirely when off
  // rather than showing a control that would not work.
  document.getElementById("pay-toggle").hidden = !CONFIG.PAYMENTS_ENABLED;

  el.modal.hidden = false;
  el.scrim.hidden = false;
  document.addEventListener("keydown", onKeydown);
  setTimeout(() => el.fields.name.focus(), 40);
}

export function closeInterest() {
  el.modal.hidden = true;
  el.scrim.hidden = true;
  document.removeEventListener("keydown", onKeydown);
  lastFocused?.focus();
}

function onKeydown(event) {
  if (event.key === "Escape") { closeInterest(); return; }
  if (event.key !== "Tab") return;

  // Focus trap: a modal that lets Tab wander behind the scrim is a modal in
  // name only.
  const focusable = el.modal.querySelectorAll(
    'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [href]');
  if (!focusable.length) return;
  const first = focusable[0], last = focusable[focusable.length - 1];

  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault(); last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault(); first.focus();
  }
}

// ── submit ────────────────────────────────────────────────────────────
async function submit() {
  if (submitting) return;
  const payload = validate();
  if (!payload) return;

  submitting = true;
  el.submit.disabled = true;
  el.submit.textContent = "Sending…";

  let result;
  try {
    result = await submitInterest(payload);
  } catch (err) {
    console.error("interest submission failed", err);
    showError(err.message || "Could not send your details. Check your connection and try again.");
    el.submit.disabled = false;
    el.submit.textContent = "Send my details";
    submitting = false;
    return;
  }

  // The lead is safe from here. Everything below only changes the wording.
  let paymentNote = "";

  if (payload.wants_to_pay && result.payment) {
    el.submit.textContent = "Opening payment…";
    const outcome = await checkout({
      order: result.payment,
      name: payload.name,
      email: payload.email,
      phone: payload.phone,
      listingTitle: listing.title,
    });

    paymentNote = {
      success:     " Your ₹1 verification went through.",
      failed:      " The ₹1 payment did not go through, which does not affect your enquiry.",
      dismissed:   " You skipped the ₹1 verification, which is fine.",
      unavailable: "",
    }[outcome.status] ?? "";
  }

  el.doneCopy.textContent =
    `The owner has your details and will get in touch by email or phone.${paymentNote}`;

  el.body.hidden = true;
  el.done.hidden = false;
  el.submit.disabled = false;
  el.submit.textContent = "Send my details";
  submitting = false;

  // Keep the details for the next enquiry in this session; retyping a phone
  // number on every listing is the friction this product exists to remove.
  el.fields.message.value = "";
}

export function initModal() {
  cacheNodes();

  el.submit.addEventListener("click", submit);
  document.getElementById("modal-close").addEventListener("click", closeInterest);
  document.getElementById("done-close").addEventListener("click", closeInterest);
  el.scrim.addEventListener("click", closeInterest);

  // Digits only, without fighting the user's cursor.
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
