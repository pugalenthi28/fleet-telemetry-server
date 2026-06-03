/**
 * One-time migration: Neon `charging_sessions` + `trips` → Supabase fleet_ tables.
 *
 * Usage:
 *   NEON_DATABASE_URL="postgres://..." npm run migrate-neon
 *
 * Reads from Neon in batches of 500, upserts into Supabase preserving original IDs.
 * After both tables migrate successfully, sequences are bumped so new inserts don't collide.
 */

import "dotenv/config";
import { Pool } from "pg";
import { createClient } from "@supabase/supabase-js";

const BATCH = 500;

// ── Clients ───────────────────────────────────────────────────────────────────

const neonUrl = process.env.NEON_DATABASE_URL;
if (!neonUrl) { console.error("NEON_DATABASE_URL is required"); process.exit(1); }

const supabaseUrl = process.env.VITE_SUPABASE_URL;
const supabaseKey = process.env.VITE_SUPABASE_ANON_KEY;
if (!supabaseUrl || !supabaseKey) { console.error("SUPABASE_URL + SUPABASE_ANON_KEY are required"); process.exit(1); }

const _neonParsed = new URL(neonUrl.split("?")[0]!);
const neon = new Pool({
  host:     _neonParsed.hostname,
  user:     decodeURIComponent(_neonParsed.username),
  password: decodeURIComponent(_neonParsed.password),
  database: _neonParsed.pathname.slice(1),
  port:     Number(_neonParsed.port) || 5432,
  ssl:      { rejectUnauthorized: false, servername: _neonParsed.hostname },
  connectionTimeoutMillis: 60_000,
});
const supabase  = createClient(supabaseUrl, supabaseKey);

// ── Helpers ───────────────────────────────────────────────────────────────────

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function upsertBatch(table: string, rows: object[], conflict: string): Promise<void> {
  const { error } = await supabase.from(table).upsert(rows, { onConflict: conflict, ignoreDuplicates: false });
  if (error) throw new Error(`[${table}] upsert failed: ${error.message}`);
}

// ── charging_sessions ─────────────────────────────────────────────────────────

async function migrateChargingSessions(): Promise<number> {
  const { rows } = await neon.query<{
    id: number; vin: string; start_time: Date; end_time: Date | null;
    start_battery: number | null; end_battery: number | null;
    start_range: number | null; end_range: number | null;
    energy_added_kwh: number | null; charge_rate_avg: number | null;
    charge_rate_max: number | null; duration_minutes: number | null;
    location: object | null; status: string | null; created_at: Date | null;
    charger_power: number | null; start_odometer: number | null;
    miles_since_last_charge: number | null; end_odometer: number | null;
  }>("SELECT * FROM charging_sessions where start_time < '01-May-2026' ORDER BY id");

  console.log(`  Neon charging_sessions: ${rows.length} rows`);
  if (rows.length === 0) return 0;

  const mapped = rows.map(r => ({
    id:                               r.id,
    vin:                              r.vin,
    start_time:                       r.start_time,
    end_time:                         r.end_time,
    start_battery:                    r.start_battery,
    end_battery:                      r.end_battery,
    start_range:                      r.start_range,
    end_range:                        r.end_range,
    energy_added_kwh:                 r.energy_added_kwh,
    charge_rate_avg:                  r.charge_rate_avg,
    charge_rate_max:                  r.charge_rate_max,
    duration_minutes:                 r.duration_minutes,
    location:                         r.location,
    status:                           r.status ?? "completed",
    created_at:                       r.created_at,
    charger_power:                    r.charger_power,
    start_odometer:                   r.start_odometer != null ? Number(r.start_odometer) : null,
    miles_since_last_charge:          r.miles_since_last_charge != null ? Number(r.miles_since_last_charge) : null,
    end_odometer:                     r.end_odometer != null ? Number(r.end_odometer) : null,
    // Columns not present in Neon — set safe defaults
    cut_off:                          false,
    energy_used_since_last_charge_kwh: null,
    end_ideal_range_mi:               null,
    end_rated_range_mi:               null,
    source:                           'NEON',
  }));

  let inserted = 0;
  for (const batch of chunk(mapped, BATCH)) {
    await upsertBatch("fleet_charging_sessions", batch, "id");
    inserted += batch.length;
    process.stdout.write(`\r  fleet_charging_sessions: ${inserted}/${mapped.length}`);
  }
  console.log("");
  return rows[rows.length - 1]!.id;
}

