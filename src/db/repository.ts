/**
 * All Supabase write operations — column names match the fleet_ table schema exactly.
 */

import { getSupabase } from "./supabase";
import { TelemetryRecord } from "../telemetry/store";
import { TokenSet } from "../auth/tokenStore";

function db() { return getSupabase(); }
function logErr(fn: string, msg: string, details?: unknown) {
  console.error(`[DB] ${fn}: ${msg}`, details ?? "");
}

// ── Vehicles ──────────────────────────────────────────────────────────────────

export async function upsertVehicle(vin: string, displayName?: string): Promise<void> {
  const client = db();
  if (!client) return;
  const { error } = await client
    .from("fleet_vehicles")
    .upsert(
      { vin, display_name: displayName ?? null, last_seen: new Date().toISOString() },
      { onConflict: "vin" },
    );
  if (error) logErr("upsertVehicle", error.message, error);
}

// ── Telemetry state (dashboard snapshot, one row per VIN) ─────────────────────

export async function upsertTelemetryState(
  vin: string,
  rawState: Record<string, unknown>,
): Promise<void> {
  const client = db();
  if (!client) return;

  // Only include fields that are present in rawState — never overwrite a stored
  // column with null just because the field hasn't arrived yet in this session.
  const row: Record<string, unknown> = { vin, updated_at: new Date().toISOString(), raw_state: rawState };
  const set = (col: string, key: string) => {
    const v = rawState[key];
    if (v !== null && v !== undefined) row[col] = v;
  };

  set("gear",                  "Gear");
  set("vehicle_speed_mph",     "VehicleSpeed");
  set("odometer_mi",           "Odometer");
  set("soc_pct",               "Soc");
  set("battery_level_pct",     "BatteryLevel");
  set("est_battery_range_mi",  "EstBatteryRange");
  set("energy_remaining_kwh",  "EnergyRemaining");
  set("rated_range_mi",        "IdealBatteryRange");
  set("ideal_battery_range_mi","RatedRange");
  set("detailed_charge_state", "DetailedChargeState");
  set("charge_amps",           "ChargeAmps");
  set("charger_voltage_v",     "ChargerVoltage");
  set("ac_charging_power_kw",  "ACChargingPower");
  set("dc_charging_power_kw",  "DCChargingPower");
  set("charge_limit_soc_pct",  "ChargeLimitSoc");
  set("time_to_full_charge_h", "TimeToFullCharge");
  set("charge_port_door_open", "ChargePortDoorOpen");
  set("inside_temp_c",         "InsideTemp");
  set("outside_temp_c",        "OutsideTemp");
  set("locked",                "Locked");
  set("vehicle_name",          "VehicleName");
  set("software_version",      "Version");

  const { error } = await client
    .from("fleet_telemetry_state")
    .upsert(row, { onConflict: "vin" });
  if (error) logErr("upsertTelemetryState", error.message, error);
}

// ── Telemetry data (append-only log, opt-in via ENABLE_TELEMETRY_EVENTS=true) ──

