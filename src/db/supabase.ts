import { createClient, SupabaseClient } from "@supabase/supabase-js";

const url = process.env.VITE_SUPABASE_URL;
const key = process.env.VITE_SUPABASE_ANON_KEY;

let _client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient | null {
  if (_client) return _client;
  if (!url || !key) {
    console.warn("[DB] VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY not set — database writes disabled");
    return null;
  }
  _client = createClient(url, key);
  console.log("[DB] Supabase client initialised →", url);
  return _client;
}
