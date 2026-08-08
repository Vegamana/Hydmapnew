// Input validation. Deliberately boring and explicit — this is the only
// gate between an anonymous form and the database.

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const PHONE_RE = /^[6-9]\d{9}$/;           // Indian mobile numbers
export const UUID_RE  = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function clean(v: unknown, max = 200): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

/** Strips characters that would let user input break out of our HTML emails. */
export function esc(v: string): string {
  return v.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!)
  );
}

export interface InterestInput {
  listing_id: string;
  name: string;
  phone: string;
  email: string;
  message: string;
  wants_to_pay: boolean;
}

export function parseInterest(body: Record<string, unknown> | null): { data?: InterestInput; error?: string } {
  if (!body) return { error: "Send a JSON body." };

  const listing_id = clean(body.listing_id, 40);
  const name       = clean(body.name, 80);
  const phone      = clean(body.phone, 15).replace(/\D/g, "").slice(-10);
  const email      = clean(body.email, 120).toLowerCase();
  const message    = clean(body.message, 500);

  if (!UUID_RE.test(listing_id)) return { error: "That listing could not be found." };
  if (name.length < 2)           return { error: "Enter your name." };
  if (!PHONE_RE.test(phone))     return { error: "Enter a 10-digit mobile number." };
  if (!EMAIL_RE.test(email))     return { error: "Enter a valid email address." };

  return { data: { listing_id, name, phone, email, message, wants_to_pay: body.wants_to_pay === true } };
}

// Same Hyderabad box the frontend restricts the map to (frontend/js/config.js
// MAP.bounds) — checked again here because the browser's copy is not trusted.
const HYD_BOUNDS = { north: 17.75, south: 17.10, east: 78.85, west: 78.05 };

const LISTING_TYPES = ["rent", "sale", "sharing"] as const;
const BHK_VALUES = ["1", "2", "3", "4", "5+"] as const;
const FURNISHING_VALUES = ["furnished", "semi", "unfurnished"] as const;
const GENDER_VALUES = ["male", "female", "any"] as const;

export interface ListingSubmissionInput {
  title: string;
  type: typeof LISTING_TYPES[number];
  price: number;
  lat: number;
  lng: number;
  bhk: string | null;
  furnishing: string | null;
  gated: boolean | null;
  deposit: number | null;
  parking: number | null;
  square_footage: number | null;
  gender_preference: string | null;
  description: string | null;
  owner_email: string;
  owner_phone: string | null;
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function parseListingSubmission(
  body: Record<string, unknown> | null,
): { data?: ListingSubmissionInput; error?: string } {
  if (!body) return { error: "Send a JSON body." };

  const title = clean(body.title, 140);
  const type = clean(body.type, 20) as ListingSubmissionInput["type"];
  const price = Number(body.price);
  const lat = Number(body.lat);
  const lng = Number(body.lng);
  const owner_email = clean(body.owner_email, 120).toLowerCase();
  const owner_phone = clean(body.owner_phone, 15).replace(/\D/g, "").slice(-10);

  if (title.length < 3)                    return { error: "Give the listing a short title." };
  if (!LISTING_TYPES.includes(type))       return { error: "Choose rent, sharing or sale." };
  if (!Number.isFinite(price) || price <= 0) return { error: "Enter a valid price." };
  if (!Number.isFinite(lat) || !Number.isFinite(lng))
    return { error: "Set the location by tapping the map." };
  if (lat < HYD_BOUNDS.south || lat > HYD_BOUNDS.north || lng < HYD_BOUNDS.west || lng > HYD_BOUNDS.east)
    return { error: "That location is outside the Hyderabad map area." };
  if (!EMAIL_RE.test(owner_email))         return { error: "Enter a valid email address — this is where the confirmation link goes." };
  if (owner_phone && !PHONE_RE.test(owner_phone))
    return { error: "Enter a 10-digit mobile number, or leave it blank." };

  const bhk = clean(body.bhk, 5);
  const furnishing = clean(body.furnishing, 20);
  const gender_preference = clean(body.gender_preference, 10);
  const description = clean(body.description, 2000);
  const deposit = numOrNull(body.deposit);
  const parking = numOrNull(body.parking);
  const square_footage = numOrNull(body.square_footage);

  if (bhk && !BHK_VALUES.includes(bhk as typeof BHK_VALUES[number]))
    return { error: "That bedroom count is not valid." };
  if (furnishing && !FURNISHING_VALUES.includes(furnishing as typeof FURNISHING_VALUES[number]))
    return { error: "That furnishing option is not valid." };
  if (gender_preference && !GENDER_VALUES.includes(gender_preference as typeof GENDER_VALUES[number]))
    return { error: "That preference is not valid." };
  if (deposit !== null && deposit < 0)          return { error: "Deposit cannot be negative." };
  if (parking !== null && (parking < 0 || parking > 10)) return { error: "Parking slots must be between 0 and 10." };
  if (square_footage !== null && (square_footage < 0 || square_footage > 100000))
    return { error: "That area does not look right." };

  return {
    data: {
      title, type, price, lat, lng,
      bhk: bhk || null,
      furnishing: furnishing || null,
      gated: body.gated === true ? true : body.gated === false ? false : null,
      deposit, parking, square_footage,
      gender_preference: gender_preference || null,
      description: description || null,
      owner_email,
      owner_phone: owner_phone || null,
    },
  };
}

// ---------------------------------------------------------------------
// The three map-click-chooser actions. All three share the same location
// check as listings; none of them collect a name.
// ---------------------------------------------------------------------

function checkLatLng(lat: number, lng: number): string | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return "Set the location by tapping the map.";
  if (lat < HYD_BOUNDS.south || lat > HYD_BOUNDS.north || lng < HYD_BOUNDS.west || lng > HYD_BOUNDS.east)
    return "That location is outside the Hyderabad map area.";
  return null;
}

