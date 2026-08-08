/** Formatting helpers. Every number the user sees passes through here. */

const inr = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });

/** 32000 -> "₹32,000"; 9500000 -> "₹95.0L"; 12500000 -> "₹1.25Cr" */
export function money(value, { compact = false } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  if (compact) {
    if (n >= 1e7) return `₹${(n / 1e7).toFixed(n >= 1e8 ? 1 : 2)}Cr`;
    if (n >= 1e5) return `₹${(n / 1e5).toFixed(1)}L`;
    if (n >= 1000) return `₹${Math.round(n / 1000)}k`;
  }
  return `₹${inr.format(Math.round(n))}`;
}

export function count(n) {
  const v = Number(n) || 0;
  return v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v);
}

export function timeAgo(iso) {
  const then = new Date(iso).getTime();
  if (!then) return "";
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

export const TYPE_LABEL = {
  rent: "Rent", sale: "Sale", sharing: "Sharing", rent_paid: "Rent paid",
};

export const TYPE_CLASS = {
  rent: "", sale: "sale", sharing: "sharing", rent_paid: "paid",
};

/** Simple leading/trailing debounce. Used for search, map idle and AQI. */
export function debounce(fn, wait) {
  let timer;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
  wrapped.cancel = () => clearTimeout(timer);
  return wrapped;
}

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
