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

import { TelemetryRecord, telemetryStore } from "./store";
import {
  insertTrip,
  completeTrip,
  deleteTrip,
  updateTripLastSeen,
  updateTripStartOdometer,
  insertChargingSession,
  completeChargingSession,
  sumAndMarkTripsAccounted,
  insertTelemetryData,
  upsertDailySummary,
  updateChargeSessionStart,
  getLastKnownStateForVin,
  getActiveTripForVin,
  getActiveChargingSessionForVin,
  reopenRecentTripForVin,
  reopenRecentChargingSessionForVin,
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
  latestAcEnergyIn: number;
  latestDcEnergyIn: number;
  energyBaselineKwh?: number;  // first energy value observed — used for delta-based avg power
  energyBaselineAt?: number;   // timestamp of that first observation
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
  softwareVersion?: string;
  // True when fleet_telemetry_state was updated within the last 20 min — gates
  // catch-up session creation so stale state from a previous session doesn't
  // create ghost trips/charges on a fresh reconnect.
  catchUpEnabled?: boolean;
  acEnergyIn?: number;
  dcEnergyIn?: number;
  timeToFullCharge?: number;
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
const MIN_TRIP_DISTANCE_MI  = 0.1;

const perVin = new Map<string, VehicleMonitorState>();

function getVinState(vin: string): VehicleMonitorState {
  if (!perVin.has(vin)) perVin.set(vin, {});
  return perVin.get(vin)!;
}

function ts(d: Date = new Date()): string {
  return d.toISOString();
}

function shortState(s: string | undefined): string {
  if (!s) return "?";
  return s.replace("ShiftState", "").replace("DetailedChargeState", "");
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

function hoursToStr(h: number): string {
  const hh = Math.floor(h);
  const mm = Math.round((h % 1) * 60);
  return hh > 0 ? `${hh}h ${mm}m` : `${mm}m`;
}

function toDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Snapshot using the full merged state — every field streamed so far for this VIN
function stateSnapshot(vin: string, createdAt: number): TelemetryRecord {
  return { vin, txid: `${vin}-${createdAt}-snap`, createdAt, fields: { ...telemetryStore.getMergedState(vin) } };
}

// ── Session restore (called once on vehicle reconnect) ─────────────────────────

export async function restoreActiveSessionsFromDB(vin: string): Promise<void> {
  const st = getVinState(vin);

  // Pre-populate state from last known snapshot so gear transition logic works
  // even when the vehicle reconnects without re-sending unchanged fields.
  const REOPEN_WINDOW_MS = 20 * 60 * 1000;
  const STALE_MS         = 24 * 60 * 60 * 1000;

  const lastState = await getLastKnownStateForVin(vin);
  // How long ago the vehicle was last seen streaming — used for both catchUp gating
  // and charge staleness. Trips use their own last_seen_at so they're not affected.
  const stateAge = lastState?.updated_at
    ? Date.now() - new Date(lastState.updated_at).getTime()
    : Infinity;

  if (lastState) {
    if (lastState.gear                 != null) st.gear                = lastState.gear;
    if (lastState.detailed_charge_state != null) st.detailedChargeState = lastState.detailed_charge_state;
    if (lastState.odometer_mi          != null) st.odometer            = lastState.odometer_mi;
    if (lastState.soc_pct              != null) st.soc                 = lastState.soc_pct;
    if (lastState.battery_level_pct    != null) st.batteryLevel        = lastState.battery_level_pct;
    if (lastState.est_battery_range_mi != null) st.estBatteryRange     = lastState.est_battery_range_mi;
    if (lastState.energy_remaining_kwh != null) st.energyRemaining     = lastState.energy_remaining_kwh;
    st.catchUpEnabled = stateAge < REOPEN_WINDOW_MS;
  }

  if (!st.trip) {
    let tripRow = await getActiveTripForVin(vin);
    let reopened = false;
    if (!tripRow && st.catchUpEnabled && st.gear && DRIVING_GEARS.has(st.gear)) {
      tripRow = await reopenRecentTripForVin(vin);
      reopened = tripRow !== null;
    }
    if (tripRow) {
      const lastSeen = tripRow.last_seen_at ? new Date(tripRow.last_seen_at) : new Date(tripRow.start_time);
      if (Date.now() - lastSeen.getTime() > STALE_MS) {
        const endOdo  = lastState?.odometer_mi          ?? tripRow.start_odometer;
        const endBatt = lastState?.battery_level_pct    ?? tripRow.start_battery;
        const dist    = Math.max(0, endOdo - tripRow.start_odometer);
        if (dist < MIN_TRIP_DISTANCE_MI) {
          deleteTrip(tripRow.id);
        } else {
          completeTrip(tripRow.id, {
            end_time: lastSeen, end_battery: Math.round(endBatt ?? 0),
            end_odometer: endOdo, distance_miles: dist,
            energy_used_kwh: 0, avg_speed: null, max_speed: null,
          });
        }
        console.log(`[${ts()}] 🗄️  Stale trip #${tripRow.id} closed (last seen ${lastSeen.toISOString()})  vin=${vin.slice(-6)}`);
      } else if (st.gear && PARKED_GEARS.has(st.gear)) {
        // Car reconnected while already parked — complete the trip now
        const endOdo  = lastState?.odometer_mi       ?? tripRow.start_odometer;
        const endBatt = lastState?.battery_level_pct ?? tripRow.start_battery;
        const dist    = Math.max(0, endOdo - tripRow.start_odometer);
        if (dist < MIN_TRIP_DISTANCE_MI) {
          deleteTrip(tripRow.id);
        } else {
          completeTrip(tripRow.id, {
            end_time:        lastSeen,
            end_battery:     Math.round(endBatt ?? 0),
            end_odometer:    endOdo,
            distance_miles:  dist,
            energy_used_kwh: 0,
            avg_speed:       null,
            max_speed:       null,
          });
        }
        console.log(`[${ts()}] 🅿️  Trip #${tripRow.id} closed on restore (already parked, ${dist.toFixed(1)} mi)  vin=${vin.slice(-6)}`);
      } else {
        const resolved = Promise.resolve<number | null>(tripRow.id);
        st.trip = {
          dbId:           tripRow.id,
          dbIdPromise:    resolved,
          startTime:      new Date(tripRow.start_time),
          startBattery:   tripRow.start_battery ?? 0,
          startOdometer:  tripRow.start_odometer ?? 0,
          startEnergyKwh: tripRow.start_energy_kwh ?? st.energyRemaining ?? 0,
          startLocation:  null,
          maxSpeedMph:    0,
          speedSum:       0,
          speedCount:     0,
          lastDbSeenAt:   new Date(),
        };
        st.lastProgressLogAt = Date.now();
        console.log(
          `[${ts()}] 🔄 Trip ${reopened ? "REOPENED" : "RESTORED"}  #${tripRow.id}  started=${tripRow.start_time}  vin=${vin.slice(-6)}`,
        );
      }
    }
  }

  if (!st.charge) {
    let chargeRow = await getActiveChargingSessionForVin(vin);
    let reopened = false;
    if (!chargeRow) {
      chargeRow = await reopenRecentChargingSessionForVin(vin);
      reopened = chargeRow !== null;
    }
    if (chargeRow) {
      // Use stateAge (when vehicle was last seen), NOT session duration.
      // L1 charges run 40-60+ hours — closing by session age would kill them mid-charge.
      // If the vehicle was streaming recently the session is live regardless of start time.
      if (stateAge > STALE_MS) {
        const chargeAge = Date.now() - new Date(chargeRow.start_time).getTime();
        const endBatt  = lastState?.battery_level_pct    ?? chargeRow.start_battery;
        const endRange = lastState?.est_battery_range_mi ?? chargeRow.start_range;
        const endOdo   = lastState?.odometer_mi          ?? chargeRow.start_odometer;
        completeChargingSession(chargeRow.id, {
          end_time: new Date(), end_battery: Math.round(endBatt ?? 0),
          end_range: endRange ?? chargeRow.start_range, end_odometer: endOdo ?? chargeRow.start_odometer,
          energy_added_kwh: 0, charge_rate_avg: null, charge_rate_max: null,
          charger_power: 0, duration_minutes: chargeAge / 60_000,
          final_state: "DetailedChargeStateStopped",
        });
        console.log(`[${ts()}] 🗄️  Stale charge #${chargeRow.id} closed (vehicle offline ${Math.round(stateAge / 3600_000)}h)  vin=${vin.slice(-6)}`);
      } else if (NOT_CHARGING_STATES.has(st.detailedChargeState ?? "")) {
        // Ghost session — vehicle is no longer charging, close it
        const endBatt  = lastState?.battery_level_pct    ?? chargeRow.start_battery;
        const endRange = lastState?.est_battery_range_mi ?? chargeRow.start_range;
        const endOdo   = lastState?.odometer_mi          ?? chargeRow.start_odometer;
        completeChargingSession(chargeRow.id, {
          end_time:         new Date(),
          end_battery:      Math.round(endBatt ?? 0),
          end_range:        endRange ?? chargeRow.start_range,
          end_odometer:     endOdo ?? chargeRow.start_odometer,
          energy_added_kwh: 0,
          charge_rate_avg:  null,
          charge_rate_max:  null,
          charger_power:    0,
          duration_minutes: (Date.now() - new Date(chargeRow.start_time).getTime()) / 60_000,
          final_state:      "DetailedChargeStateStopped",
        });
        console.log(`[${ts()}] 🚫 Ghost charge #${chargeRow.id} closed on restore (state=${shortState(st.detailedChargeState)})  vin=${vin.slice(-6)}`);
      } else {
        const resolved = Promise.resolve<number | null>(chargeRow.id);
        st.charge = {
          dbId:                 chargeRow.id,
          dbIdPromise:          resolved,
          startTime:            new Date(chargeRow.start_time),
          startBattery:         chargeRow.start_battery ?? 0,
          startRange:           chargeRow.start_range ?? 0,
          startEnergyKwh:       st.energyRemaining ?? 0,
          startOdometer:        chargeRow.start_odometer ?? 0,
          milesSinceLastCharge: chargeRow.miles_since_last_charge ?? 0,
          peakPowerKw:          0,
          powerSum:             0,
          powerCount:           0,
          latestAcEnergyIn:     0,
          latestDcEnergyIn:     0,
        };
        st.lastProgressLogAt = Date.now();
        console.log(
          `[${ts()}] 🔄 Charge ${reopened ? "REOPENED" : "RESTORED"}  #${chargeRow.id}  🔋 ${chargeRow.start_battery}%  started=${chargeRow.start_time}  vin=${vin.slice(-6)}`,
        );
      }
    }
  }
}

// ── Disconnect handler (called on WS close) ────────────────────────────────────
// Does NOT complete trips or charges — they stay active in DB and are restored
// on reconnect. Only gear=P or charge state transition should close them.

export async function handleVehicleDisconnect(vin: string, remainingConnections = 0): Promise<void> {
  const st = getVinState(vin);
  const now = new Date();

  // If other WS connections for this VIN are still alive, preserve session state.
  // Clearing it would cause catch-up logic on the next frame to create ghost sessions.
  if (remainingConnections > 0) {
    if (st.trip) {
      const id = st.trip.dbId ?? await st.trip.dbIdPromise;
      if (id !== null) updateTripLastSeen(id, now);
    }
    console.log(`[${ts(now)}] 🔗 ${vin.slice(-6)} connection dropped (${remainingConnections} still active, sessions preserved)`);
    return;
  }

  if (st.trip) {
    const trip = st.trip;
    st.trip = undefined; // clear immediately to prevent double-fire on multi-connection disconnect
    const id = trip.dbId ?? await trip.dbIdPromise;
    if (id !== null) {
      updateTripLastSeen(id, now);
      console.log(
        `[${ts(now)}] 📡 Trip #${id} paused (WS disconnect) — will close on next park  vin=${vin.slice(-6)}`,
      );
    }
  }

  if (st.charge) {
    const ch = st.charge;
    st.charge = undefined;
    const id = ch.dbId ?? await ch.dbIdPromise;
    if (id !== null) {
      console.log(
        `[${ts(now)}] 📡 Charge #${id} paused (WS disconnect) — will close on state change  vin=${vin.slice(-6)}`,
      );
    }
  }
}

// ── Main event processor ───────────────────────────────────────────────────────

export function processVehicleEvent(record: TelemetryRecord): void {
  const { vin, fields, createdAt } = record;
  const st  = getVinState(vin);
  const now = new Date(createdAt);

  const newVersion     = fields["Version"]              as string | undefined;
  const newGear        = fields["Gear"]                as string | undefined;
  const newChargeState = fields["DetailedChargeState"] as string | undefined;
  const newOdometer    = fields["Odometer"]            as number | undefined;
  const newSoc         = fields["Soc"]                 as number | undefined;
  const newBattery     = fields["BatteryLevel"]        as number | undefined;
  const newEstRange    = fields["EstBatteryRange"]     as number | undefined;
  const newEnergy      = fields["EnergyRemaining"]     as number | undefined;
  const newSpeed       = fields["VehicleSpeed"]        as number | undefined;
  const newAcPower        = fields["ACChargingPower"]     as number | undefined;
  const newDcPower        = fields["DCChargingPower"]     as number | undefined;
  const newChargerVoltage = fields["ChargerVoltage"]      as number | undefined;
  const newLocation    = fields["Location"]            as { latitude: number; longitude: number } | undefined;
  const newAcEnergyIn       = fields["ACChargingEnergyIn"]  as number | undefined;
  const newDcEnergyIn       = fields["DCChargingEnergyIn"]  as number | undefined;
  const newTimeToFullCharge = fields["TimeToFullCharge"]     as number | undefined;

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
  if (newAcEnergyIn       !== undefined) st.acEnergyIn       = newAcEnergyIn;
  if (newDcEnergyIn       !== undefined) st.dcEnergyIn       = newDcEnergyIn;
  if (newTimeToFullCharge !== undefined) st.timeToFullCharge = newTimeToFullCharge;

  // ── Backfill start odometer if it was unknown (0) at trip/charge creation ────
  // Telemetry sends Gear/ChargerVoltage and Odometer in separate frames; the first
  // Odometer or EstBatteryRange message corrects DB rows so calculations are right.
  if (st.trip && st.trip.startOdometer === 0 && newOdometer !== undefined && newOdometer > 0) {
    st.trip.startOdometer = newOdometer;
    st.trip.dbIdPromise.then((id) => {
      if (id !== null) updateTripStartOdometer(id, newOdometer);
    });
  }
  if (st.charge) {
    const patch: { start_odometer?: number; start_range?: number } = {};
    if (st.charge.startOdometer === 0 && newOdometer  !== undefined && newOdometer  > 0) {
      st.charge.startOdometer = newOdometer;
      patch.start_odometer = newOdometer;
    }
    if (st.charge.startRange   === 0 && newEstRange   !== undefined && newEstRange   > 0) {
      st.charge.startRange = newEstRange;
      patch.start_range = newEstRange;
    }
    if (Object.keys(patch).length > 0) {
      st.charge.dbIdPromise.then((id) => {
        if (id !== null) updateChargeSessionStart(id, patch);
      });
    }
  }

  // ── Software version change ─────────────────────────────────────────────────
  if (newVersion !== undefined && newVersion !== st.softwareVersion) {
    if (st.softwareVersion !== undefined) {
      console.log(
        `[${ts(now)}] 🆕 OTA update: ${st.softwareVersion} → ${newVersion}  vin=${vin.slice(-6)}`,
      );
    }
    st.softwareVersion = newVersion;
    insertTelemetryData(stateSnapshot(vin, now.getTime()), true);
  }

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
    const power = (newDcPower !== undefined && newDcPower > 0) ? newDcPower : newAcPower;
    if (power !== undefined && power > 0) {
      if (power > st.charge.peakPowerKw) st.charge.peakPowerKw = power;
      st.charge.powerSum   += power;
      st.charge.powerCount += 1;
    }
    if (newDcEnergyIn !== undefined) {
      st.charge.latestDcEnergyIn = newDcEnergyIn;
      if (st.charge.energyBaselineKwh === undefined) {
        st.charge.energyBaselineKwh = newDcEnergyIn;
        st.charge.energyBaselineAt  = Date.now();
      }
    }
    if (newAcEnergyIn !== undefined) {
      st.charge.latestAcEnergyIn = newAcEnergyIn;
      if (st.charge.energyBaselineKwh === undefined) {
        st.charge.energyBaselineKwh = newAcEnergyIn;
        st.charge.energyBaselineAt  = Date.now();
      }
    }
  }

  // ── Catch-up trip: driving but no active trip ──────────────────────────────
  // Fires when server restarts mid-drive AND restoreActiveSessionsFromDB couldn't
  // find or reopen a session (e.g., first run ever). Gated on catchUpEnabled so
  // stale state from a previous session doesn't create ghost trips.
  if (!st.trip && st.catchUpEnabled && st.gear && DRIVING_GEARS.has(st.gear)) {
    const tripState: TripState = {
      dbId:           null,
      dbIdPromise:    Promise.resolve(null),
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
      start_time:       now,
      start_battery:    tripState.startBattery,
      start_odometer:   tripState.startOdometer,
      start_energy_kwh: tripState.startEnergyKwh,
      start_location:   tripState.startLocation,
    }).then((id) => { tripState.dbId = id; return id; });
    tripState.dbIdPromise = promise;
    st.trip = tripState;
    console.log(
      `[${ts(now)}] 🚗 Trip RESUMED (reconnected mid-drive, gear=${shortState(st.gear)})` +
      `  odo: ${n(st.odometer)} mi | 🔋 ${Math.round(st.batteryLevel ?? st.soc ?? 0)}%` +
      `  vin=${vin.slice(-6)}`,
    );
  }

  // ── Catch-up charge: charging but no active session ────────────────────────
  // Fires when restoreActiveSessionsFromDB couldn't reopen a session (e.g., too
  // old to reopen, first run). Uses live ChargerVoltage > 10 as primary signal
  // so it works even when DetailedChargeState hasn't been sent yet.
  // Live charging signals: any positive voltage or DC power means charging is active.
  const notExplicitlyNotCharging = !NOT_CHARGING_STATES.has(st.detailedChargeState ?? "");
  const chargingNow = (st.detailedChargeState && CHARGING_STATES.has(st.detailedChargeState))
    || (notExplicitlyNotCharging && newChargerVoltage !== undefined && newChargerVoltage > 0)
    || (notExplicitlyNotCharging && newDcPower !== undefined && newDcPower > 0);
  if (!st.charge && chargingNow) {
    const milesSinceCharge = (st.lastChargeEndOdometer !== undefined && st.odometer !== undefined)
      ? st.odometer - st.lastChargeEndOdometer : 0;
    const powerKw = (newDcPower !== undefined && newDcPower > 0) ? newDcPower : (newAcPower ?? 0);
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
      latestAcEnergyIn:     0,
      latestDcEnergyIn:     0,
    };
    const promise = (async () => {
      const energySinceLastCharge = await sumAndMarkTripsAccounted(vin);
      const id = await insertChargingSession({
        vin,
        start_time:                        now,
        start_battery:                     chargeState.startBattery,
        start_range:                       chargeState.startRange,
        start_odometer:                    chargeState.startOdometer,
        miles_since_last_charge:           milesSinceCharge,
        energy_used_since_last_charge_kwh: energySinceLastCharge,
      });
      chargeState.dbId = id;
      return id;
    })();
    chargeState.dbIdPromise = promise;
    st.charge = chargeState;
    st.lastProgressLogAt = Date.now();
    console.log(
      `[${ts(now)}] 🔌 Charge RESUMED (reconnected mid-charge, state=${shortState(st.detailedChargeState)})` +
      ` | 🔋 ${n(st.soc)}% | range: ${n(st.estBatteryRange)} mi` +
      (powerKw > 0 ? ` | ⚡ ${powerKw.toFixed(1)} kW` : "") +
      `  vin=${vin.slice(-6)}`,
    );
  }

  // ── Gear / Trip transitions ─────────────────────────────────────────────────
  if (newGear && newGear !== prevGear) {
    const nowDriving = DRIVING_GEARS.has(newGear);
    const nowParked  = PARKED_GEARS.has(newGear);
    const wasDriving = prevGear ? DRIVING_GEARS.has(prevGear) : false;

    if (nowDriving && !st.trip) {
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
        start_time:       now,
        start_battery:    tripState.startBattery,
        start_odometer:   tripState.startOdometer,
        start_energy_kwh: tripState.startEnergyKwh,
        start_location:   tripState.startLocation,
      }).then((id) => { tripState.dbId = id; return id; });
      tripState.dbIdPromise = promise;
      st.trip = tripState;

      console.log(
        `[${ts(now)}] 🚗 Trip STARTED (${shortState(prevGear)} → ${shortState(newGear)})` +
        `  odo: ${n(st.odometer)} mi | 🔋 ${Math.round(st.batteryLevel ?? st.soc ?? 0)}%` +
        `  vin=${vin.slice(-6)}`,
      );

    } else if (nowParked && st.trip) {
      const trip       = st.trip;
      const distMiles  = (st.odometer ?? trip.startOdometer) - trip.startOdometer;
      const energyUsed = Math.max(0, trip.startEnergyKwh - (st.energyRemaining ?? trip.startEnergyKwh));
      const avgSpeed   = trip.speedCount > 0 ? trip.speedSum / trip.speedCount : 0;
      const endBattery = Math.round(st.batteryLevel ?? st.soc ?? 0);

      if (distMiles < 0) {
        console.warn(
          `[${ts(now)}] ⚠️  Trip #${trip.dbId ?? "?"} negative distance (${distMiles.toFixed(2)} mi) — deleting  vin=${vin.slice(-6)}`,
        );
        trip.dbIdPromise.then((id) => { if (id !== null) deleteTrip(id); });
        st.trip = undefined;
        return;
      }

      if (distMiles < MIN_TRIP_DISTANCE_MI) {
        console.log(
          `[${ts(now)}] 🗑️  Trip #${trip.dbId ?? "?"} cancelled (${distMiles.toFixed(2)} mi — below threshold)` +
          `  vin=${vin.slice(-6)}`,
        );
        trip.dbIdPromise.then((id) => { if (id !== null) deleteTrip(id); });
        st.trip = undefined;
        return;
      }

      console.log(
        `[${ts(now)}] 🏁 Trip #${trip.dbId ?? "?"} closed:` +
        `  ${distMiles.toFixed(1)} mi | ${trip.startBattery}%→${endBattery}%` +
        ` | ${elapsed(trip.startTime, now)}  vin=${vin.slice(-6)}`,
      );
      insertTelemetryData(stateSnapshot(vin, now.getTime()), true);

      // Await the dbId in case trip ended before insert resolved
      trip.dbIdPromise.then((id) => {
        if (id === null) return;
        completeTrip(id, {
          end_time:        now,
          end_battery:     endBattery,
          end_odometer:    st.odometer ?? trip.startOdometer,
          distance_miles:  distMiles,
          energy_used_kwh: energyUsed,
          avg_speed:       avgSpeed > 0 ? avgSpeed : null,
          max_speed:       trip.maxSpeedMph > 0 ? trip.maxSpeedMph : null,
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
      console.log(`[${ts(now)}] 🚗 Shift change: ${shortState(prevGear)} → ${shortState(newGear)}  vin=${vin.slice(-6)}`);
    }
  }

  // ── Charge session transitions ──────────────────────────────────────────────
  if (newChargeState && newChargeState !== prevChargeState) {
    const nowCharging = CHARGING_STATES.has(newChargeState);
    const nowDone     = NOT_CHARGING_STATES.has(newChargeState);

    if (nowCharging && !st.charge) {
      const milesSinceCharge = (st.lastChargeEndOdometer !== undefined && st.odometer !== undefined)
        ? st.odometer - st.lastChargeEndOdometer : 0;
      const powerKw = (newDcPower !== undefined && newDcPower > 0) ? newDcPower : (newAcPower ?? 0);

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
        latestAcEnergyIn:     0,
        latestDcEnergyIn:     0,
      };
      // Sum kWh from all trips since the last charge, then mark them accounted
      const promise = (async () => {
        const energySinceLastCharge = await sumAndMarkTripsAccounted(vin);
        const id = await insertChargingSession({
          vin,
          start_time:                        now,
          start_battery:                     chargeState.startBattery,
          start_range:                       chargeState.startRange,
          start_odometer:                    chargeState.startOdometer,
          miles_since_last_charge:           milesSinceCharge,
          energy_used_since_last_charge_kwh: energySinceLastCharge,
        });
        chargeState.dbId = id;
        return id;
      })();
      chargeState.dbIdPromise = promise;
      st.charge = chargeState;

      console.log(
        `[${ts(now)}] 🔌 Charge STARTED | 🔋 ${n(st.soc)}% | range: ${n(st.estBatteryRange)} mi` +
        (powerKw > 0 ? ` | ⚡ ${powerKw.toFixed(1)} kW` : "") +
        `  vin=${vin.slice(-6)}`,
      );
      insertTelemetryData(stateSnapshot(vin, now.getTime()), true);

    } else if (nowDone && st.charge) {
      const ch          = st.charge;
      const endBattery  = Math.round(st.batteryLevel ?? st.soc ?? 0);
      const endRange    = st.estBatteryRange ?? 0;
      // ACChargingEnergyIn/DCChargingEnergyIn reset at session start, so the latest
      // DCChargingEnergyIn = energy into the battery (matches Tesla's charge_energy_added for L1/L2).
      // ACChargingEnergyIn = wall draw (higher, includes onboard charger losses ~79% efficient).
      // For Supercharger: ACChargingEnergyIn = 0, DCChargingEnergyIn = delivered energy.
      const energyFromCounters = ch.latestDcEnergyIn > 0 ? ch.latestDcEnergyIn : ch.latestAcEnergyIn;
      const energyAdded = energyFromCounters > 0
        ? energyFromCounters
        : Math.max(0, (st.energyRemaining ?? 0) - ch.startEnergyKwh);
      const avgPower    = ch.powerCount > 0 ? ch.powerSum / ch.powerCount : 0;
      const durMins     = (now.getTime() - ch.startTime.getTime()) / 60_000;

      console.log(
        `[${ts(now)}] ✅ Charge #${ch.dbId ?? "?"} closed:` +
        `  +${energyAdded.toFixed(1)} kWh | ${ch.startBattery}%→${endBattery}%` +
        ` | peak ${ch.peakPowerKw.toFixed(1)} kW | ${elapsed(ch.startTime, now)}` +
        `  vin=${vin.slice(-6)}`,
      );
      insertTelemetryData(stateSnapshot(vin, now.getTime()), true);

      ch.dbIdPromise.then((id) => {
        if (id === null) return;
        completeChargingSession(id, {
          end_time:         now,
          end_battery:      endBattery,
          end_range:        endRange,
          end_odometer:     st.odometer ?? ch.startOdometer,
          energy_added_kwh: energyAdded,
          charge_rate_avg:  ch.powerCount > 0 ? avgPower : null,
          charge_rate_max:  ch.peakPowerKw > 0 ? ch.peakPowerKw : null,
          charger_power:    ch.peakPowerKw > 0 ? ch.peakPowerKw : 0,
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
        `[${ts(now)}] 🔋 Charge state: ${shortState(prevChargeState)} → ${shortState(newChargeState)}  vin=${vin.slice(-6)}`,
      );
    }
  }

  // ── Periodic progress (every 5 min while driving/charging) ─────────────────
  const now_ms      = now.getTime();
  const dueProgress = !st.lastProgressLogAt ||
    now_ms - st.lastProgressLogAt >= PROGRESS_INTERVAL_MS;

  if (st.trip && dueProgress) {
    const trip    = st.trip;
    const distMi  = (st.odometer ?? trip.startOdometer) - trip.startOdometer;
    const battPct = st.batteryLevel ?? st.soc;
    const kwhUsed = trip.startEnergyKwh > 0 && st.energyRemaining !== undefined
      ? Math.max(0, trip.startEnergyKwh - st.energyRemaining) : 0;
    console.log(
      `[${ts(now)}] 🚗 Trip #${trip.dbId ?? "?"} | ${distMi.toFixed(1)} mi` +
      (battPct !== undefined ? ` | 🔋 ${Math.round(battPct)}%` : "") +
      (st.vehicleSpeed !== undefined ? ` | ${n(st.vehicleSpeed)} mph` : "") +
      (kwhUsed > 0 ? ` | -${kwhUsed.toFixed(2)} kWh` : "") +
      ` | ${elapsed(trip.startTime, now)}  vin=${vin.slice(-6)}`,
    );
    st.lastProgressLogAt = now_ms;
  }

  if (st.charge && dueProgress) {
    const ch       = st.charge;
    const kwhSoFarForAvg = ch.latestDcEnergyIn > 0 ? ch.latestDcEnergyIn : ch.latestAcEnergyIn;
    const elapsedSinceBaseline = ch.energyBaselineAt !== undefined ? (now_ms - ch.energyBaselineAt) / 3_600_000 : 0;
    const kwhDelta = ch.energyBaselineKwh !== undefined ? Math.max(0, kwhSoFarForAvg - ch.energyBaselineKwh) : 0;
    const avgPower = ch.powerCount > 0
      ? ch.powerSum / ch.powerCount
      : (kwhDelta > 0 && elapsedSinceBaseline > 0 ? kwhDelta / elapsedSinceBaseline : 0);
    const isDc     = (newDcPower !== undefined && newDcPower > 0) || ch.latestDcEnergyIn > ch.latestAcEnergyIn;
    const powerKw  = isDc ? (newDcPower ?? 0) : (newAcPower ?? newDcPower);
    const chargeType = isDc ? "DC" : "AC";
    const battPct  = st.batteryLevel ?? st.soc;
    const rangeMi  = st.estBatteryRange;
    const kwhSoFar = kwhSoFarForAvg;
    const timeLeft = st.timeToFullCharge !== undefined && st.timeToFullCharge > 0
      ? ` | ~${hoursToStr(st.timeToFullCharge)} left` : "";
    console.log(
      `[${ts(now)}] ⚡ Charge #${ch.dbId ?? "?"} [${chargeType}]` +
      ` | 🔋 ${battPct !== undefined ? Math.round(battPct) : "?"}%` +
      (rangeMi  !== undefined ? ` | range: ${n(rangeMi)} mi` : "") +
      (powerKw  !== undefined && powerKw > 0 ? ` | ${powerKw.toFixed(1)} kW` : "") +
      ` | avg ${avgPower.toFixed(1)} kW` +
      (kwhSoFar > 0 ? ` | +${kwhSoFar.toFixed(2)} kWh` : "") +
      timeLeft +
      ` | ${elapsed(ch.startTime, now)}  vin=${vin.slice(-6)}`,
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
