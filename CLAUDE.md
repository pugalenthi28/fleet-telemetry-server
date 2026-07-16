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
- **Charge insert retry**: `insertChargingSession` can fail with a duplicate key if the DB sequence is out of sync (e.g. after a bulk migration with explicit IDs). `ChargeSessionState` carries `insertFailed: boolean` — set when the insert returns null. The 5-minute progress tick checks this flag and retries the insert using `energyUsedSinceLastChargeKwh` stored on the state at open time. Using the stored value is critical because `sumAndMarkTripsAccounted` already marked those trips `charge_accounted = true` before the first insert attempt, so calling it again would return 0.
- **Gap trip suppression**: Gap trips (created when the server reconnects mid-drive and detects an odometer jump) are suppressed if the silent period was under **5 minutes** (`GAP_TRIP_SUPPRESS_MS = 300_000 ms`). This guard applies to **both** gap-trip creation paths — the catch-up section (gear already D/R on reconnect) and the gear-transition section (P→D fires while no active trip exists). Short gaps are almost always a WS reconnect, not a real untracked drive. Raised from 2 min after repeated spurious 2–4 min gaps were observed during normal WS cycling.

### Database (Supabase / `repository.ts`)

Tables: `fleet_vehicles`, `fleet_telemetry_state`, `fleet_telemetry_data`, `fleet_trips`, `fleet_charging_sessions`, `fleet_daily_summary`, `fleet_software_versions`, `fleet_auth_tokens`, `fleet_api_tracking`.

`fleet_telemetry_data` writes are opt-in — only inserted when `ENABLE_TELEMETRY_EVENTS=true`. State snapshots (`fleet_telemetry_state`) and session records are always written.

Both state and raw-event inserts are **throttled in `wsServer.ts`** (5-minute intervals) to avoid Supabase rate limits.

#### `fleet_charging_sessions` notable columns
- `start_odometer`, `end_odometer` — written at session open; **re-confirmed and updated at close** so odometer values are always accurate even if stale at open time.
- `miles_since_last_charge` — written at session open (DB-backed if in-memory state is missing) and re-confirmed at close.
- `energy_used_since_last_charge_kwh` — sum of `energy_used_kwh` from all `fleet_trips` rows with `charge_accounted = null` at the moment the session opens. Those trips are marked `charge_accounted = true` in the same awaited update (see `sumAndMarkTripsAccounted`). **Never fire-and-forget the mark** — if it fails, later charges re-sum the same trips and inflate this field. Also ensure `tr_geocode_fleet_trips` has a `WHEN` clause on location changes only; without it, Nominatim runs on every trip UPDATE and the mark hits statement timeout. If the initial charge insert fails and is retried, reuse `ChargeSessionState.energyUsedSinceLastChargeKwh` — **do not** call `sumAndMarkTripsAccounted` again on retry as the trips are already marked.
- `end_ideal_range_mi`, `end_rated_range_mi` — written at session close from the latest `IdealBatteryRange` / `RatedRange` telemetry fields.

#### `fleet_trips.start_address` / `end_address` (reverse geocoding)
Populated entirely in Postgres, not application code — see the `tr_geocode_fleet_trips` trigger + `process_trip_geocoding()` function at the bottom of `supabase/schema.sql`. On insert/update of `fleet_trips`, if `start_location`/`end_location` (written by `vehicleMonitor.ts`) changed, the trigger calls Nominatim's reverse-geocoding API synchronously via the `http` extension and writes a short address (first two comma-separated segments of `display_name`) into `start_address`/`end_address`. On exception it falls back to `'Location Fetch Error'` so a geocoding failure never blocks a trip write (a non-200 response with no exception just leaves the column unset). The trigger's `WHEN` clause only fires when a location actually changed — trips are updated frequently (`last_seen_at` every 5 min, `max_speed`, backfills) and without that guard every one of those writes would re-hit Nominatim's rate-limited API. Note the function re-geocodes both sides whenever both are non-null regardless of which one changed (e.g. closing a trip re-fetches `start_address` too). Not reflected anywhere in `repository.ts` — query these columns directly from Supabase if building a UI that needs a human-readable trip location.

