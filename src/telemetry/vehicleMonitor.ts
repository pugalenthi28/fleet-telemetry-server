/**
 * Vehicle monitor — detects trip and charging state transitions from streaming
 * telemetry, logs them, and persists to Supabase.
 *
 * All state is computed purely from the incoming stream — no API polling.
 */

import { TelemetryRecord } from "./store";
import {
  insertTrip,
  completeTrip,
  updateTripLastSeen,
  insertChargingSession,
  completeChargingSession,
  upsertDailySummary,
} from "../db/repository";

interface TripState {
  dbId: number | null;
  startTime: Date;
  startBattery: number;
  startOdometer: number;
  startEnergyKwh: number;
  startLocation: { latitude: number; longitude: number } | null;
  maxSpeedMph: number;
  speedSum: number;
  speedCount: number;
  lastSeenAt: Date;
}

interface ChargeSessionState {
  dbId: number | null;
  startTime: Date;
  startBattery: number;
  startRange: number;
  startOdometer: number;
  milesSinceLastCharge: number;
  peakPowerKw: number;
  powerSum: number;
  powerCount: number;
}

interface VehicleMonitorState {
  // Latest field values
  gear?: string;
  detailedChargeState?: string;
  odometer?: number;
  soc?: number;
  batteryLevel?: number;
  estBatteryRange?: number;
  energyRemaining?: number;
  vehicleSpeed?: number;
  location?: { latitude: number; longitude: number } | null;

  // Active session state
  trip?: TripState;
  charge?: ChargeSessionState;

  // Cross-session tracking
  lastChargeEndOdometer?: number; // to compute miles_since_last_charge
  lastProgressLogAt?: number;
}

const DRIVING_GEARS = new Set(["ShiftStateD", "ShiftStateR", "ShiftStateN"]);
const PARKED_GEARS  = new Set(["ShiftStateP", "ShiftStateSNA"]);

const CHARGING_STATES = new Set([
  "DetailedChargeStateCharging",
  "DetailedChargeStateStarting",
]);
const NOT_CHARGING_STATES = new Set([
  "DetailedChargeStateDisconnected",
  "DetailedChargeStateComplete",
  "DetailedChargeStateStopped",
  "DetailedChargeStateNoPower",
]);

const PROGRESS_INTERVAL_MS = 5 * 60 * 1000;
// Update last_seen_at on trips every 30 s while driving
const LAST_SEEN_UPDATE_MS  = 30 * 1000;

const perVin = new Map<string, VehicleMonitorState>();

function getVinState(vin: string): VehicleMonitorState {
  if (!perVin.has(vin)) perVin.set(vin, {});
  return perVin.get(vin)!;
}