export interface RentReportInput {
  price: number;
  type: "rent" | "sharing";
  bhk: string | null;
  lat: number;
  lng: number;
}

export function parseRentReport(body: Record<string, unknown> | null): { data?: RentReportInput; error?: string } {
  if (!body) return { error: "Send a JSON body." };

  const price = Number(body.price);
  const type = clean(body.type, 20) as RentReportInput["type"];
  const bhk = clean(body.bhk, 5);
  const lat = Number(body.lat);
  const lng = Number(body.lng);

  if (!Number.isFinite(price) || price <= 0) return { error: "Enter what you actually pay." };
  if (!["rent", "sharing"].includes(type)) return { error: "Choose rent or sharing." };
  if (bhk && !BHK_VALUES.includes(bhk as typeof BHK_VALUES[number])) return { error: "That bedroom count is not valid." };
  const locErr = checkLatLng(lat, lng);
  if (locErr) return { error: locErr };

  return { data: { price, type, bhk: bhk || null, lat, lng } };
}

export interface SeekerInput {
  email: string;
  type: typeof LISTING_TYPES[number];
  budget_min: number | null;
  budget_max: number | null;
  bhk: string | null;
  lat: number;
  lng: number;
  radius_m: number;
}

export function parseSeeker(body: Record<string, unknown> | null): { data?: SeekerInput; error?: string } {
  if (!body) return { error: "Send a JSON body." };

  const email = clean(body.email, 120).toLowerCase();
  const type = clean(body.type, 20) as SeekerInput["type"];
  const bhk = clean(body.bhk, 5);
  const lat = Number(body.lat);
  const lng = Number(body.lng);
  const budget_min = numOrNull(body.budget_min);
  const budget_max = numOrNull(body.budget_max);
  const radius_m = Number(body.radius_m ?? 3000);

  if (!EMAIL_RE.test(email)) return { error: "Enter a valid email address — matches land here." };
  if (!LISTING_TYPES.includes(type)) return { error: "Choose rent, sharing or sale." };
  if (bhk && !BHK_VALUES.includes(bhk as typeof BHK_VALUES[number])) return { error: "That bedroom count is not valid." };
  if (budget_min !== null && budget_min < 0) return { error: "Budget cannot be negative." };
  if (budget_max !== null && budget_min !== null && budget_max < budget_min)
    return { error: "Max budget should be more than min budget." };
  const locErr = checkLatLng(lat, lng);
  if (locErr) return { error: locErr };

  return {
    data: {
      email, type, budget_min, budget_max, bhk: bhk || null, lat, lng,
      radius_m: Number.isFinite(radius_m) ? Math.min(Math.max(radius_m, 250), 25000) : 3000,
    },
  };
}

export interface BoardSightingInput {
  phone: string;
  note: string | null;
  lat: number;
  lng: number;
}

export function parseBoardSighting(body: Record<string, unknown> | null): { data?: BoardSightingInput; error?: string } {
  if (!body) return { error: "Send a JSON body." };

  const phone = clean(body.phone, 15).replace(/\D/g, "").slice(-10);
  const note = clean(body.note, 300);
  const lat = Number(body.lat);
  const lng = Number(body.lng);

  if (!PHONE_RE.test(phone)) return { error: "Enter the 10-digit number from the board." };
  const locErr = checkLatLng(lat, lng);
  if (locErr) return { error: locErr };

  return { data: { phone, note: note || null, lat, lng } };
}
