/**
 * Vehicle monitor — detects trip and charging state transitions from streaming
 * telemetry, logs structured events, and persists to Supabase.
 *
 * Key design points:
 *  - prevGear / prevChargeState saved before snapshot update so transitions fire correctly
 *  - insertTrip/insertChargingSession promises stored on state so trip-end can await them
 *    even if the trip lasted less than the DB round-trip
 *  - restoreActiveSessionsFromDB() called on reconnect after server restart
 *  - handleVehicleDisconnect() called on WS close to complete orphaned active sessions
 */

import { TelemetryRecord } from "./store";
import {
  insertTrip,
  completeTrip,
  updateTripLastSeen,
  insertChargingSession,
  completeChargingSession,
  upsertDailySummary,
  getActiveTripForVin,
  getActiveChargingSessionForVin,
} from "../db/repository";

interface TripState {
  dbId: number | null;
  dbIdPromise: Promise<number | null>;
  startTime: Date;
  startBattery: number;
  startOdometer: number;
  startEnergyKwh: number;
  startLocation: { latitude: number; longitude: number } | null;
  maxSpeedMph: number;
  speedSum: number;
  speedCount: number;
  lastDbSeenAt: Date;
}

interface ChargeSessionState {
  dbId: number | null;
  dbIdPromise: Promise<number | null>;
  startTime: Date;
  startBattery: number;
  startRange: number;
  startEnergyKwh: number;
  startOdometer: number;
  milesSinceLastCharge: number;
  peakPowerKw: number;
  powerSum: number;
  powerCount: number;
}

