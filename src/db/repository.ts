/**
 * All Supabase write operations — column names match the fleet_ table schema exactly.
 */

import { getSupabase } from "./supabase";
import { TelemetryRecord } from "../telemetry/store";

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

  const g = <T>(key: string) => (rawState[key] as T) ?? null;

  const { error } = await client
    .from("fleet_telemetry_state")
    .upsert(
      {
        vin,
        updated_at: new Date().toISOString(),
        gear:                       g<string>("Gear"),
        vehicle_speed_mph:          g<number>("VehicleSpeed"),
        odometer_mi:                g<number>("Odometer"),
        miles_since_reset:          g<number>("MilesSinceReset"),
        soc_pct:                    g<number>("Soc"),
        battery_level_pct:          g<number>("BatteryLevel"),
        pack_voltage_v:             g<number>("PackVoltage"),
        pack_current_a:             g<number>("PackCurrent"),
        energy_remaining_kwh:       g<number>("EnergyRemaining"),
        rated_range_mi:             g<number>("RatedRange"),
        est_battery_range_mi:       g<number>("EstBatteryRange"),
        ideal_battery_range_mi:     g<number>("IdealBatteryRange"),
        lifetime_energy_used_kwh:   g<number>("LifetimeEnergyUsed"),
        lifetime_energy_regen_kwh:  g<number>("LifetimeEnergyGainedRegen"),
        detailed_charge_state:      g<string>("DetailedChargeState"),
        charge_amps:                g<number>("ChargeAmps"),
        charger_voltage_v:          g<number>("ChargerVoltage"),
        ac_charging_power_kw:       g<number>("ACChargingPower"),
        dc_charging_power_kw:       g<number>("DCChargingPower"),
        charge_limit_soc_pct:       g<number>("ChargeLimitSoc"),
        time_to_full_charge_h:      g<number>("TimeToFullCharge"),
        fast_charger_present:       g<boolean>("FastChargerPresent"),
        charge_port_door_open:      g<boolean>("ChargePortDoorOpen"),
        inside_temp_c:              g<number>("InsideTemp"),
        outside_temp_c:             g<number>("OutsideTemp"),
        locked:                     g<boolean>("Locked"),
        sentry_mode:                g<string>("SentryMode"),
        vehicle_name:               g<string>("VehicleName"),
        software_version:           g<string>("Version"),
        raw_state: rawState,
      },
      { onConflict: "vin" },
    );
  if (error) logErr("upsertTelemetryState", error.message, error);
}

// ── Telemetry data (append-only log, opt-in via ENABLE_TELEMETRY_EVENTS=true) ──

export async function insertTelemetryData(record: TelemetryRecord, force = false): Promise<void> {
  if (!force && process.env.ENABLE_TELEMETRY_EVENTS !== "true") return;
  const client = db();
  if (!client) return;

  const f   = record.fields;
  const loc = f["Location"] as { latitude?: number; longitude?: number } | undefined;
  const num = (k: string) => (f[k] as number) ?? null;
  const rnd = (k: string) => f[k] != null ? Math.round(f[k] as number) : null;
  const bol = (k: string) => (f[k] as boolean) ?? null;
  const str = (k: string) => (f[k] as string)  ?? null;
  const dcKw = num("DCChargingPower");
  const acKw = num("ACChargingPower");

  const { error } = await client.from("fleet_telemetry_data").insert({
    vin:                    record.vin,
    recorded_at:            new Date(record.createdAt).toISOString(),
    // ── Location ───────────────────────────────────────────────────────────
    latitude:               loc?.latitude  ?? null,
    longitude:              loc?.longitude ?? null,
    gps_heading:            num("GpsHeading"),
    // ── Motion ─────────────────────────────────────────────────────────────
    speed:                  num("VehicleSpeed"),
    odometer:               num("Odometer"),
    miles_since_reset:      num("MilesSinceReset"),
    shift_state:            str("Gear"),
    // ── Battery ────────────────────────────────────────────────────────────
    battery_level:          rnd("BatteryLevel"),
    usable_battery_level:   num("Soc"),
    pack_voltage_v:         num("PackVoltage"),
    pack_current_a:         num("PackCurrent"),
    energy_remaining_kwh:   num("EnergyRemaining"),
    est_battery_range:      num("EstBatteryRange"),
    rated_range_mi:         num("RatedRange"),
    ideal_range_mi:         num("IdealBatteryRange"),
    // ── Charging ───────────────────────────────────────────────────────────
    charge_state:           str("DetailedChargeState"),
    charge_amps:            num("ChargeAmps"),
    charger_voltage_v:      num("ChargerVoltage"),
    ac_charging_power_kw:   acKw,
    dc_charging_power_kw:   dcKw,
    charge_rate:            acKw ?? dcKw,
    charger_power:          dcKw != null ? Math.round(dcKw) : (acKw != null ? Math.round(acKw) : null),
    charge_limit_soc:       rnd("ChargeLimitSoc"),
    time_to_full_charge_h:  num("TimeToFullCharge"),
    fast_charger_present:   bol("FastChargerPresent"),
    charge_port_door_open:  bol("ChargePortDoorOpen"),
    // ── Climate ────────────────────────────────────────────────────────────
    inside_temp_c:          num("InsideTemp"),
    outside_temp_c:         num("OutsideTemp"),
    // ── Security / misc ────────────────────────────────────────────────────
    locked:                 bol("Locked"),
    sentry_mode:            str("SentryMode"),
    software_version:       str("Version"),
    // ── Catch-all ──────────────────────────────────────────────────────────
    power:                  null,
    raw_data:               f,
  });
  if (error) logErr("insertTelemetryData", error.message, error);
}

// ── Trips ─────────────────────────────────────────────────────────────────────

export async function insertTrip(data: {
  vin: string;
  start_time: Date;
  start_battery: number;
  start_odometer: number;
  start_location?: { latitude: number; longitude: number } | null;
}): Promise<number | null> {
  const client = db();
  if (!client) return null;
  const { data: row, error } = await client
    .from("fleet_trips")
    .insert({
      vin:            data.vin,
      start_time:     data.start_time.toISOString(),
      start_battery:  data.start_battery,
      start_odometer: data.start_odometer,
      start_location: data.start_location ?? null,
      status:         "active",
      last_seen_at:   data.start_time.toISOString(),
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
      status:                            "active",
    })
    .select("id")
    .single();
  if (error) { logErr("insertChargingSession", error.message, error); return null; }
  return (row as { id: number } | null)?.id ?? null;
}

export async function completeChargingSession(
  id: number,
  data: {
    end_time: Date;
    end_battery: number;
    end_range: number;
    end_odometer: number;
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
      end_time:         data.end_time.toISOString(),
      end_battery:      data.end_battery,
      end_range:        data.end_range,
      end_odometer:     data.end_odometer,
      energy_added_kwh: data.energy_added_kwh,
      charge_rate_avg:  data.charge_rate_avg,
      charge_rate_max:  data.charge_rate_max,
      charger_power:    data.charger_power > 0 ? Math.round(data.charger_power) : 0,
      duration_minutes: data.duration_minutes,
      status:           data.final_state.includes("Complete") ? "completed" : "stopped",
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

export async function getActiveTripForVin(vin: string): Promise<{
  id: number; start_time: string; start_battery: number; start_odometer: number;
} | null> {
  const client = db();
  if (!client) return null;
  const { data, error } = await client
    .from("fleet_trips")
    .select("id, start_time, start_battery, start_odometer")
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
