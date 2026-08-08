/**
 * The listing sheet: detail, comments, and the entry point to the interest flow.
 * Owner contact never appears here — there is nothing to leak because the API
 * never sends it.
 */
import { fetchListing, fetchComments, postComment } from "./api.js";
import { money, timeAgo, escapeHtml, TYPE_LABEL, TYPE_CLASS } from "./format.js";
import { setAnchor, clearNearby } from "./nearby.js";
import { openInterest } from "./modal.js";
import { toast } from "./toast.js";

let current = null;

const el = {};

function cacheNodes() {
  el.sheet = document.getElementById("sheet");
  el.badge = document.getElementById("sheet-badge");
  el.title = document.getElementById("sheet-title");
  el.price = document.getElementById("sheet-price");
  el.facts = document.getElementById("sheet-facts");
  el.desc  = document.getElementById("sheet-desc");
  el.comments = document.getElementById("comments-list");
}

function fact(label, value) {
  return value === null || value === undefined || value === ""
    ? ""
    : `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`;
}

export async function openListing(id) {
  let listing;
  try {
    listing = await fetchListing(id);
  } catch (err) {
    toast(err.message, "bad");
    return;
  }

  current = listing;

  el.badge.textContent = TYPE_LABEL[listing.type] ?? "Listing";
  el.badge.className = `badge${TYPE_CLASS[listing.type] ? ` badge--${TYPE_CLASS[listing.type]}` : ""}`;
  el.title.textContent = listing.title;
  el.price.innerHTML = `${money(listing.price)}${listing.type === "sale" ? "" : " <small>/ month</small>"}`;

  el.facts.innerHTML = [
    fact("Bedrooms", listing.bhk ? `${listing.bhk} BHK` : null),
    fact("Furnishing", listing.furnishing),
    fact("Deposit", listing.deposit ? money(listing.deposit) : null),
    fact("Parking", listing.parking != null ? `${listing.parking} slot${listing.parking === 1 ? "" : "s"}` : null),
    fact("Area", listing.square_footage ? `${listing.square_footage} sq ft` : null),
    fact("Society", listing.gated === null ? null : listing.gated ? "Gated" : "Not gated"),
    fact("For", listing.gender_preference),
    fact("Listed", timeAgo(listing.created_at)),
  ].join("");

  el.desc.textContent = listing.description || "";
  el.desc.hidden = !listing.description;

  el.sheet.hidden = false;
  setAnchor({ lat: listing.lat, lng: listing.lng });
  loadComments(listing.id);
}

export function closeListing() {
  el.sheet.hidden = true;
  current = null;
  clearNearby();
  setAnchor(null);
}

async function loadComments(listingId) {
  el.comments.innerHTML = `<li class="comments__empty">Loading…</li>`;
  try {
    const comments = await fetchComments(listingId);
    if (!comments.length) {
      el.comments.innerHTML = `<li class="comments__empty">No questions yet. Ask the first one.</li>`;
      return;
    }
    el.comments.innerHTML = comments.map((c) => `
      <li><b>${escapeHtml(c.author)}</b><time>${timeAgo(c.created_at)}</time>
      <p>${escapeHtml(c.text)}</p></li>`).join("");
  } catch (err) {
    console.error("comments failed", err);
    el.comments.innerHTML = `<li class="comments__empty">Comments could not load.</li>`;
  }
}

export function initListing({ onClose } = {}) {
  cacheNodes();

  document.getElementById("sheet-close").addEventListener("click", () => {
    closeListing();
    onClose?.();
  });

  document.getElementById("interest-open").addEventListener("click", () => {
    if (current) openInterest(current);
  });

  document.getElementById("comment-send").addEventListener("click", async () => {
    if (!current) return;
    const author = document.getElementById("comment-author");
    const text = document.getElementById("comment-text");
    const body = text.value.trim();

    if (body.length < 2) {
      toast("Write your question first.", "bad");
      text.focus();
      return;
    }

    try {
      await postComment(current.id, author.value.trim(), body);
      text.value = "";
      await loadComments(current.id);
      toast("Question posted.");
    } catch (err) {
      console.error("comment failed", err);
      toast("Could not post that. Try again.", "bad");
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !el.sheet.hidden) {
      closeListing();
      onClose?.();
    }
  });
}