function fmtTime(d: Date): string {
  return d.toLocaleTimeString("en-US", {
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
}

function elapsed(from: Date, to: Date = new Date()): string {
  const secs = Math.round((to.getTime() - from.getTime()) / 1000);
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function n(v: unknown, d = 1): string {
  return typeof v === "number" ? v.toFixed(d) : "?";
}

function toDateStr(d: Date): string {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

export function processVehicleEvent(record: TelemetryRecord): void {
  const { vin, fields, createdAt } = record;
  const st  = getVinState(vin);
  const now = new Date(createdAt);

  // ── Pull all relevant fields from this delta ────────────────────────────
  const newGear         = fields["Gear"]                as string  | undefined;
  const newChargeState  = fields["DetailedChargeState"] as string  | undefined;
  const newOdometer     = fields["Odometer"]            as number  | undefined;
  const newSoc          = fields["Soc"]                 as number  | undefined;
  const newBattery      = fields["BatteryLevel"]        as number  | undefined;
  const newEstRange     = fields["EstBatteryRange"]     as number  | undefined;
  const newEnergy       = fields["EnergyRemaining"]     as number  | undefined;
  const newSpeed        = fields["VehicleSpeed"]        as number  | undefined;
  const newAcPower      = fields["ACChargingPower"]     as number  | undefined;
  const newDcPower      = fields["DCChargingPower"]     as number  | undefined;
  const newLocation     = fields["Location"]            as { latitude: number; longitude: number } | undefined;

  // ── Update running snapshot ─────────────────────────────────────────────
  if (newGear        !== undefined) st.gear            = newGear;
  if (newChargeState !== undefined) st.detailedChargeState = newChargeState;
  if (newOdometer    !== undefined) st.odometer        = newOdometer;
  if (newSoc         !== undefined) st.soc             = newSoc;
  if (newBattery     !== undefined) st.batteryLevel    = newBattery;
  if (newEstRange    !== undefined) st.estBatteryRange = newEstRange;
  if (newEnergy      !== undefined) st.energyRemaining = newEnergy;
  if (newSpeed       !== undefined) st.vehicleSpeed    = newSpeed;
  if (newLocation    !== undefined) st.location        = newLocation;

  // ── Update active trip accumulators ────────────────────────────────────
  if (st.trip) {
    if (newSpeed !== undefined) {
      if (newSpeed > st.trip.maxSpeedMph) st.trip.maxSpeedMph = newSpeed;
      if (newSpeed > 0) { st.trip.speedSum += newSpeed; st.trip.speedCount++; }
    }
    // Throttled last_seen_at update to DB
    if (st.trip.dbId !== null &&
        now.getTime() - st.trip.lastSeenAt.getTime() >= LAST_SEEN_UPDATE_MS) {
      st.trip.lastSeenAt = now;
      updateTripLastSeen(st.trip.dbId, now);
    }
  }

  // ── Update active charge accumulators ───────────────────────────────────
  if (st.charge) {
    const power = newDcPower ?? newAcPower;
    if (power !== undefined && power > 0) {
      if (power > st.charge.peakPowerKw) st.charge.peakPowerKw = power;
      st.charge.powerSum   += power;
      st.charge.powerCount += 1;
    }
  }

  // ── Gear / Trip detection ───────────────────────────────────────────────
  if (newGear && newGear !== (st.trip ? "driving" : st.gear)) {
    const prevGear   = st.gear;
    const nowDriving = DRIVING_GEARS.has(newGear);
    const nowParked  = PARKED_GEARS.has(newGear);
    const wasDriving = prevGear ? DRIVING_GEARS.has(prevGear) : false;
    const wasParked  = !prevGear || PARKED_GEARS.has(prevGear);

    if (nowDriving && (wasParked || !st.trip)) {
      // ── Trip start ────────────────────────────────────────────────────
      const tripState: TripState = {
        dbId:           null,
        startTime:      now,
        startBattery:   Math.round(st.batteryLevel ?? st.soc ?? 0),
        startOdometer:  st.odometer ?? 0,
        startEnergyKwh: st.energyRemaining ?? 0,
        startLocation:  st.location ?? null,
        maxSpeedMph:    0,
        speedSum:       0,
        speedCount:     0,
        lastSeenAt:     now,
      };
      st.trip = tripState;

      insertTrip({
        vin,
        start_time:     now,
        start_battery:  tripState.startBattery,
        start_odometer: tripState.startOdometer,
        start_location: tripState.startLocation,
      }).then((id) => { if (tripState === st.trip) tripState.dbId = id; });

      console.log(
        `[Monitor] TRIP STARTED   vin=${vin}  gear=${newGear}` +
        `  odometer=${n(st.odometer)}mi  soc=${n(st.soc)}%  time=${fmtTime(now)}`,
      );

    } else if (nowParked && st.trip) {
      // ── Trip end ──────────────────────────────────────────────────────
      const trip          = st.trip;
      const distMiles     = (st.odometer ?? trip.startOdometer) - trip.startOdometer;
      const energyUsed    = trip.startEnergyKwh - (st.energyRemaining ?? trip.startEnergyKwh);
      const avgSpeed      = trip.speedCount > 0 ? trip.speedSum / trip.speedCount : 0;
      const endBattery    = Math.round(st.batteryLevel ?? st.soc ?? 0);

      console.log(
        `[Monitor] TRIP ENDED     vin=${vin}  gear=${newGear}` +
        `  distance=${distMiles.toFixed(2)}mi  energy_used=${energyUsed.toFixed(2)}kWh` +
        `  duration=${elapsed(trip.startTime, now)}  avg_speed=${avgSpeed.toFixed(1)}mph` +
        `  time=${fmtTime(now)}`,
      );

      if (trip.dbId !== null) {
        completeTrip(trip.dbId, {
          end_time:        now,
          end_battery:     endBattery,
          end_odometer:    st.odometer ?? trip.startOdometer,
          distance_miles:  distMiles,
          energy_used_kwh: energyUsed,
          avg_speed:       avgSpeed,
          max_speed:       trip.maxSpeedMph,
          end_location:    st.location ?? null,
        });

        // Update daily summary
        upsertDailySummary(vin, toDateStr(trip.startTime), {
          miles:           distMiles,
          energy_used_kwh: energyUsed,
          trips:           1,
        });
      }
      st.trip = undefined;

    } else if (nowDriving && wasDriving && st.trip) {
      console.log(
        `[Monitor] GEAR CHANGE    vin=${vin}  ${prevGear} -> ${newGear}  time=${fmtTime(now)}`,
      );
    }
  }

  // ── Charge session detection ────────────────────────────────────────────
  if (newChargeState && newChargeState !== st.detailedChargeState) {
    const prevState   = st.detailedChargeState;
    const nowCharging = CHARGING_STATES.has(newChargeState);
    const nowDone     = NOT_CHARGING_STATES.has(newChargeState);
    const wasCharging = prevState ? CHARGING_STATES.has(prevState) : false;

    if (nowCharging && !wasCharging) {
      // ── Charge start ──────────────────────────────────────────────────
      const milesSinceCharge = st.lastChargeEndOdometer !== undefined && st.odometer !== undefined
        ? st.odometer - st.lastChargeEndOdometer
        : 0;

      const powerKw = newDcPower ?? newAcPower ?? 0;
      const chargeState: ChargeSessionState = {
        dbId:                 null,
        startTime:            now,
        startBattery:         Math.round(st.batteryLevel ?? st.soc ?? 0),
        startRange:           st.estBatteryRange ?? 0,
        startOdometer:        st.odometer ?? 0,
        milesSinceLastCharge: milesSinceCharge,
        peakPowerKw:          powerKw,
        powerSum:             powerKw > 0 ? powerKw : 0,
        powerCount:           powerKw > 0 ? 1 : 0,
      };
      st.charge = chargeState;

      insertChargingSession({
        vin,
        start_time:              now,
        start_battery:           chargeState.startBattery,
        start_range:             chargeState.startRange,
        start_odometer:          chargeState.startOdometer,
        miles_since_last_charge: milesSinceCharge,
      }).then((id) => { if (chargeState === st.charge) chargeState.dbId = id; });

      console.log(
        `[Monitor] CHARGE STARTED vin=${vin}  state=${newChargeState}` +
        `  soc=${n(st.soc)}%  range=${n(st.estBatteryRange)}mi` +
        (powerKw > 0 ? `  power=${powerKw.toFixed(1)}kW` : "") +
        `  time=${fmtTime(now)}`,
      );

    } else if (nowDone && wasCharging && st.charge) {
      // ── Charge end ────────────────────────────────────────────────────
      const ch             = st.charge;
      const endBattery     = Math.round(st.batteryLevel ?? st.soc ?? 0);
      const endRange       = st.estBatteryRange ?? 0;
      const chargeRateAvg  = ch.powerCount > 0 ? ch.powerSum / ch.powerCount : 0;
      const durMins        = (now.getTime() - ch.startTime.getTime()) / 60_000;

      console.log(
        `[Monitor] CHARGE ENDED   vin=${vin}  state=${newChargeState}` +
        `  soc_gained=+${(endBattery - ch.startBattery).toFixed(0)}%` +
        `  peak=${ch.peakPowerKw.toFixed(1)}kW  avg=${chargeRateAvg.toFixed(1)}kW` +
        `  duration=${elapsed(ch.startTime, now)}  soc=${n(st.soc)}%` +
        `  time=${fmtTime(now)}`,
      );

      if (ch.dbId !== null) {
        // Energy added = difference in kWh remaining (EnergyRemaining went up while charging)
        const energyKwh = (st.energyRemaining ?? 0) - (ch.startRange); // reuse startRange as proxy if no EnergyRemaining

        completeChargingSession(ch.dbId, {
          end_time:         now,
          end_battery:      endBattery,
          end_range:        endRange,
          end_odometer:     st.odometer ?? ch.startOdometer,
          energy_added_kwh: energyKwh > 0 ? energyKwh : 0,
          charge_rate_avg:  chargeRateAvg,
          charge_rate_max:  ch.peakPowerKw,
          charger_power:    ch.peakPowerKw,
          duration_minutes: durMins,
          final_state:      newChargeState,
        });

        upsertDailySummary(vin, toDateStr(ch.startTime), {
          energy_added_kwh: energyKwh > 0 ? energyKwh : 0,
          charges:          1,
        });
      }

      st.lastChargeEndOdometer = st.odometer;
      st.charge = undefined;

    } else {
      console.log(
        `[Monitor] CHARGE STATE   vin=${vin}  ${prevState ?? "?"} -> ${newChargeState}  time=${fmtTime(now)}`,
      );
    }
  }

  // ── Periodic progress logs ──────────────────────────────────────────────
  const now_ms      = now.getTime();
  const dueProgress = !st.lastProgressLogAt ||
    now_ms - st.lastProgressLogAt >= PROGRESS_INTERVAL_MS;

  if (st.trip && dueProgress) {
    const trip    = st.trip;
    const distMi  = (st.odometer ?? trip.startOdometer) - trip.startOdometer;
    const avgSpd  = trip.speedCount > 0 ? trip.speedSum / trip.speedCount : 0;
    console.log(
      `[Monitor] TRIP PROGRESS  vin=${vin}` +
      `  distance=${distMi.toFixed(2)}mi  speed=${n(st.vehicleSpeed)}mph` +
      `  avg_speed=${avgSpd.toFixed(1)}mph  soc=${n(st.soc)}%` +
      `  duration=${elapsed(trip.startTime, now)}`,
    );
    st.lastProgressLogAt = now_ms;
  }

  if (st.charge && dueProgress) {
    const ch          = st.charge;
    const powerKw     = newDcPower ?? newAcPower;
    const avgPower    = ch.powerCount > 0 ? ch.powerSum / ch.powerCount : 0;
    console.log(
      `[Monitor] CHARGE PROGRESS vin=${vin}` +
      `  soc=${n(st.soc)}%  range=${n(st.estBatteryRange)}mi` +
      (powerKw !== undefined ? `  power=${powerKw.toFixed(1)}kW` : "") +
      `  avg_power=${avgPower.toFixed(1)}kW  peak=${ch.peakPowerKw.toFixed(1)}kW` +
      `  duration=${elapsed(ch.startTime, now)}`,
    );
    st.lastProgressLogAt = now_ms;
  }
}

export function getMonitorStats(): Record<string, {
  gear?: string;
  detailedChargeState?: string;
  odometer?: number;
  soc?: number;
  speed?: number;
  estRange?: number;
  onTrip: boolean;
  tripStartedAt?: string;
  tripDbId?: number | null;
  charging: boolean;
  chargeStartedAt?: string;
  chargeDbId?: number | null;
}> {
  const out: ReturnType<typeof getMonitorStats> = {};
  for (const [vin, st] of perVin) {
    out[vin] = {
      gear:                st.gear,
      detailedChargeState: st.detailedChargeState,
      odometer:            st.odometer,
      soc:                 st.soc,
      speed:               st.vehicleSpeed,
      estRange:            st.estBatteryRange,
      onTrip:              !!st.trip,
      tripStartedAt:       st.trip?.startTime.toISOString(),
      tripDbId:            st.trip?.dbId,
      charging:            !!st.charge,
      chargeStartedAt:     st.charge?.startTime.toISOString(),
      chargeDbId:          st.charge?.dbId,
    };
  }
  return out;
}
