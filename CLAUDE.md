# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev        # Run in development (ts-node-dev, hot reload)
npm run build      # Compile TypeScript → dist/
npm start          # Run compiled output
npm run generate-keys  # Generate EC key pair for JWS signing
```

No test runner is configured.

## Architecture Overview

This is a **Tesla Fleet Telemetry ingestion server** — it receives live telemetry from Tesla vehicles over WebSocket, detects trip/charge sessions, and persists everything to Supabase.

### Wire Format (inbound from vehicle)

Tesla sends binary frames over `wss://host/` or `wss://host/streaming`.

1. **FlatBuffers envelope** (`flatbuffers-frame.ts`) — manually parsed (no codegen). Contains: `txid`, `topic`, `messageType` (4 = stream data, 5 = ACK), and a nested `FlatbuffersStream` table that holds the VIN and raw protobuf bytes.
2. **Protobuf payload** (`decoder.ts`) — decoded using `protobufjs` against `protos/vehicle_data.proto`. Each frame is a `Payload` with a repeated `data` array of `{key: DatumType, value: {oneofField: actualValue}}`.

**Critical decoder detail**: protobufjs `defaults: false` silently drops fields whose value is `0.0`. The decoder uses `oneofs: true` which adds a discriminator key `value` naming the active oneof field — this lets us correctly extract `0.0` numeric values that would otherwise be dropped. Fields with `activeField === "invalid"` or `"invalidValue"` are skipped.

After decoding, each frame becomes a `TelemetryRecord { vin, txid, createdAt, fields: Record<string, unknown> }`. Field names match the proto enum exactly (e.g. `"Gear"`, `"Soc"`, `"Odometer"`, `"ACChargingEnergyIn"`, `"DCChargingEnergyIn"`).

### Telemetry Pipeline

```
Tesla Vehicle (WS)
  → wsServer.ts        parse frame, decode protobuf, throttle DB writes
  → store.ts           append to in-memory ring buffer (1000/VIN), update merged state
  → vehicleMonitor.ts  detect gear/charge transitions, track trip/charge sessions
  → repository.ts      persist to Supabase (vehicles, trips, charging sessions, state)
```

### In-Memory Store (`store.ts`)

Ring buffer of `TelemetryRecord[]` per VIN (max 1000). `getMergedState(vin)` returns a single object with the latest value for every field ever seen for that VIN. Also an `EventEmitter` — routes subscribe via SSE (`/api/telemetry/stream/:vin`).

### Vehicle Monitor (`vehicleMonitor.ts`)

Stateful per-VIN object (`VehicleState`) tracking current gear, charge state, odometer, active trip, and active charge session. Key behaviors:

