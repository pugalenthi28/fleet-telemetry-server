import { createClient, SupabaseClient } from "@supabase/supabase-js";

let _client: SupabaseClient | null = null;
let _warned = false;

export function getSupabase(): SupabaseClient | null {
  if (_client) return _client;

  // Read lazily so dotenv has time to load before this is first called
  const url = process.env.VITE_SUPABASE_URL;
  const key = process.env.VITE_SUPABASE_ANON_KEY;

  if (!url || !key) {
    if (!_warned) {
      console.warn("[DB] VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY not set — database writes disabled");
      _warned = true;
    }
    return null;
  }

  _client = createClient(url, key);
  console.log("[DB] Supabase client initialised →", url);
  return _client;
}

/** Ping Supabase at startup to confirm connectivity. Call once from server.ts. */
export async function pingSupabase(): Promise<void> {
  const client = getSupabase();
  if (!client) return;
  try {
    const { error } = await client.from("fleet_vehicles").select("vin").limit(1);
    if (error) {
      console.error("[DB] Supabase connectivity check FAILED:", error.message);
    } else {
      console.log("[DB] Supabase connectivity check OK");
    }
  } catch (err: any) {
    console.error("[DB] Supabase connectivity check FAILED:", err.message);
  }
}