export async function insertTelemetryData(record: TelemetryRecord, force = false): Promise<void> {
  if (!force && process.env.ENABLE_TELEMETRY_EVENTS !== "true") return;
  const client = db();
  if (!client) return;

  const f   = record.fields;
  const num = (k: string) => (f[k] as number) ?? null;
  const rnd = (k: string) => f[k] != null ? Math.round(f[k] as number) : null;
  const bol = (k: string) => (f[k] as boolean) ?? null;
  const str = (k: string) => (f[k] as string)  ?? null;
  const dcKw = num("DCChargingPower");
  const acKw = num("ACChargingPower");

  const { error } = await client.from("fleet_telemetry_data").insert({
    vin:                   record.vin,
    recorded_at:           new Date(record.createdAt).toISOString(),
    // ── Motion ────────────────────────────────────────────────────────────
    speed:                 num("VehicleSpeed"),
    odometer:              num("Odometer"),
    shift_state:           str("Gear"),
    // ── Battery ───────────────────────────────────────────────────────────
    battery_level:         rnd("BatteryLevel"),
    usable_battery_level:  num("Soc"),
    est_battery_range:     num("EstBatteryRange"),
    rated_range_mi:        num("RatedRange"),
    ideal_range_mi:        num("IdealBatteryRange"),
    energy_remaining_kwh:  num("EnergyRemaining"),
    // ── Charging ──────────────────────────────────────────────────────────
    charge_state:          str("DetailedChargeState"),
    charge_amps:           num("ChargeAmps"),
    charger_voltage_v:     num("ChargerVoltage"),
    ac_charging_power_kw:  acKw,
    dc_charging_power_kw:  dcKw,
    charge_rate:           acKw ?? dcKw,
    charger_power:         dcKw != null ? Math.round(dcKw) : (acKw != null ? Math.round(acKw) : null),
    charge_limit_soc:      rnd("ChargeLimitSoc"),
    time_to_full_charge_h: num("TimeToFullCharge"),
    charge_port_door_open: bol("ChargePortDoorOpen"),
    // ── Climate / misc ────────────────────────────────────────────────────
    inside_temp_c:         num("InsideTemp"),
    outside_temp_c:        num("OutsideTemp"),
    locked:                bol("Locked"),
    software_version:      str("Version"),
    // ── Catch-all ─────────────────────────────────────────────────────────
    power:                 null,
    raw_data:              f,
  });
  if (error) logErr("insertTelemetryData", error.message, error);
}

// ── Trips ─────────────────────────────────────────────────────────────────────

export async function insertTrip(data: {
  vin: string;
  start_time: Date;
  start_battery: number;
  start_odometer: number;
  start_energy_kwh?: number | null;
  start_location?: { latitude: number; longitude: number } | null;
}): Promise<number | null> {
  const client = db();
  if (!client) return null;
  const { data: row, error } = await client
    .from("fleet_trips")
    .insert({
      vin:               data.vin,
      start_time:        data.start_time.toISOString(),
      start_battery:     data.start_battery,
      start_odometer:    data.start_odometer,
      start_energy_kwh:  data.start_energy_kwh ?? null,
      start_location:    data.start_location ?? null,
      status:            "active",
      last_seen_at:      data.start_time.toISOString(),
    })
    .select("id")
    .single();
  if (error) { logErr("insertTrip", error.message, error); return null; }
  return (row as { id: number } | null)?.id ?? null;
}

export async function completeTrip(
  id: number,
  data: {
    end_time: Date;
    end_battery: number;
    end_odometer: number;
    distance_miles: number;
    energy_used_kwh: number;
    avg_speed: number | null;
    max_speed: number | null;
    end_location?: { latitude: number; longitude: number } | null;
  },
): Promise<void> {
  const client = db();
  if (!client) return;
  const { error } = await client
    .from("fleet_trips")
    .update({
      end_time:        data.end_time.toISOString(),
      end_battery:     data.end_battery,
      end_odometer:    data.end_odometer,
      distance_miles:  data.distance_miles,
      energy_used_kwh: data.energy_used_kwh,
      avg_speed:       data.avg_speed,
      max_speed:       data.max_speed,
      end_location:    data.end_location ?? null,
      status:          "completed",
      last_seen_at:    data.end_time.toISOString(),
    })
    .eq("id", id);
  if (error) logErr("completeTrip", error.message, error);
}

// Returns total energy_used_kwh of unaccounted trips and marks them accounted atomically
export async function sumAndMarkTripsAccounted(vin: string): Promise<number> {
  const client = db();
  if (!client) return 0;
  const { data, error } = await client
    .from("fleet_trips")
    .select("id, energy_used_kwh")
    .eq("vin", vin)
    .eq("status", "completed")
    .is("charge_accounted", null);
  if (error) { logErr("sumAndMarkTripsAccounted", error.message, error); return 0; }
  const rows = (data ?? []) as Array<{ id: number; energy_used_kwh: number | null }>;
  if (rows.length === 0) return 0;
  const total = rows.reduce((sum, r) => sum + (r.energy_used_kwh ?? 0), 0);
  const ids   = rows.map(r => r.id);
  client.from("fleet_trips").update({ charge_accounted: true }).in("id", ids)
    .then(({ error: e }) => { if (e) logErr("sumAndMarkTripsAccounted(mark)", e.message, e); });
  return total;
}

