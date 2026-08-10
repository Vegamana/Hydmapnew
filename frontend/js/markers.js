/**
 * Markers as real DOM.
 *
 * Google's own markers are images with limited styling, and price pills need
 * live text, hover states and the site's typography. So each marker is a div
 * positioned by an OverlayView subclass — the same approach the previous app
 * used, kept because it is still the right one.
 */
import { money, count } from "./format.js";

let OverlayView = null;

/** Called once after the Maps library loads; OverlayView is not a global until then. */
export function initOverlay(maps) {
  if (OverlayView) return;

  OverlayView = class HtmlMarker extends maps.OverlayView {
    constructor(position, element, { pane = "floatPane" } = {}) {
      super();
      this.position = position;
      this.element = element;
      this.paneName = pane;
    }

    onAdd() {
      this.getPanes()[this.paneName].appendChild(this.element);
      // Fade in on the next frame so the transition actually runs.
      requestAnimationFrame(() => this.element.classList.add("is-in"));
    }

    draw() {
      const projection = this.getProjection();
      if (!projection) return;
      const point = projection.fromLatLngToDivPixel(this.position);
      if (!point) return;
      this.element.style.left = `${point.x}px`;
      this.element.style.top = `${point.y}px`;
    }

    onRemove() {
      this.element.remove();
    }

    setPosition(position) {
      this.position = position;
      this.draw();
    }
  };
}

export function createMarker(maps, position, element, options) {
  return new OverlayView(new maps.LatLng(position.lat, position.lng), element, options);
}

// ── element builders ──────────────────────────────────────────────────

/**
 * These marker elements live inside the map's own floatPane (see
 * OverlayView.onAdd above), so a click on one bubbles up through the same
 * DOM the map's own click-catching layer listens on — mapActions.js's
 * bare-map-click handler (the "Add something here" chooser) would otherwise
 * fire right alongside whatever this marker's own click does. Stopping
 * propagation here, at the source, is more robust than trying to filter it
 * out downstream: Maps reconstructs its own MapMouseEvent for a bubbled
 * click, and that reconstruction reports `domEvent.target` as `null` rather
 * than the element that was actually clicked, so there is nothing reliable
 * to filter on by the time it reaches a map-level 'click' listener anyway.
 */
function onMarkerClick(onClick) {
  return (event) => {
    event.stopPropagation();
    onClick(event);
  };
}

/** Zoom ≤ 10: a count bubble sized by how much supply it holds. */
export function bubbleElement(pointCount, onClick) {
  const size = Math.max(38, Math.min(74, 34 + Math.log2(pointCount + 1) * 8));
  const el = document.createElement("button");
  el.className = "bubble";
  el.type = "button";
  el.style.width = `${size}px`;
  el.style.height = `${size}px`;
  el.style.fontSize = `${size > 56 ? 15 : 13}px`;
  el.textContent = count(pointCount);
  el.setAttribute("aria-label", `${pointCount} listings here. Zoom in.`);
  el.addEventListener("click", onMarkerClick(onClick));
  return el;
}

/** Zoom 11–15: a price range for everything in the grid cell. */
export function rangeElement(cluster, onClick) {
  const el = document.createElement("button");
  el.type = "button";
  el.className = `chip${cluster.price_kind === "one_time" ? " chip--sale" : ""}`;

  const low = money(cluster.min_price, { compact: true });
  const high = money(cluster.max_price, { compact: true });
  el.textContent = low === high ? low : `${low}–${high}`;

  if (cluster.point_count > 1) {
    const tally = document.createElement("span");
    tally.style.cssText = "opacity:.55;margin-left:6px";
    tally.textContent = `·${cluster.point_count}`;
    el.append(tally);
  }

  el.setAttribute("aria-label",
    `${cluster.point_count} listings from ${low} to ${high}. Zoom in for detail.`);
  el.addEventListener("click", onMarkerClick(onClick));
  return el;
}

/** Zoom > 15: one listing, one price. */
export function listingElement(listing, onClick) {
  const el = document.createElement("button");
  el.type = "button";
  el.className = `chip${listing.price_kind === "one_time" ? " chip--sale" : ""}`;
  el.dataset.listingId = listing.listing_id;
  el.textContent = money(listing.min_price, { compact: true });
  el.setAttribute("aria-label", `${listing.title} — ${money(listing.min_price)}`);
  el.addEventListener("click", onMarkerClick(onClick));
  return el;
}

/** Nearby places, transit stations: a small emoji or glyph puck. */
export function poiElement(glyph, label) {
  const el = document.createElement("div");
  el.className = "poi";
  el.textContent = glyph;
  el.title = label;
  el.setAttribute("role", "img");
  el.setAttribute("aria-label", label);
  return el;
}

/**
 * A quiet placeholder dot for a transit stop — the name shows up on click
 * (via onClick), not as a permanent label, so ~70 metro stations don't turn
 * into ~70 permanent text labels crowding the line.
 */
export function stationDotElement(name, onClick) {
  const el = document.createElement("button");
  el.type = "button";
  el.className = "station-dot";
  el.title = name;
  el.setAttribute("aria-label", `${name} metro station`);
  el.addEventListener("click", onMarkerClick(onClick));
  return el;
}
