/** One transient message at a time, auto-dismissed. Errors say what to do. */
let timer;

export function toast(message, tone = "ok", ms = 3200) {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.className = `toast${tone === "bad" ? " toast--bad" : ""}`;
  el.hidden = false;
  clearTimeout(timer);
  timer = setTimeout(() => { el.hidden = true; }, ms);
}
