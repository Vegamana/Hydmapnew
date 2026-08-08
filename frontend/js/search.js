/**
 * Place search using the current Places Autocomplete API.
 *
 * Cost control matters here more than anywhere else in the frontend:
 *   - a session token groups every keystroke of one search plus the final
 *     place lookup into a single billable session
 *   - input is debounced, and queries under 3 characters never leave the browser
 *   - results are biased to the Hyderabad bounds, so the ranking is useful
 *     without a second filtering call
 *   - only the two fields we actually use are requested from the chosen place
 */
import { MAP, DEFAULTS } from "./config.js";
import { debounce, escapeHtml } from "./format.js";
import { panTo } from "./map.js";

let AutocompleteSuggestion, AutocompleteSessionToken, LatLngBounds;
let sessionToken = null;
let suggestions = [];
let cursor = -1;

async function ensureLibrary() {
  if (AutocompleteSuggestion) return;
  const places = await google.maps.importLibrary("places");
  const core = await google.maps.importLibrary("core");
  AutocompleteSuggestion = places.AutocompleteSuggestion;
  AutocompleteSessionToken = places.AutocompleteSessionToken;
  LatLngBounds = core.LatLngBounds;
}

const newSession = () => { sessionToken = new AutocompleteSessionToken(); };

function render(list, input, results) {
  results.innerHTML = "";
  if (!list.length) {
    results.hidden = true;
    input.setAttribute("aria-expanded", "false");
    return;
  }

  list.forEach((item, index) => {
    const prediction = item.placePrediction;
    const li = document.createElement("li");
    li.role = "option";
    li.id = `search-option-${index}`;
    li.setAttribute("aria-selected", String(index === cursor));
    li.innerHTML = `${escapeHtml(prediction.mainText?.text ?? prediction.text.text)}
      <small>${escapeHtml(prediction.secondaryText?.text ?? "")}</small>`;
    li.addEventListener("mousedown", (e) => { e.preventDefault(); choose(index, input, results); });
    results.append(li);
  });

  results.hidden = false;
  input.setAttribute("aria-expanded", "true");
}

async function choose(index, input, results) {
  const item = suggestions[index];
  if (!item) return;

  const place = item.placePrediction.toPlace();
  // Session token is consumed by this fetch — everything typed before it was
  // billed as one session, not one call per keystroke.
  await place.fetchFields({ fields: ["location", "displayName", "viewport"] });
  sessionToken = null;

  input.value = place.displayName ?? item.placePrediction.text.text;
  results.hidden = true;
  input.setAttribute("aria-expanded", "false");
  suggestions = [];
  cursor = -1;

  const location = place.location;
  if (location) panTo(location.lat(), location.lng(), 15);
}

export function initSearch() {
  const input = document.getElementById("search-input");
  const results = document.getElementById("search-results");
  const clear = document.getElementById("search-clear");

  const run = debounce(async (value) => {
    await ensureLibrary();
    if (!sessionToken) newSession();

    try {
      const { suggestions: found } = await AutocompleteSuggestion.fetchAutocompleteSuggestions({
        input: value,
        sessionToken,
        includedRegionCodes: ["in"],
        locationBias: new LatLngBounds(
          { lat: MAP.bounds.south, lng: MAP.bounds.west },
          { lat: MAP.bounds.north, lng: MAP.bounds.east },
        ),
      });
      suggestions = found.filter((s) => s.placePrediction).slice(0, 6);
      cursor = -1;
      render(suggestions, input, results);
    } catch (err) {
      console.error("autocomplete failed", err);
    }
  }, DEFAULTS.searchDebounceMs);

  input.addEventListener("input", () => {
    const value = input.value.trim();
    clear.hidden = value.length === 0;
    if (value.length < 3) {
      run.cancel();
      suggestions = [];
      render([], input, results);
      return;
    }
    run(value);
  });

  input.addEventListener("keydown", (event) => {
    if (results.hidden) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      cursor = (cursor + (event.key === "ArrowDown" ? 1 : -1) + suggestions.length) % suggestions.length;
      render(suggestions, input, results);
      input.setAttribute("aria-activedescendant", `search-option-${cursor}`);
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(cursor === -1 ? 0 : cursor, input, results);
    } else if (event.key === "Escape") {
      results.hidden = true;
      input.blur();
    }
  });

  input.addEventListener("blur", () => setTimeout(() => { results.hidden = true; }, 120));

  clear.addEventListener("click", () => {
    input.value = "";
    clear.hidden = true;
    suggestions = [];
    render([], input, results);
    input.focus();
  });
}
