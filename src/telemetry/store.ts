/**
 * In-memory store for received telemetry data.
 * In production, replace with InfluxDB, TimescaleDB, or similar time-series DB.
 */

import { EventEmitter } from "events";

export interface TelemetryRecord {
  vin: string;
  txid: string;
  createdAt: number;
  fields: Record<string, unknown>;
  rawSignalCount: number; // total signals in the proto payload including invalid — matches Tesla billing
}

// Lightweight pub/sub for SSE subscribers — no DB calls, no blocking
export const telemetryEvents = new EventEmitter();
telemetryEvents.setMaxListeners(50);

const MAX_RECORDS_PER_VIN = 1000;
const store = new Map<string, TelemetryRecord[]>();
// Merged current state per VIN — all fields seen so far, updated on each message
const latestState = new Map<string, Record<string, unknown>>();

export const telemetryStore = {
  append(record: TelemetryRecord) {
    if (!store.has(record.vin)) store.set(record.vin, []);
    const records = store.get(record.vin)!;
    records.push(record);
    if (records.length > MAX_RECORDS_PER_VIN) {
      records.splice(0, records.length - MAX_RECORDS_PER_VIN);
    }
    // Merge new fields into the running state
    const state = latestState.get(record.vin) ?? {};
    Object.assign(state, record.fields);
    latestState.set(record.vin, state);
    // Notify SSE subscribers (zero-cost when no listeners)
    telemetryEvents.emit(record.vin, record);
  },

  // Returns all fields ever seen for this VIN, with their most recent values
  getMergedState(vin: string): Record<string, unknown> {
    return latestState.get(vin) ?? {};
  },

  getByVin(vin: string, limit = 100): TelemetryRecord[] {
    return (store.get(vin) ?? []).slice(-limit);
  },

  getAll(limit = 100): TelemetryRecord[] {
    const all: TelemetryRecord[] = [];
    for (const records of store.values()) {
      all.push(...records);
    }
    return all
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
  },

  getVins(): string[] {
    return [...store.keys()];
  },

  getLatest(vin: string): TelemetryRecord | undefined {
    const records = store.get(vin);
    return records?.[records.length - 1];
  },

  clear(vin?: string) {
    if (vin) store.delete(vin);
    else store.clear();
  },
};
