/**
 * Entry point. Wires the modules together and owns the small amount of state
 * that is genuinely global: which listing is open, and what the URL says.
 *
 * Load order matters for perceived speed: the map paints first, then the
 * panels attach, then anything deep-linked resolves.
 */
import { initMap, state, viewport, panTo, setActiveListing } from "./map.js";
import { initSearch } from "./search.js";
import { initControls } from "./controls.js";
import { initPulse, updatePulse } from "./pulse.js";
import { initNearby } from "./nearby.js";
import { initListing, openListing, closeListing } from "./listing.js";
import { initModal } from "./modal.js";
import { initListingForm } from "./listingForm.js";
import { initMapActions } from "./mapActions.js";
import { initGeolocate } from "./geolocate.js";
import { toast } from "./toast.js";
import { count } from "./format.js";

async function main() {
  const container = document.getElementById("map");

  try {
    await initMap(container);
  } catch (err) {
    console.error("map failed to load", err);
    container.innerHTML = `<div class="noscript">The map could not load.
      Check your connection and reload the page.</div>`;
    return;
  }

  // Panels
  initSearch();
  initControls(document.getElementById("rail"));
  initPulse();
  initNearby();
  initModal();
  initListingForm();
  initMapActions();
  initGeolocate();
  initListing({
    onClose: () => {
      setActiveListing(null);
      // Opening a listing pushed a history entry, so closing pops it — the
      // hardware back button and the close button do the same thing.
      if (new URLSearchParams(location.search).get("listing")) history.back();
    },
  });

  // A listing chip was clicked.
  state.onListingClick = (id, point) => {
    openListing(id);
    if (new URLSearchParams(location.search).get("listing") !== id) {
      history.pushState({ listing: id }, "", `?listing=${id}`);
    }
    // Nudge the map so the sheet does not cover the pin on narrow screens.
    if (window.innerWidth <= 720) panTo(point.lat - 0.004, point.lng);
  };

  // The viewport settled: resample the rent pulse.
  state.onIdle = (view) => updatePulse(view.center);

  // Keep the results count honest with whatever is actually drawn.
  document.addEventListener("markers:drawn", (event) => {
    const { total, zoom } = event.detail;
    const output = document.getElementById("results-count");
    output.textContent = total
      ? `${count(total)} ${total === 1 ? "listing" : "listings"}${zoom <= 10 ? " in view" : ""}`
      : "Nothing here yet";
  });

  // First paint of the pulse, once bounds exist.
  google.maps.event.addListenerOnce(state.map, "idle", () => {
    const view = viewport();
    if (view) updatePulse(view.center);
  });

  // Deep link: /?listing=<uuid> opens straight to a listing, which is what the
  // links in every notification email point at.
  const wanted = new URLSearchParams(location.search).get("listing");
  if (wanted) {
    try {
      const { fetchListing } = await import("./api.js");
      const listing = await fetchListing(wanted);
      panTo(listing.lat, listing.lng, 17);
      openListing(listing.id);
      setActiveListing(listing.id);
    } catch {
      toast("That listing is no longer on the map.", "bad");
      history.replaceState(null, "", location.pathname);
    }
  }

  // Browser back should close the sheet rather than leave the page.
  window.addEventListener("popstate", () => {
    if (!new URLSearchParams(location.search).get("listing")) closeListing();
  });
}

main();