export async function deleteTrip(id: number): Promise<void> {
  const client = db();
  if (!client) return;
  const { error } = await client.from("fleet_trips").delete().eq("id", id);
  if (error) logErr("deleteTrip", error.message, error);
}

export async function updateChargeSessionStart(
  id: number,
  data: { start_odometer?: number; start_range?: number },
): Promise<void> {
  const client = db();
  if (!client) return;
  const patch: Record<string, number> = {};
  if (data.start_odometer !== undefined) patch.start_odometer = data.start_odometer;
  if (data.start_range    !== undefined) patch.start_range    = data.start_range;
  if (Object.keys(patch).length === 0) return;
  const { error } = await client.from("fleet_charging_sessions").update(patch).eq("id", id);
  if (error) logErr("updateChargeSessionStart", error.message, error);
}

export async function updateTripStartOdometer(id: number, startOdometer: number): Promise<void> {
  const client = db();
  if (!client) return;
  const { error } = await client
    .from("fleet_trips")
    .update({ start_odometer: startOdometer })
    .eq("id", id);
  if (error) logErr("updateTripStartOdometer", error.message, error);
}

export async function updateTripStartEnergy(id: number, startEnergyKwh: number): Promise<void> {
  const client = db();
  if (!client) return;
  const { error } = await client
    .from("fleet_trips")
    .update({ start_energy_kwh: startEnergyKwh })
    .eq("id", id);
  if (error) logErr("updateTripStartEnergy", error.message, error);
}

export async function updateTripLastSeen(id: number, at: Date): Promise<void> {
  const client = db();
  if (!client) return;
  const { error } = await client
    .from("fleet_trips")
    .update({ last_seen_at: at.toISOString() })
    .eq("id", id);
  if (error) logErr("updateTripLastSeen", error.message, error);
}

// ── Charging sessions ─────────────────────────────────────────────────────────

export async function insertChargingSession(data: {
  vin: string;
  start_time: Date;
  start_battery: number;
  start_range: number;
  start_odometer: number;
  miles_since_last_charge: number;
  energy_used_since_last_charge_kwh: number;
  charger_power?: number | null;
}): Promise<number | null> {
  const client = db();
  if (!client) return null;
  const { data: row, error } = await client
    .from("fleet_charging_sessions")
    .insert({
      vin:                               data.vin,
      start_time:                        data.start_time.toISOString(),
      start_battery:                     data.start_battery,
      start_range:                       data.start_range,
      start_odometer:                    data.start_odometer,
      miles_since_last_charge:           data.miles_since_last_charge,
      energy_used_since_last_charge_kwh: data.energy_used_since_last_charge_kwh,
      charger_power:                     data.charger_power != null ? Math.round(data.charger_power) : null,
      status:                            "active",
    })
    .select("id")
    .single();
  if (error) { logErr("insertChargingSession", error.message, error); return null; }
  return (row as { id: number } | null)?.id ?? null;
}

export async function updateChargingSessionPower(id: number, chargerPowerKw: number): Promise<void> {
  const client = db();
  if (!client) return;
  const { error } = await client
    .from("fleet_charging_sessions")
    .update({ charger_power: Math.round(chargerPowerKw) })
    .eq("id", id);
  if (error) logErr("updateChargingSessionPower", error.message, error);
}

// Last completed/stopped charge session's end_odometer for a VIN, excluding a specific session id.
// Used at charge close time to compute miles_since_last_charge from DB rather than in-memory state.
export async function getLastCompletedChargeEndOdometerForVin(
  vin: string,
  excludeId?: number,
): Promise<number | null> {
  const client = db();
  if (!client) return null;
  let query = client
    .from("fleet_charging_sessions")
    .select("end_odometer")
    .eq("vin", vin)
    .in("status", ["completed", "stopped"])
    .not("end_odometer", "is", null);
  if (excludeId !== undefined) query = query.neq("id", excludeId);
  const { data, error } = await query
    .order("end_time", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) { logErr("getLastCompletedChargeEndOdometerForVin", error.message, error); return null; }
  return (data as { end_odometer: number } | null)?.end_odometer ?? null;
}

