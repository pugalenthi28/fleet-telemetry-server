/**
 * Log-only vehicle monitor.
 *
 * Detects state transitions from the streaming telemetry records already flowing
 * through wsServer.ts and logs human-readable events: trip start/end, charging
 * session start/end, and periodic in-progress updates.
 *
 * No database — all state lives in memory per VIN and resets on server restart.
 */

import { TelemetryRecord } from "./store";

interface TripState {
  startedAt: Date;
  startOdometer: number;
  startSoc: number;
}

interface ChargeSessionState {
  startedAt: Date;
  startSoc: number;
  startEnergyRemaining: number;
}

interface VehicleMonitorState {
  gear?: string;
  detailedChargeState?: string;
  odometer?: number;
  soc?: number;
  energyRemaining?: number;
  vehicleSpeed?: number;
  trip?: TripState;
  charge?: ChargeSessionState;
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

const PROGRESS_LOG_INTERVAL_MS = 5 * 60 * 1000; // every 5 min while driving/charging

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

function num(v: unknown, decimals = 1): string {
  return typeof v === "number" ? v.toFixed(decimals) : "?";
}

export function processVehicleEvent(record: TelemetryRecord): void {
  const { vin, fields, createdAt } = record;
  const st = getVinState(vin);
  const now = new Date(createdAt);

  // Pull relevant fields from this delta (may be undefined if not in this message)
  const newGear          = fields["Gear"] as string | undefined;
  const newChargeState   = fields["DetailedChargeState"] as string | undefined;
  const newOdometer      = fields["Odometer"] as number | undefined;
  const newSoc           = fields["Soc"] as number | undefined;
  const newSpeed         = fields["VehicleSpeed"] as number | undefined;
  const newEnergy        = fields["EnergyRemaining"] as number | undefined;
  const newAcPower       = fields["ACChargingPower"] as number | undefined;
  const newDcPower       = fields["DCChargingPower"] as number | undefined;

  // Update running snapshot
  if (newOdometer !== undefined) st.odometer        = newOdometer;
  if (newSoc      !== undefined) st.soc             = newSoc;
  if (newSpeed    !== undefined) st.vehicleSpeed     = newSpeed;
  if (newEnergy   !== undefined) st.energyRemaining  = newEnergy;

  // ── Gear / Trip detection ─────────────────────────────────────────────────

  if (newGear && newGear !== st.gear) {
    const prev = st.gear;
    st.gear = newGear;

    const nowDriving = DRIVING_GEARS.has(newGear);
    const nowParked  = PARKED_GEARS.has(newGear);
    const wasDriving = prev ? DRIVING_GEARS.has(prev) : false;
    const wasParked  = !prev || PARKED_GEARS.has(prev);

    if (nowDriving && (wasParked || !st.trip)) {
      // Park/unknown → Drive: trip start
      st.trip = {
        startedAt: now,
        startOdometer: st.odometer ?? 0,
        startSoc: st.soc ?? 0,
      };
      console.log(
        `[Monitor] TRIP STARTED   vin=${vin}  gear=${newGear}` +
        `  odometer=${num(st.odometer, 1)}mi  soc=${num(st.soc, 1)}%` +
        `  time=${fmtTime(now)}`,
      );
    } else if (nowParked && st.trip) {
      // Drive → Park: trip end
      const trip = st.trip;
      const miles   = (st.odometer ?? trip.startOdometer) - trip.startOdometer;
      const socUsed = trip.startSoc - (st.soc ?? trip.startSoc);
      console.log(
        `[Monitor] TRIP ENDED     vin=${vin}  gear=${newGear}` +
        `  distance=${miles.toFixed(2)}mi  soc_used=${socUsed.toFixed(1)}%` +
        `  duration=${elapsed(trip.startedAt, now)}  odometer=${num(st.odometer, 1)}mi` +
        `  time=${fmtTime(now)}`,
      );
      st.trip = undefined;
    } else if (nowDriving && wasDriving && st.trip) {
      // Gear shift within an active trip (D→R, R→D, etc.)
      console.log(
        `[Monitor] GEAR CHANGE    vin=${vin}  ${prev} -> ${newGear}  time=${fmtTime(now)}`,
      );
    }
  }

  // ── Charge session detection ──────────────────────────────────────────────

  if (newChargeState && newChargeState !== st.detailedChargeState) {
    const prev = st.detailedChargeState;
    st.detailedChargeState = newChargeState;

    const nowCharging = CHARGING_STATES.has(newChargeState);
    const nowDone     = NOT_CHARGING_STATES.has(newChargeState);
    const wasCharging = prev ? CHARGING_STATES.has(prev) : false;

    if (nowCharging && !wasCharging) {
      // Charge session started
      st.charge = {
        startedAt: now,
        startSoc: st.soc ?? 0,
        startEnergyRemaining: st.energyRemaining ?? 0,
      };
      const powerKw = newAcPower ?? newDcPower;
      console.log(
        `[Monitor] CHARGE STARTED vin=${vin}  state=${newChargeState}` +
        `  soc=${num(st.soc, 1)}%  energy=${num(st.energyRemaining, 2)}kWh` +
        (powerKw !== undefined ? `  power=${powerKw.toFixed(1)}kW` : "") +
        `  time=${fmtTime(now)}`,
      );
    } else if (nowDone && wasCharging && st.charge) {
      // Charge session ended
      const ch = st.charge;
      const socGained    = (st.soc ?? ch.startSoc) - ch.startSoc;
      const energyGained = (st.energyRemaining ?? ch.startEnergyRemaining) - ch.startEnergyRemaining;
      console.log(
        `[Monitor] CHARGE ENDED   vin=${vin}  state=${newChargeState}` +
        `  soc_gained=+${socGained.toFixed(1)}%  energy_added=${energyGained.toFixed(2)}kWh` +
        `  duration=${elapsed(ch.startedAt, now)}  soc=${num(st.soc, 1)}%` +
        `  time=${fmtTime(now)}`,
      );
      st.charge = undefined;
    } else {
      // Any other charge-state transition worth logging (e.g. NoPower → Starting)
      console.log(
        `[Monitor] CHARGE STATE   vin=${vin}  ${prev ?? "?"} -> ${newChargeState}  time=${fmtTime(now)}`,
      );
    }
  }

  // ── In-progress periodic updates (every 5 min) ────────────────────────────

  const now_ms = now.getTime();
  const dueForProgress =
    !st.lastProgressLogAt || now_ms - st.lastProgressLogAt >= PROGRESS_LOG_INTERVAL_MS;

  if (st.trip && dueForProgress) {
    const trip  = st.trip;
    const miles = (st.odometer ?? trip.startOdometer) - trip.startOdometer;
    const socUsed = trip.startSoc - (st.soc ?? trip.startSoc);
    console.log(
      `[Monitor] TRIP PROGRESS  vin=${vin}` +
      `  distance=${miles.toFixed(2)}mi  soc_used=${socUsed.toFixed(1)}%` +
      `  speed=${num(st.vehicleSpeed, 1)}mph  duration=${elapsed(trip.startedAt, now)}`,
    );
    st.lastProgressLogAt = now_ms;
  }

  if (st.charge && dueForProgress) {
    const ch       = st.charge;
    const socGained = (st.soc ?? ch.startSoc) - ch.startSoc;
    const powerKw   = newAcPower ?? newDcPower;
    console.log(
      `[Monitor] CHARGE PROGRESS vin=${vin}` +
      `  soc=${num(st.soc, 1)}%  soc_gained=+${socGained.toFixed(1)}%` +
      (powerKw !== undefined ? `  power=${powerKw.toFixed(1)}kW` : "") +
      `  duration=${elapsed(ch.startedAt, now)}`,
    );
    st.lastProgressLogAt = now_ms;
  }
}

/** Returns current in-memory monitor state for all tracked VINs (for diagnostics). */
export function getMonitorStats(): Record<string, {
  gear?: string;
  detailedChargeState?: string;
  odometer?: number;
  soc?: number;
  speed?: number;
  onTrip: boolean;
  tripStartedAt?: string;
  charging: boolean;
  chargeStartedAt?: string;
}> {
  const out: ReturnType<typeof getMonitorStats> = {};
  for (const [vin, st] of perVin) {
    out[vin] = {
      gear: st.gear,
      detailedChargeState: st.detailedChargeState,
      odometer: st.odometer,
      soc: st.soc,
      speed: st.vehicleSpeed,
      onTrip: !!st.trip,
      tripStartedAt: st.trip?.startedAt.toISOString(),
      charging: !!st.charge,
      chargeStartedAt: st.charge?.startedAt.toISOString(),
    };
  }
  return out;
}
