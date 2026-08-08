// Service-role Supabase client. This key bypasses RLS, so it must never
// leave the edge runtime — the browser only ever talks to these functions.
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

let cached: SupabaseClient | null = null;

export function db(): SupabaseClient {
  if (cached) return cached;
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set");
  cached = createClient(url, key, { auth: { persistSession: false } });
  return cached;
}