export async function completeChargingSession(
  id: number,
  data: {
    end_time: Date;
    end_battery: number;
    end_range: number;
    start_odometer: number;
    end_odometer: number;
    miles_since_last_charge: number;
    energy_added_kwh: number;
    charge_rate_avg: number | null;
    charge_rate_max: number | null;
    charger_power: number;
    duration_minutes: number;
    final_state: string;
  },
): Promise<void> {
  const client = db();
  if (!client) return;
  const { error } = await client
    .from("fleet_charging_sessions")
    .update({
      end_time:                data.end_time.toISOString(),
      end_battery:             data.end_battery,
      end_range:               data.end_range,
      start_odometer:          data.start_odometer,
      end_odometer:            data.end_odometer,
      miles_since_last_charge: data.miles_since_last_charge,
      energy_added_kwh:        data.energy_added_kwh,
      charge_rate_avg:         data.charge_rate_avg,
      charge_rate_max:         data.charge_rate_max,
      charger_power:           data.charger_power > 0 ? Math.round(data.charger_power) : 0,
      duration_minutes:        data.duration_minutes,
      status:                  data.final_state.includes("Complete") ? "completed" : "stopped",
    })
    .eq("id", id);
  if (error) logErr("completeChargingSession", error.message, error);
}

// ── Daily summary (upsert with increments when trips/charges complete) ─────────

export async function upsertDailySummary(
  vin: string,
  date: string, // YYYY-MM-DD
  delta: {
    miles?: number;
    energy_used_kwh?: number;
    energy_added_kwh?: number;
    trips?: number;
    charges?: number;
  },
): Promise<void> {
  const client = db();
  if (!client) return;

  // Read existing row for the day then upsert with accumulated totals
  const { data: existing } = await client
    .from("fleet_daily_summary")
    .select("*")
    .eq("vin", vin)
    .eq("date", date)
    .maybeSingle();

  const ex = (existing ?? {}) as Record<string, number>;
  const totalMiles      = (ex.total_miles ?? 0)            + (delta.miles           ?? 0);
  const totalUsed       = (ex.total_energy_used_kwh ?? 0)  + (delta.energy_used_kwh ?? 0);
  const totalAdded      = (ex.total_energy_added_kwh ?? 0) + (delta.energy_added_kwh ?? 0);
  const numTrips        = (ex.num_trips ?? 0)              + (delta.trips            ?? 0);
  const numCharges      = (ex.num_charges ?? 0)            + (delta.charges          ?? 0);
  const avgEfficiency   = totalMiles > 0 ? totalUsed / totalMiles : null;

  const { error } = await client
    .from("fleet_daily_summary")
    .upsert(
      {
        vin,
        date,
        total_miles:            totalMiles,
        total_energy_used_kwh:  totalUsed,
        total_energy_added_kwh: totalAdded,
        num_trips:              numTrips,
        num_charges:            numCharges,
        avg_efficiency:         avgEfficiency,
      },
      { onConflict: "vin,date" },
    );
  if (error) logErr("upsertDailySummary", error.message, error);
}

// ── Session restore (called on vehicle reconnect after server restart) ─────────

export async function getLastKnownStateForVin(vin: string): Promise<{
  gear: string | null;
  detailed_charge_state: string | null;
  odometer_mi: number | null;
  soc_pct: number | null;
  battery_level_pct: number | null;
  est_battery_range_mi: number | null;
  energy_remaining_kwh: number | null;
  software_version: string | null;
  updated_at: string | null;
} | null> {
  const client = db();
  if (!client) return null;
  const { data, error } = await client
    .from("fleet_telemetry_state")
    .select("gear, detailed_charge_state, odometer_mi, soc_pct, battery_level_pct, est_battery_range_mi, energy_remaining_kwh, software_version, updated_at")
    .eq("vin", vin)
    .maybeSingle();
  if (error) logErr("getLastKnownStateForVin", error.message, error);
  return data as any ?? null;
}

