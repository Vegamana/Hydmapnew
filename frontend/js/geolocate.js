/**
 * "Locate me" — one-shot, button-triggered (not continuous tracking, and no
 * permission prompt on page load). A single blue dot plus an accuracy
 * circle, the same convention every map app uses, so it needs no
 * explanation.
 */
import { state } from "./map.js";
import { MAP } from "./config.js";
import { toast } from "./toast.js";
import { createMarker } from "./markers.js";

let marker = null;
let accuracyCircle = null;

function placeDot(lat, lng, accuracyM) {
  marker?.setMap(null);
  accuracyCircle?.setMap(null);

  accuracyCircle = new state.maps.Circle({
    center: { lat, lng },
    radius: accuracyM,
    map: state.map,
    strokeColor: "#1A73E8", strokeOpacity: 0.25, strokeWeight: 1,
    fillColor: "#1A73E8", fillOpacity: 0.12,
    clickable: false, zIndex: 3,
  });

  const el = document.createElement("div");
  el.className = "you-are-here";
  el.setAttribute("role", "img");
  el.setAttribute("aria-label", "Your location");

  marker = createMarker(state.maps, { lat, lng }, el, { pane: "overlayMouseTarget" });
  marker.setMap(state.map);
}

function inBounds(lat, lng) {
  return lat >= MAP.bounds.south && lat <= MAP.bounds.north
      && lng >= MAP.bounds.west  && lng <= MAP.bounds.east;
}

function locate() {
  if (!navigator.geolocation) {
    toast("Your browser doesn't support location.", "bad");
    return;
  }

  const btn = document.getElementById("locate-btn");
  btn.disabled = true;

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      btn.disabled = false;
      const { latitude: lat, longitude: lng, accuracy } = pos.coords;

      if (!inBounds(lat, lng)) {
        toast("Your location is outside the Hyderabad map area.", "bad");
        return;
      }

      placeDot(lat, lng, accuracy);
      state.map.panTo({ lat, lng });
      if (state.map.getZoom() < 15) state.map.setZoom(15);
    },
    (err) => {
      btn.disabled = false;
      const message = err.code === err.PERMISSION_DENIED
        ? "Location access was denied. Enable it in your browser's site settings to use this."
        : "Couldn't get your location. Try again.";
      toast(message, "bad");
    },
    { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 },
  );
}

export function initGeolocate() {
  document.getElementById("locate-btn").addEventListener("click", locate);
}