- **Trip detection**: `Gear` transitions from `"Park"` → `"Drive"/"Reverse"` open a trip; reverse transition closes it. Trips below `MIN_TRIP_DISTANCE_MI` (0.2 mi) are deleted on close.
- **Charge detection**: `DetailedChargeState` === `"Charging"` opens a session; leaving that state closes it.
- **Energy source**: `DCChargingEnergyIn` is preferred (matches Tesla's `charge_energy_added` — energy into battery). `ACChargingEnergyIn` is wall draw (~21% higher due to onboard charger losses).
- **Avg power calculation**: Delta-based from an `energyBaselineKwh` set on the first energy frame received after session open — avoids inflated averages from carry-over energy values at session start.
- **Reconnect recovery**: `restoreActiveSessionsFromDB()` runs on first message from a vehicle. It only fills `undefined` fields in the live state — it never overwrites values that arrived from a live connection (prevents stale DB data clobbering fresher in-memory state). Also restores `softwareVersion` from DB and calls `ensureSoftwareVersionRecorded` to backfill any missing `software_versions` row.
- **Dual-connection safety**: Tesla vehicles sometimes maintain two concurrent WS connections. `handleVehicleDisconnect(vin, remainingConnections)` returns early (preserving sessions) when other connections for the same VIN are still active.
- **Odometer gap on reconnect**: When a catch-up trip is created after a mid-drive reconnect, the start odometer is taken from the last completed trip's `end_odometer` (if gap < 2 mi) to avoid distance gaps in the history.
- **Progress logs**: Fired every 5 minutes while a session is active. `st.lastProgressLogAt` is set immediately after session restore to suppress a spurious immediate log.
- **miles_since_last_charge**: Computed at charge **open** time from `st.lastChargeEndOdometer` (in-memory) or, if missing after a server restart, from the last completed charge's `end_odometer` queried from DB. Re-confirmed at charge **close** time via `getLastCompletedChargeEndOdometerForVin` and written back to the session row.
- **Software version tracking**: `Version` field changes trigger a `software_versions` upsert. First-seen version on reconnect is backfilled via `ensureSoftwareVersionRecorded` (runs only in `restoreActiveSessionsFromDB`, not on every frame).

### Database (Supabase / `repository.ts`)

Tables: `fleet_vehicles`, `fleet_telemetry_state`, `fleet_telemetry_data`, `fleet_trips`, `fleet_charging_sessions`, `fleet_daily_summary`, `software_versions`.

`fleet_telemetry_data` writes are opt-in — only inserted when `ENABLE_TELEMETRY_EVENTS=true`. State snapshots (`fleet_telemetry_state`) and session records are always written.

Both state and raw-event inserts are **throttled in `wsServer.ts`** (5-minute intervals) to avoid Supabase rate limits.

#### `fleet_charging_sessions` notable columns
- `start_odometer`, `end_odometer` — written at session open; **re-confirmed and updated at close** so odometer values are always accurate even if stale at open time.
- `miles_since_last_charge` — written at session open (DB-backed if in-memory state is missing) and re-confirmed at close.

#### `software_versions` table
Tracks every OTA firmware update. One row per `(vin, current_version)` — requires a unique constraint:
```sql
ALTER TABLE software_versions ADD CONSTRAINT software_versions_vin_version_key UNIQUE (vin, current_version);
```
RLS policies required (table uses anon key):
```sql
CREATE POLICY "allow_all_inserts" ON software_versions FOR INSERT WITH CHECK (true);
CREATE POLICY "allow_all_selects" ON software_versions FOR SELECT USING (true);
```

### API Endpoints

#### `GET /api/charging/history`
Proxies Tesla Fleet API `/api/1/dx/charging/history` using a **partner token** (client credentials — not the user OAuth token). Returns Supercharger sessions only; L1/L2 home charging is not available via Tesla's API.

Query params (all optional): `vin`, `startTime` (ISO 8601), `endTime` (ISO 8601), `pageNo`, `pageSize`.

Partner token is fetched via `client_credentials` grant and cached in memory (`teslaClient.ts: getPartnerToken()`).

### Auth (`auth/`)

Tesla OAuth 2.0 + PKCE flow. Tokens stored in memory (`tokenStore.ts`). `resolveToken.ts` handles refresh. Keys (EC P-256) are loaded from env vars on Railway/Render via `startup/initKeys.ts`, or from disk paths via `PRIVATE_KEY_PATH`/`PUBLIC_KEY_PATH`.

`getPartnerToken()` in `teslaClient.ts` fetches a separate app-level token via `client_credentials` for endpoints that require partner auth (e.g. `/dx/charging/history`). Cached in memory with auto-refresh on expiry.

## Environment Variables

See `.env.example`. Key ones:
- `TESLA_CLIENT_ID`, `TESLA_CLIENT_SECRET`, `TESLA_REDIRECT_URI` — OAuth app credentials
- `SERVER_HOST` — public HTTPS URL (used in telemetry config pushed to vehicle)
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` — database
- `PRIVATE_KEY_BASE64`, `PUBLIC_KEY_BASE64` — EC keys as base64 (for cloud deployment)
- `ENABLE_TELEMETRY_EVENTS=true` — opt-in raw event logging to `fleet_telemetry_data`