#### Pacific-time display columns (`*_pst`)
Every relevant table (`fleet_vehicles`, `fleet_trips`, `fleet_charging_sessions`, `fleet_telemetry_data`, `fleet_telemetry_state`, `fleet_daily_summary`, `fleet_software_versions`) has companion `*_pst` columns (e.g. `fleet_trips.start_time_pst`, `end_time_pst`, `created_at_pst`, `last_seen_at_pst`) maintained by the `sync_pst_timestamps()` trigger at the bottom of `supabase/schema.sql`. **The canonical UTC columns (`start_time`, `end_time`, etc.) are never touched or read differently** — `vehicleMonitor.ts` depends on comparing them against `Date.now()` for stale-session detection, gap-trip suppression, and progress-log throttling; shifting those would silently corrupt that logic by the Pacific/UTC offset. The `*_pst` columns are TIMESTAMP-without-timezone, computed via `AT TIME ZONE 'America/Los_Angeles'` (so they reflect PST/PDT correctly across DST, not a fixed offset), for display/browsing only — not used or read anywhere in `repository.ts` or application code. `fleet_api_tracking` deliberately has no PST columns since Tesla bills by UTC day.

#### `fleet_software_versions` table
Tracks every OTA firmware update. One row per `(vin, current_version)` with a unique constraint `fleet_software_versions_vin_version_key`. Included in `schema.sql` — no separate migration needed for new installs.

### API Endpoints

#### `GET /api/telemetry/live`
Mobile-friendly HTML debug page. Opens a browser page that connects to the SSE stream via `EventSource` and renders all telemetry fields as a live-updating card grid. Accepts `?vin=` query param. Use this instead of opening the raw `/api/telemetry/stream` URL on mobile — browsers don't render `text/event-stream` responses progressively.

#### `GET /api/charging/history`
Proxies Tesla Fleet API `/api/1/dx/charging/history` using a **partner token** (client credentials — not the user OAuth token). Returns Supercharger sessions only; L1/L2 home charging is not available via Tesla's API.

Query params (all optional): `vin`, `startTime` (ISO 8601), `endTime` (ISO 8601), `pageNo`, `pageSize`.

Partner token is fetched via `client_credentials` grant and cached in memory (`teslaClient.ts: getPartnerToken()`).

### Auth (`auth/`)

Tesla OAuth 2.0 + PKCE flow. Tokens stored in memory (`tokenStore.ts`). `resolveToken.ts` handles refresh. Keys (EC P-256) are loaded from env vars on Railway/Render via `startup/initKeys.ts`, or from disk paths via `PRIVATE_KEY_PATH`/`PUBLIC_KEY_PATH`.

`getPartnerToken()` in `teslaClient.ts` fetches a separate app-level token via `client_credentials` for endpoints that require partner auth (e.g. `/dx/charging/history`). Cached in memory with auto-refresh on expiry.

### Migration Script (`scripts/migrate-from-neon.ts`)

One-time migration from the legacy Neon database to Supabase. Run with:
```bash
NEON_DATABASE_URL="postgresql://..." npm run migrate-neon
```

Key behaviors:
- **Charging sessions** — upserted with original Neon IDs (`ignoreDuplicates: false`). Delete existing rows in `fleet_charging_sessions` first. After migration, run `SELECT setval('fleet_charging_sessions_id_seq', (SELECT MAX(id) FROM fleet_charging_sessions));` in the Supabase SQL editor to fix the sequence.
- **Trips** — inserted without original IDs (Supabase auto-assigns). This avoids collision with existing native-Supabase trips. No sequence reset needed.
- **Connection**: uses explicit `host/user/password/database` params with `ssl: { rejectUnauthorized: false, servername: <host> }` — required for Neon's SNI-based proxy routing. Do not use `ssl: { rejectUnauthorized: false }` without `servername` or the connection will time out at the Postgres handshake.

## Environment Variables

See `.env.example`. Key ones:
- `TESLA_CLIENT_ID`, `TESLA_CLIENT_SECRET`, `TESLA_REDIRECT_URI` — OAuth app credentials
- `SERVER_HOST` — public HTTPS URL (used in telemetry config pushed to vehicle)
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` — database
- `PRIVATE_KEY_BASE64`, `PUBLIC_KEY_BASE64` — EC keys as base64 (for cloud deployment)
- `ENABLE_TELEMETRY_EVENTS=true` — opt-in raw event logging to `fleet_telemetry_data`