// Reopen a recently completed trip — used when server crashed and old code prematurely
// closed an in-progress trip. Clears end fields and sets status back to 'active'.
export async function reopenRecentTripForVin(vin: string): Promise<{
  id: number; start_time: string; start_battery: number; start_odometer: number;
  start_energy_kwh: number | null; last_seen_at: string | null;
} | null> {
  const client = db();
  if (!client) return null;
  const cutoff = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  const { data, error } = await client
    .from("fleet_trips")
    .select("id, start_time, start_battery, start_odometer, start_energy_kwh, last_seen_at")
    .eq("vin", vin)
    .eq("status", "completed")
    .gte("last_seen_at", cutoff)
    .order("start_time", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) { logErr("reopenRecentTripForVin", error.message, error); return null; }
  if (!data) return null;
  const row = data as { id: number; start_time: string; start_battery: number; start_odometer: number; start_energy_kwh: number | null; last_seen_at: string | null };
  const { error: updErr } = await client
    .from("fleet_trips")
    .update({
      status:          "active",
      end_time:        null,
      end_battery:     null,
      end_odometer:    null,
      distance_miles:  null,
      energy_used_kwh: null,
      avg_speed:       null,
      max_speed:       null,
      end_location:    null,
      last_seen_at:    new Date().toISOString(),
    })
    .eq("id", row.id);
  if (updErr) { logErr("reopenRecentTripForVin(update)", updErr.message, updErr); return null; }
  return row;
}

// Last completed trip's end_odometer — used to seed start_odometer of a RESUMED trip
// so mid-drive reconnect gaps don't create odometer discontinuities.
export async function getLastTripEndOdometerForVin(vin: string): Promise<number | null> {
  const client = db();
  if (!client) return null;
  const { data, error } = await client
    .from("fleet_trips")
    .select("end_odometer")
    .eq("vin", vin)
    .eq("status", "completed")
    .not("end_odometer", "is", null)
    .order("end_time", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) { logErr("getLastTripEndOdometerForVin", error.message, error); return null; }
  return (data as { end_odometer: number } | null)?.end_odometer ?? null;
}

// Reopen a recently completed/stopped charging session — crash recovery equivalent.
export async function reopenRecentChargingSessionForVin(vin: string): Promise<{
  id: number; start_time: string; start_battery: number; start_range: number;
  start_odometer: number; miles_since_last_charge: number;
} | null> {
  const client = db();
  if (!client) return null;
  const cutoff = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  const { data, error } = await client
    .from("fleet_charging_sessions")
    .select("id, start_time, start_battery, start_range, start_odometer, miles_since_last_charge")
    .eq("vin", vin)
    .eq("status", "stopped")
    .gte("end_time", cutoff)
    .order("start_time", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) { logErr("reopenRecentChargingSessionForVin", error.message, error); return null; }
  if (!data) return null;
  const row = data as { id: number; start_time: string; start_battery: number; start_range: number; start_odometer: number; miles_since_last_charge: number };
  const { error: updErr } = await client
    .from("fleet_charging_sessions")
    .update({
      status:           "active",
      end_time:         null,
      end_battery:      null,
      end_range:        null,
      end_odometer:     null,
      energy_added_kwh: null,
      charge_rate_avg:  null,
      charge_rate_max:  null,
      charger_power:    null,
      duration_minutes: null,
    })
    .eq("id", row.id);
  if (updErr) { logErr("reopenRecentChargingSessionForVin(update)", updErr.message, updErr); return null; }
  return row;
}

export async function getActiveTripForVin(vin: string): Promise<{
  id: number; start_time: string; start_battery: number; start_odometer: number;
  start_energy_kwh: number | null; last_seen_at: string | null;
} | null> {
  const client = db();
  if (!client) return null;
  const { data, error } = await client
    .from("fleet_trips")
    .select("id, start_time, start_battery, start_odometer, start_energy_kwh, last_seen_at")
    .eq("vin", vin)
    .eq("status", "active")
    .order("start_time", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) logErr("getActiveTripForVin", error.message, error);
  return data as any ?? null;
}

export async function getActiveChargingSessionForVin(vin: string): Promise<{
  id: number; start_time: string; start_battery: number; start_range: number;
  start_odometer: number; miles_since_last_charge: number;
} | null> {
  const client = db();
  if (!client) return null;
  const { data, error } = await client
    .from("fleet_charging_sessions")
    .select("id, start_time, start_battery, start_range, start_odometer, miles_since_last_charge")
    .eq("vin", vin)
    .eq("status", "active")
    .order("start_time", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) logErr("getActiveChargingSessionForVin", error.message, error);
  return data as any ?? null;
}

