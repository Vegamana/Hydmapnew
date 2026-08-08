// Razorpay helpers for Deno. No SDK — two REST calls and one HMAC check.

const API = "https://api.razorpay.com/v1";

function authHeader(): string {
  const id     = Deno.env.get("RAZORPAY_KEY_ID");
  const secret = Deno.env.get("RAZORPAY_KEY_SECRET");
  if (!id || !secret) throw new Error("RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are not set");
  return "Basic " + btoa(`${id}:${secret}`);
}

export interface Order { id: string; amount: number; currency: string; status: string }

export async function createOrder(args: {
  amountPaise: number;
  receipt: string;
  notes?: Record<string, string>;
}): Promise<Order> {
  const res = await fetch(`${API}/orders`, {
    method: "POST",
    headers: { Authorization: authHeader(), "Content-Type": "application/json" },
    body: JSON.stringify({
      amount: args.amountPaise,
      currency: "INR",
      receipt: args.receipt.slice(0, 40),
      notes: args.notes ?? {},
      payment_capture: 1,
    }),
  });
  if (!res.ok) throw new Error(`Razorpay order failed ${res.status}: ${await res.text()}`);
  return await res.json() as Order;
}

/** HMAC-SHA256 over the exact string Razorpay signs, compared in constant time. */
export async function verifySignature(payload: string, signature: string, secret: string): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  const expected = Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");

  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}
