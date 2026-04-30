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

export async function insertTelemetryData(record: TelemetryRecord): Promise<void> {
  if (process.env.ENABLE_TELEMETRY_EVENTS !== "true") return;
  const client = db();
  if (!client) return;

  const f = record.fields;
  const loc = f["Location"] as { latitude?: number; longitude?: number } | undefined;

  // charger_power: prefer DC (Supercharger) then AC
  const chargerKw = (f["DCChargingPower"] as number) ?? (f["ACChargingPower"] as number) ?? null;

  const { error } = await client.from("fleet_telemetry_data").insert({
    vin:                  record.vin,
    recorded_at:          new Date(record.createdAt).toISOString(),
    latitude:             loc?.latitude  ?? null,
    longitude:            loc?.longitude ?? null,
    battery_level:        f["BatteryLevel"]       != null ? Math.round(f["BatteryLevel"] as number) : null,
    usable_battery_level: f["Soc"]                ?? null,
    est_battery_range:    f["EstBatteryRange"]     ?? null,
    charge_state:         f["DetailedChargeState"] ?? null,
    charge_rate:          f["ACChargingPower"]     ?? f["DCChargingPower"] ?? null,
    charge_limit_soc:     f["ChargeLimitSoc"]      != null ? Math.round(f["ChargeLimitSoc"] as number) : null,
    charge_port_door_open: f["ChargePortDoorOpen"] ?? null,
    speed:                f["VehicleSpeed"]        ?? null,
    odometer:             f["Odometer"]            ?? null,
    shift_state:          f["Gear"]                ?? null,
    power:                null, // drive power not directly available without Location scope
    charger_power:        chargerKw != null ? Math.round(chargerKw) : null,
    raw_data:             f,
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
}): Promise<number | null> {
  const client = db();
  if (!client) return null;
  const { data: row, error } = await client
    .from("fleet_charging_sessions")
    .insert({
      vin:                     data.vin,
      start_time:              data.start_time.toISOString(),
      start_battery:           data.start_battery,
      start_range:             data.start_range,
      start_odometer:          data.start_odometer,
      miles_since_last_charge: data.miles_since_last_charge,
      status:                  "active",
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
