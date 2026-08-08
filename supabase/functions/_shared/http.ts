// Shared HTTP helpers: CORS, JSON responses, tiny input guards.
// Every edge function imports from here so behaviour stays identical.

const ALLOWED = (Deno.env.get("ALLOWED_ORIGINS") ?? "*")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export function corsHeaders(origin: string | null): Record<string, string> {
  // Lock responses to the Pages domain in production; "*" only for local dev.
  const allow = ALLOWED.includes("*")
    ? "*"
    : (origin && ALLOWED.includes(origin) ? origin : ALLOWED[0] ?? "");
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Vary": "Origin",
  };
}

export function preflight(req: Request): Response | null {
  if (req.method !== "OPTIONS") return null;
  return new Response("ok", { headers: corsHeaders(req.headers.get("origin")) });
}

export function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req.headers.get("origin")), "Content-Type": "application/json" },
  });
}

export function fail(req: Request, message: string, status = 400, extra: Record<string, unknown> = {}) {
  return json(req, { ok: false, error: message, ...extra }, status);
}

/** Reads JSON body, never throws. */
export async function readJson<T>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}

export function clientIp(req: Request): string {
  return req.headers.get("cf-connecting-ip")
    ?? req.headers.get("x-forwarded-for")?.split(",")[0].trim()
    ?? "unknown";
}