// ── trips ─────────────────────────────────────────────────────────────────────

async function migrateTrips(): Promise<number> {
  const { rows } = await neon.query<{
    id: number; vin: string; start_time: Date; end_time: Date | null;
    start_location: object | null; end_location: object | null;
    start_battery: number | null; end_battery: number | null;
    start_odometer: number | null; end_odometer: number | null;
    distance_miles: number | null; energy_used_kwh: number | null;
    avg_speed: number | null; max_speed: number | null;
    status: string | null; created_at: Date | null; last_seen_at: Date | null;
  }>("SELECT * FROM trips where start_time < '01-May-2026' ORDER BY id");

  console.log(`  Neon trips: ${rows.length} rows`);
  if (rows.length === 0) return 0;

  // Don't carry over Neon IDs — Supabase auto-assigns new ones above existing SUPA trip IDs.
  const mapped = rows.map(r => ({
    vin:             r.vin,
    start_time:      r.start_time,
    end_time:        r.end_time,
    start_location:  r.start_location,
    end_location:    r.end_location,
    start_battery:   r.start_battery,
    end_battery:     r.end_battery,
    start_odometer:  r.start_odometer,
    end_odometer:    r.end_odometer,
    distance_miles:  r.distance_miles,
    energy_used_kwh: r.energy_used_kwh,
    avg_speed:       r.avg_speed,
    max_speed:       r.max_speed,
    status:          r.status ?? "completed",
    created_at:      r.created_at,
    last_seen_at:    r.last_seen_at ?? r.end_time ?? r.start_time,
    // Columns not present in Neon — set safe defaults
    start_energy_kwh:  null,
    charge_accounted:  null,
    cut_off:           false,
    source:            'NEON',
  }));

  let inserted = 0;
  for (const batch of chunk(mapped, BATCH)) {
    const { error } = await supabase.from("fleet_trips").insert(batch);
    if (error) throw new Error(`[fleet_trips] insert failed: ${error.message}`);
    inserted += batch.length;
    process.stdout.write(`\r  fleet_trips: ${inserted}/${mapped.length}`);
  }
  console.log("");
  return 0; // sequence not needed — Supabase auto-manages it
}

// ── Sequence reset ─────────────────────────────────────────────────────────────
// After inserting rows with explicit IDs, the BIGSERIAL sequences are still at 1.
// We must advance them past the highest migrated ID or the next insert will fail.

async function resetSequence(table: string, maxId: number): Promise<void> {
  // Supabase exposes pg via the SQL editor only — use a raw RPC call.
  // setval(sequence, value, is_called=true) means the next nextval() returns value+1.
  const { error } = await supabase.rpc("setval_sequence", { seq: `${table}_id_seq`, val: maxId });
  if (error) {
    // RPC may not exist — print the SQL to run manually in the SQL Editor.
    console.warn(`  ⚠️  Could not auto-reset sequence for ${table}. Run this in Supabase SQL Editor:`);
    console.warn(`     SELECT setval('${table}_id_seq', ${maxId});`);
  } else {
    console.log(`  ✓ Sequence ${table}_id_seq reset to ${maxId}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("Connecting to Neon (may take up to 60s if compute is suspended)...");
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await neon.query("SELECT 1");
      break;
    } catch (err) {
      if (attempt === 3) throw err;
      console.log(`  attempt ${attempt} failed, retrying...`);
    }
  }
  console.log("✓ Neon connected\n");

  console.log("── Migrating charging_sessions ──────────────────────────────");
  const maxChargeId = await migrateChargingSessions();

  console.log("\n── Migrating trips ──────────────────────────────────────────");
  const maxTripId = await migrateTrips();

  console.log("\n── Resetting sequences ──────────────────────────────────────");
  if (maxChargeId > 0) await resetSequence("fleet_charging_sessions", maxChargeId);
  if (maxTripId   > 0) await resetSequence("fleet_trips",             maxTripId);

  console.log("\n✅ Migration complete.");
  console.log(`   fleet_charging_sessions: max id = ${maxChargeId}`);
  console.log(`   fleet_trips:             max id = ${maxTripId}`);

  // If sequence RPC didn't exist, remind the user
  console.log("\nIf sequences weren't auto-reset, run in Supabase SQL Editor:");
  console.log(`  SELECT setval('fleet_charging_sessions_id_seq', ${maxChargeId});`);
  console.log(`  SELECT setval('fleet_trips_id_seq', ${maxTripId});`);

  await neon.end();
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