// ── Software version tracking ─────────────────────────────────────────────

export async function getDailySignalCount(vin: string): Promise<number> {
  const client = db();
  if (!client) return 0;
  const today = new Date().toISOString().slice(0, 10);
  const { data } = await client
    .from("fleet_api_tracking")
    .select("signal_count")
    .eq("vin", vin)
    .eq("date", today)
    .maybeSingle();
  return (data as { signal_count: number } | null)?.signal_count ?? 0;
}

export async function upsertDailySignalCount(vin: string, count: number): Promise<void> {
  const client = db();
  if (!client) return;
  const today = new Date().toISOString().slice(0, 10);
  const { data: existing } = await client
    .from("fleet_api_tracking")
    .select("signal_count")
    .eq("vin", vin)
    .eq("date", today)
    .maybeSingle();
  const prev = (existing as { signal_count: number } | null)?.signal_count ?? 0;
  const { error } = await client
    .from("fleet_api_tracking")
    .upsert(
      { vin, date: today, signal_count: prev + count, updated_at: new Date().toISOString() },
      { onConflict: "vin,date" },
    );
  if (error) logErr("upsertDailySignalCount", error.message, error);
}

// Ensures the current version exists in software_versions. If not, looks up the
// most recent existing row for this VIN and inserts with that as the previous version.
export async function ensureSoftwareVersionRecorded(vin: string, currentVersion: string): Promise<void> {
  const client = db();
  if (!client) return;

  const { data: existing } = await client
    .from("software_versions")
    .select("id")
    .eq("vin", vin)
    .eq("current_version", currentVersion)
    .maybeSingle();

  if (existing) return; // already recorded

  const { data: latest } = await client
    .from("software_versions")
    .select("current_version")
    .eq("vin", vin)
    .order("update_time", { ascending: false })
    .limit(1)
    .maybeSingle();

  const previousVersion = (latest as { current_version: string } | null)?.current_version ?? null;

  const { error } = await client.from("software_versions").insert({
    vin,
    update_time:      new Date().toISOString(),
    current_version:  currentVersion,
    previous_version: previousVersion,
  });
  if (error) logErr("ensureSoftwareVersionRecorded", error.message, error);
}

export async function recordSoftwareVersionChange(
  vin: string,
  currentVersion: string,
  previousVersion: string | undefined,
): Promise<void> {
  const client = db();
  if (!client) return;
  const { error } = await client.from("software_versions").upsert({
    vin,
    update_time:      new Date().toISOString(),
    current_version:  currentVersion,
    previous_version: previousVersion ?? null,
  }, { onConflict: "vin,current_version", ignoreDuplicates: true });
  if (error) logErr("recordSoftwareVersionChange", error.message, error);
}

// ── OAuth token persistence ────────────────────────────────────────────────────
// Keeps the Tesla user token in Supabase so it survives Render restarts.
// A single "default" row holds the current token for this single-user server.

export async function saveAuthToken(userId: string, tokenSet: TokenSet): Promise<void> {
  const client = db();
  if (!client) return;
  const { error } = await client.from("app_auth_tokens").upsert({
    id:            "default",
    user_id:       userId,
    access_token:  tokenSet.accessToken,
    refresh_token: tokenSet.refreshToken,
    expires_at:    tokenSet.expiresAt,
    scope:         tokenSet.scope,
    updated_at:    new Date().toISOString(),
  }, { onConflict: "id" });
  if (error) logErr("saveAuthToken", error.message, error);
  else console.log("[DB] Auth token persisted to Supabase");
}

export async function loadAuthToken(): Promise<{ userId: string; tokenSet: TokenSet } | null> {
  const client = db();
  if (!client) return null;
  const { data, error } = await client
    .from("app_auth_tokens")
    .select("*")
    .eq("id", "default")
    .single();
  if (error || !data) return null;
  return {
    userId: data.user_id as string,
    tokenSet: {
      accessToken:  data.access_token  as string,
      refreshToken: data.refresh_token as string,
      expiresAt:    data.expires_at    as number,
      scope:        (data.scope as string) ?? "",
    },
  };
}