interface VehicleMonitorState {
  gear?: string;
  detailedChargeState?: string;
  odometer?: number;
  soc?: number;
  batteryLevel?: number;
  estBatteryRange?: number;
  energyRemaining?: number;
  vehicleSpeed?: number;
  location?: { latitude: number; longitude: number } | null;
  trip?: TripState;
  charge?: ChargeSessionState;
  lastChargeEndOdometer?: number;
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

const PROGRESS_INTERVAL_MS  = 5 * 60 * 1000;
const LAST_SEEN_UPDATE_MS   = 5 * 60 * 1000;

const perVin = new Map<string, VehicleMonitorState>();

function getVinState(vin: string): VehicleMonitorState {
  if (!perVin.has(vin)) perVin.set(vin, {});
  return perVin.get(vin)!;
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
  return d.toISOString().slice(0, 10);
}

// ── Session restore (called once on vehicle reconnect) ─────────────────────────

export async function restoreActiveSessionsFromDB(vin: string): Promise<void> {
  const st = getVinState(vin);

  if (!st.trip) {
    const row = await getActiveTripForVin(vin);
    if (row) {
      const resolved = Promise.resolve<number | null>(row.id);
      st.trip = {
        dbId:           row.id,
        dbIdPromise:    resolved,
        startTime:      new Date(row.start_time),
        startBattery:   row.start_battery ?? 0,
        startOdometer:  row.start_odometer ?? 0,
        startEnergyKwh: 0,
        startLocation:  null,
        maxSpeedMph:    0,
        speedSum:       0,
        speedCount:     0,
        lastDbSeenAt:   new Date(),
      };
      console.log(`[Monitor] TRIP RESTORED    vin=${vin}  id=${row.id}  started=${row.start_time}`);
    }
  }

  if (!st.charge) {
    const row = await getActiveChargingSessionForVin(vin);
    if (row) {
      const resolved = Promise.resolve<number | null>(row.id);
      st.charge = {
        dbId:                 row.id,
        dbIdPromise:          resolved,
        startTime:            new Date(row.start_time),
        startBattery:         row.start_battery ?? 0,
        startRange:           row.start_range ?? 0,
        startEnergyKwh:       0,
        startOdometer:        row.start_odometer ?? 0,
        milesSinceLastCharge: row.miles_since_last_charge ?? 0,
        peakPowerKw:          0,
        powerSum:             0,
        powerCount:           0,
      };
      console.log(`[Monitor] CHARGE RESTORED  vin=${vin}  id=${row.id}  started=${row.start_time}`);
    }
  }
}

// ── Disconnect handler (called on WS close) ────────────────────────────────────

export async function handleVehicleDisconnect(vin: string): Promise<void> {
  const st = getVinState(vin);
  const now = new Date();

  if (st.trip) {
    const trip      = st.trip;
    const id        = trip.dbId ?? await trip.dbIdPromise;
    const distMiles = (st.odometer ?? trip.startOdometer) - trip.startOdometer;
    const energyUsed = Math.max(0, trip.startEnergyKwh - (st.energyRemaining ?? trip.startEnergyKwh));
    const avgSpeed  = trip.speedCount > 0 ? trip.speedSum / trip.speedCount : 0;

    console.log(
      `[Monitor] TRIP INTERRUPTED vin=${vin}  id=${id}` +
      `  distance=${distMiles.toFixed(2)}mi  duration=${elapsed(trip.startTime, now)}`,
    );

    if (id !== null) {
      await completeTrip(id, {
        end_time:        now,
        end_battery:     Math.round(st.batteryLevel ?? st.soc ?? 0),
        end_odometer:    st.odometer ?? trip.startOdometer,
        distance_miles:  distMiles,
        energy_used_kwh: energyUsed,
        avg_speed:       avgSpeed,
        max_speed:       trip.maxSpeedMph,
        end_location:    st.location ?? null,
      });
      if (distMiles > 0) {
        upsertDailySummary(vin, toDateStr(trip.startTime), {
          miles: distMiles, energy_used_kwh: energyUsed, trips: 1,
        });
      }
    }
    st.trip = undefined;
  }

  if (st.charge) {
    const ch       = st.charge;
    const id       = ch.dbId ?? await ch.dbIdPromise;
    const avgPower = ch.powerCount > 0 ? ch.powerSum / ch.powerCount : 0;
    const durMins  = (now.getTime() - ch.startTime.getTime()) / 60_000;
    const endBattery = Math.round(st.batteryLevel ?? st.soc ?? 0);
    const energyAdded = Math.max(0, (st.energyRemaining ?? 0) - ch.startEnergyKwh);

    console.log(
      `[Monitor] CHARGE INTERRUPTED vin=${vin}  id=${id}` +
      `  duration=${elapsed(ch.startTime, now)}`,
    );

    if (id !== null) {
      await completeChargingSession(id, {
        end_time:         now,
        end_battery:      endBattery,
        end_range:        st.estBatteryRange ?? 0,
        end_odometer:     st.odometer ?? ch.startOdometer,
        energy_added_kwh: energyAdded,
        charge_rate_avg:  avgPower,
        charge_rate_max:  ch.peakPowerKw,
        charger_power:    ch.peakPowerKw,
        duration_minutes: durMins,
        final_state:      "DetailedChargeStateStopped",
      });
    }
    st.charge = undefined;
  }
}

// ── Main event processor ───────────────────────────────────────────────────────

export function processVehicleEvent(record: TelemetryRecord): void {
  const { vin, fields, createdAt } = record;
  const st  = getVinState(vin);
  const now = new Date(createdAt);

  const newGear        = fields["Gear"]                as string | undefined;
  const newChargeState = fields["DetailedChargeState"] as string | undefined;
  const newOdometer    = fields["Odometer"]            as number | undefined;
  const newSoc         = fields["Soc"]                 as number | undefined;
  const newBattery     = fields["BatteryLevel"]        as number | undefined;
  const newEstRange    = fields["EstBatteryRange"]     as number | undefined;
  const newEnergy      = fields["EnergyRemaining"]     as number | undefined;
  const newSpeed       = fields["VehicleSpeed"]        as number | undefined;
  const newAcPower     = fields["ACChargingPower"]     as number | undefined;
  const newDcPower     = fields["DCChargingPower"]     as number | undefined;
  const newLocation    = fields["Location"]            as { latitude: number; longitude: number } | undefined;

  // Save prev BEFORE updating snapshot so transitions can compare
  const prevGear        = st.gear;
  const prevChargeState = st.detailedChargeState;

  if (newGear        !== undefined) st.gear             = newGear;
  if (newChargeState !== undefined) st.detailedChargeState = newChargeState;
  if (newOdometer    !== undefined) st.odometer         = newOdometer;
  if (newSoc         !== undefined) st.soc              = newSoc;
  if (newBattery     !== undefined) st.batteryLevel     = newBattery;
  if (newEstRange    !== undefined) st.estBatteryRange  = newEstRange;
  if (newEnergy      !== undefined) st.energyRemaining  = newEnergy;
  if (newSpeed       !== undefined) st.vehicleSpeed     = newSpeed;
  if (newLocation    !== undefined) st.location         = newLocation;

  // Update active trip accumulators
  if (st.trip) {
    if (newSpeed !== undefined) {
      if (newSpeed > st.trip.maxSpeedMph) st.trip.maxSpeedMph = newSpeed;
      if (newSpeed > 0) { st.trip.speedSum += newSpeed; st.trip.speedCount++; }
    }
    // Throttled last_seen_at update (once per minute)
    if (st.trip.dbId !== null &&
        now.getTime() - st.trip.lastDbSeenAt.getTime() >= LAST_SEEN_UPDATE_MS) {
      st.trip.lastDbSeenAt = now;
      updateTripLastSeen(st.trip.dbId, now);
    }
  }

  // Update active charge accumulators
  if (st.charge) {
    const power = newDcPower ?? newAcPower;
    if (power !== undefined && power > 0) {
      if (power > st.charge.peakPowerKw) st.charge.peakPowerKw = power;
      st.charge.powerSum   += power;
      st.charge.powerCount += 1;
    }
  }

  // ── Gear / Trip transitions ─────────────────────────────────────────────────
  if (newGear && newGear !== prevGear) {
    const nowDriving = DRIVING_GEARS.has(newGear);
    const nowParked  = PARKED_GEARS.has(newGear);
    const wasDriving = prevGear ? DRIVING_GEARS.has(prevGear) : false;
    const wasParked  = !prevGear || PARKED_GEARS.has(prevGear);

    if (nowDriving && (wasParked || !st.trip)) {
      const tripState: TripState = {
        dbId:           null,
        dbIdPromise:    Promise.resolve(null), // overwritten below
        startTime:      now,
        startBattery:   Math.round(st.batteryLevel ?? st.soc ?? 0),
        startOdometer:  st.odometer ?? 0,
        startEnergyKwh: st.energyRemaining ?? 0,
        startLocation:  st.location ?? null,
        maxSpeedMph:    0,
        speedSum:       0,
        speedCount:     0,
        lastDbSeenAt:   now,
      };
      const promise = insertTrip({
        vin,
        start_time:     now,
        start_battery:  tripState.startBattery,
        start_odometer: tripState.startOdometer,
        start_location: tripState.startLocation,
      }).then((id) => { tripState.dbId = id; return id; });
      tripState.dbIdPromise = promise;
      st.trip = tripState;

      console.log(
        `[Monitor] TRIP STARTED     vin=${vin}  gear=${newGear}` +
        `  odometer=${n(st.odometer)}mi  soc=${n(st.soc)}%`,
      );

    } else if (nowParked && st.trip) {
      const trip       = st.trip;
      const distMiles  = (st.odometer ?? trip.startOdometer) - trip.startOdometer;
      const energyUsed = Math.max(0, trip.startEnergyKwh - (st.energyRemaining ?? trip.startEnergyKwh));
      const avgSpeed   = trip.speedCount > 0 ? trip.speedSum / trip.speedCount : 0;
      const endBattery = Math.round(st.batteryLevel ?? st.soc ?? 0);

      console.log(
        `[Monitor] TRIP ENDED       vin=${vin}  gear=${newGear}` +
        `  distance=${distMiles.toFixed(2)}mi  energy=${energyUsed.toFixed(2)}kWh` +
        `  avg_speed=${avgSpeed.toFixed(1)}mph  duration=${elapsed(trip.startTime, now)}`,
      );

      // Await the dbId in case trip ended before insert resolved
      trip.dbIdPromise.then((id) => {
        if (id === null) return;
        completeTrip(id, {
          end_time:        now,
          end_battery:     endBattery,
          end_odometer:    st.odometer ?? trip.startOdometer,
          distance_miles:  distMiles,
          energy_used_kwh: energyUsed,
          avg_speed:       avgSpeed,
          max_speed:       trip.maxSpeedMph,
          end_location:    st.location ?? null,
        });
        if (distMiles > 0) {
          upsertDailySummary(vin, toDateStr(trip.startTime), {
            miles: distMiles, energy_used_kwh: energyUsed, trips: 1,
          });
        }
      });
      st.trip = undefined;

    } else if (nowDriving && wasDriving && st.trip) {
      console.log(`[Monitor] GEAR CHANGE      vin=${vin}  ${prevGear} -> ${newGear}`);
    }
  }

  // ── Charge session transitions ──────────────────────────────────────────────
  if (newChargeState && newChargeState !== prevChargeState) {
    const nowCharging = CHARGING_STATES.has(newChargeState);
    const nowDone     = NOT_CHARGING_STATES.has(newChargeState);
    const wasCharging = prevChargeState ? CHARGING_STATES.has(prevChargeState) : false;

    if (nowCharging && !wasCharging) {
      const milesSinceCharge = (st.lastChargeEndOdometer !== undefined && st.odometer !== undefined)
        ? st.odometer - st.lastChargeEndOdometer : 0;
      const powerKw = newDcPower ?? newAcPower ?? 0;

      const chargeState: ChargeSessionState = {
        dbId:                 null,
        dbIdPromise:          Promise.resolve(null),
        startTime:            now,
        startBattery:         Math.round(st.batteryLevel ?? st.soc ?? 0),
        startRange:           st.estBatteryRange ?? 0,
        startEnergyKwh:       st.energyRemaining ?? 0,
        startOdometer:        st.odometer ?? 0,
        milesSinceLastCharge: milesSinceCharge,
        peakPowerKw:          powerKw,
        powerSum:             powerKw > 0 ? powerKw : 0,
        powerCount:           powerKw > 0 ? 1 : 0,
      };
      const promise = insertChargingSession({
        vin,
        start_time:              now,
        start_battery:           chargeState.startBattery,
        start_range:             chargeState.startRange,
        start_odometer:          chargeState.startOdometer,
        miles_since_last_charge: milesSinceCharge,
      }).then((id) => { chargeState.dbId = id; return id; });
      chargeState.dbIdPromise = promise;
      st.charge = chargeState;

      console.log(
        `[Monitor] CHARGE STARTED   vin=${vin}  state=${newChargeState}` +
        `  soc=${n(st.soc)}%  range=${n(st.estBatteryRange)}mi` +
        (powerKw > 0 ? `  power=${powerKw.toFixed(1)}kW` : ""),
      );

    } else if (nowDone && wasCharging && st.charge) {
      const ch          = st.charge;
      const endBattery  = Math.round(st.batteryLevel ?? st.soc ?? 0);
      const endRange    = st.estBatteryRange ?? 0;
      const energyAdded = Math.max(0, (st.energyRemaining ?? 0) - ch.startEnergyKwh);
      const avgPower    = ch.powerCount > 0 ? ch.powerSum / ch.powerCount : 0;
      const durMins     = (now.getTime() - ch.startTime.getTime()) / 60_000;

      console.log(
        `[Monitor] CHARGE ENDED     vin=${vin}  state=${newChargeState}` +
        `  soc_gained=+${(endBattery - ch.startBattery)}%  energy=+${energyAdded.toFixed(2)}kWh` +
        `  peak=${ch.peakPowerKw.toFixed(1)}kW  avg=${avgPower.toFixed(1)}kW` +
        `  duration=${elapsed(ch.startTime, now)}`,
      );

      ch.dbIdPromise.then((id) => {
        if (id === null) return;
        completeChargingSession(id, {
          end_time:         now,
          end_battery:      endBattery,
          end_range:        endRange,
          end_odometer:     st.odometer ?? ch.startOdometer,
          energy_added_kwh: energyAdded,
          charge_rate_avg:  avgPower,
          charge_rate_max:  ch.peakPowerKw,
          charger_power:    ch.peakPowerKw,
          duration_minutes: durMins,
          final_state:      newChargeState,
        });
        upsertDailySummary(vin, toDateStr(ch.startTime), {
          energy_added_kwh: energyAdded, charges: 1,
        });
      });
      st.lastChargeEndOdometer = st.odometer;
      st.charge = undefined;

    } else {
      console.log(
        `[Monitor] CHARGE STATE     vin=${vin}  ${prevChargeState ?? "?"} -> ${newChargeState}`,
      );
    }
  }

  // ── Periodic progress (every 5 min while driving/charging) ─────────────────
  const now_ms      = now.getTime();
  const dueProgress = !st.lastProgressLogAt ||
    now_ms - st.lastProgressLogAt >= PROGRESS_INTERVAL_MS;

  if (st.trip && dueProgress) {
    const trip   = st.trip;
    const distMi = (st.odometer ?? trip.startOdometer) - trip.startOdometer;
    console.log(
      `[Monitor] TRIP PROGRESS    vin=${vin}` +
      `  distance=${distMi.toFixed(2)}mi  speed=${n(st.vehicleSpeed)}mph  soc=${n(st.soc)}%` +
      `  duration=${elapsed(trip.startTime, now)}`,
    );
    st.lastProgressLogAt = now_ms;
  }

  if (st.charge && dueProgress) {
    const ch       = st.charge;
    const avgPower = ch.powerCount > 0 ? ch.powerSum / ch.powerCount : 0;
    const powerKw  = newDcPower ?? newAcPower;
    console.log(
      `[Monitor] CHARGE PROGRESS  vin=${vin}` +
      `  soc=${n(st.soc)}%  range=${n(st.estBatteryRange)}mi` +
      (powerKw !== undefined ? `  power=${powerKw.toFixed(1)}kW` : "") +
      `  avg=${avgPower.toFixed(1)}kW  duration=${elapsed(ch.startTime, now)}`,
    );
    st.lastProgressLogAt = now_ms;
  }
}

export function getMonitorStats(): Record<string, {
  gear?: string; detailedChargeState?: string; odometer?: number;
  soc?: number; speed?: number; estRange?: number;
  onTrip: boolean; tripStartedAt?: string; tripDbId?: number | null;
  charging: boolean; chargeStartedAt?: string; chargeDbId?: number | null;
}> {
  const out: ReturnType<typeof getMonitorStats> = {};
  for (const [vin, st] of perVin) {
    out[vin] = {
      gear: st.gear, detailedChargeState: st.detailedChargeState,
      odometer: st.odometer, soc: st.soc, speed: st.vehicleSpeed, estRange: st.estBatteryRange,
      onTrip: !!st.trip, tripStartedAt: st.trip?.startTime.toISOString(), tripDbId: st.trip?.dbId,
      charging: !!st.charge, chargeStartedAt: st.charge?.startTime.toISOString(), chargeDbId: st.charge?.dbId,
    };
  }
  return out;
}
