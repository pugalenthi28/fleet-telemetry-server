# fleet-telemetry-server

A Node.js / TypeScript server that receives **real-time streaming telemetry** from Tesla vehicles using the [Tesla Fleet API](https://developer.tesla.com/docs/fleet-api).

Deployed on Render.com at `https://fleet-telemetry-server.onrender.com`.

---

## Architecture

```
Tesla Vehicle
     │  WebSocket (wss://)  FlatBuffers + Protobuf frames
     ▼
  Render.com (TLS termination, port 443 → 3000)
     │
     ▼
┌────────────────────────────────────────────────────┐
│  Express HTTP server (:3000)                       │
│  ├─ /.well-known/…/com.tesla.3p.public-key.pem     │  ◄── Tesla domain verification
│  ├─ /auth/*                 OAuth 2.0 + PKCE        │  ◄── Browser login flow
│  ├─ /api/vehicles           Fleet API proxy         │  ◄── List vehicles
│  ├─ /api/vehicles/:id/configure-telemetry           │  ◄── Tell vehicle where to stream
│  └─ /api/telemetry/*        data + monitor          │
│                                                    │
│  WebSocket server (same port)                      │
│  └─ wss://host/ and wss://host/streaming            │  ◄── FlatBuffers frames from vehicle
└────────────────────────────────────────────────────┘
     │
     ▼
  In-memory telemetry store  (ring buffer 1000 records/VIN)
  Vehicle monitor             (trip & charge session detection)
```

### Wire format

Tesla vehicles **do not send raw protobuf** directly over the WebSocket. They wrap it in a binary FlatBuffers envelope:

```
FlatbuffersEnvelope (messageType=4)
  └─ FlatbuffersStream
       ├─ payload  (bytes) ← protobuf vehicle_data.Payload
       └─ deviceId (bytes) ← VIN string
```

`src/telemetry/flatbuffers-frame.ts` manually parses this binary envelope without code generation and returns the inner protobuf bytes + VIN. After decoding, the server sends back a FlatBuffers ACK:

```
FlatbuffersEnvelope (messageType=5, same txid)
  └─ FlatbuffersStreamAck (empty)
```

---

## Prerequisites

- Node.js ≥ 18
- A Tesla Developer account with an approved application
- For **newer vehicles (apiVersion ≥ 3, e.g. 2026 Model Y)**: the [vehicle-command proxy](https://github.com/teslamotors/vehicle-command) Go binary

---

## Setup (local development)

### 1 — Install & generate keys

```bash
npm install
npm run generate-keys   # creates keys/private.pem and keys/public.pem
```

The **private key** signs JWS commands to the vehicle-command proxy.  
**Never commit it** — it is already in `.gitignore`.

### 2 — Configure environment

```bash
cp .env.example .env
```

Edit `.env`:

| Variable | Description |
|----------|-------------|
| `TESLA_CLIENT_ID` | From Tesla Developer Portal |
| `TESLA_CLIENT_SECRET` | From Tesla Developer Portal |
| `TESLA_REDIRECT_URI` | `https://<your-host>/auth/callback` |
| `SERVER_HOST` | `https://<your-host>` (no trailing slash) |
| `VEHICLE_COMMAND_PROXY_URL` | `https://localhost:4443` (if using proxy) |
| `SERVER_CA_CERT` | (optional) PEM CA chain — overrides `keys/server-ca.pem` |

### 3 — CA certificate for Tesla

Tesla requires a valid `ca` field in `fleet_telemetry_config`. This must be the PEM certificate chain of the CA that signed your server's TLS certificate.

**Render.com** uses Google Trust Services. The chain is already committed at `keys/server-ca.pem` (WE1 intermediate + GTS Root R4). If you deploy elsewhere, replace this file with your host's CA chain:

```bash
# Extract CA chain from your server's certificate
openssl s_client -connect your-host.com:443 -showcerts </dev/null 2>/dev/null \
  | awk '/BEGIN CERTIFICATE/,/END CERTIFICATE/' \
  > keys/server-ca.pem
```

### 4 — (Newer vehicles only) Start vehicle-command proxy

apiVersion ≥ 3 vehicles (2026+ Model Y and others) require `fleet_telemetry_config` to be JWS-signed by your app's private key. Tesla's Fleet API returns **HTTP 404** if you call the endpoint directly without signing — the unsigned path no longer exists for these vehicles.

You must run Tesla's Go proxy locally when pushing the config:

```bash
# Build once (requires Go 1.21+)
git clone https://github.com/teslamotors/vehicle-command
cd vehicle-command
go build ./cmd/tesla-http-proxy

# Generate a self-signed TLS cert for the proxy (one-time)
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 \
  -keyout proxy-tls.key -out proxy-tls.crt -days 3650 -nodes \
  -subj "/CN=localhost"

# Run — points at your app's private key for JWS signing
~/vehicle-command/tesla-http-proxy \
  -key-file keys/private.pem \
  -cert ~/vehicle-command/proxy-tls.crt \
  -tls-key ~/vehicle-command/proxy-tls.key \
  -port 4443 -verbose
```

Set `VEHICLE_COMMAND_PROXY_URL=https://localhost:4443` in `.env`.

When the proxy is active, `POST /api/vehicles/:id/configure-telemetry` routes through it — the body becomes `{ vins: [VIN], config: {...} }` sent to `/api/1/vehicles/fleet_telemetry_config` (no vehicle ID in path; proxy requires this exact path length).

### 5 — Start the server

```bash
npm run dev
```

---

## Step-by-step: from zero to streaming data

### Step A — Register a Tesla Developer Application

1. Go to [developer.tesla.com](https://developer.tesla.com/en_US/dashboard) → **Create Application**
2. Set **OAuth redirect URI** to `https://<your-host>/auth/callback`
3. Set **Origin domain** to `<your-host>` (without `https://`)
4. Copy **Client ID** and **Client Secret** into `.env`
5. Tesla auto-fetches your public key from `/.well-known/appspecific/com.tesla.3p.public-key.pem`

Verify:
```bash
curl https://<your-host>/.well-known/appspecific/com.tesla.3p.public-key.pem
```

### Step B — Authenticate your Tesla account

Open in a browser:
```
https://<your-host>/auth/login
```

This starts the OAuth 2.0 + PKCE flow. After approving in the Tesla login page you are redirected to `/auth/callback`, which stores the access + refresh tokens in memory. **Do not copy-paste the token** — the server stores it automatically via the callback.

Required OAuth scopes: `openid offline_access vehicle_device_data vehicle_cmds vehicle_charging_cmds vehicle_location`

`vehicle_location` is needed for the `Location` telemetry field (trip start/end + charge location). If your token was issued before this scope was added, re-auth via `/auth/login` to pick it up.

Check status:
```bash
curl https://<your-host>/auth/status
# → { "authenticated": true, "expiresAt": "..." }
```

If you need to clear a bad token:
```bash
curl -X POST https://<your-host>/auth/logout
```

### Step C — Find your vehicle ID

```bash
curl https://<your-host>/api/vehicles
```

Note the `id` field (not `vehicle_id`).

### Step D — Configure the vehicle to stream to this server

One command does everything — the script auto-starts the proxy and local server if they aren't already running, pushes the config, then stops what it started:

```bash
./scripts/configure-telemetry.sh <vehicle_id>
```

The script will:
1. Start the vehicle-command proxy on `:4443` (if not already running)
2. Start the local server on `:3001` (if not already running)
3. Open `http://localhost:3001/auth/login` in your browser if not authenticated
4. Push `fleet_telemetry_config` via the proxy (required for apiVersion ≥ 3 vehicles)
5. Stop any processes it started on exit

On success:
```json
{ "message": "Telemetry configured successfully", "response": { "updated_vehicles": 1 } }
```

### Step E — Accept in the Tesla mobile app

A push notification appears:  
*"[App name] wants to access vehicle data"*  
Tap **Allow**. The vehicle connects to `wss://<your-host>/streaming` within ~30 seconds.

### Step F — Watch data arrive

```bash
# Active WebSocket connections
curl https://<your-host>/api/telemetry/connections

# Merged current state for your vehicle
curl https://<your-host>/api/telemetry/latest/<VIN>

# Trip & charge session monitor status
curl https://<your-host>/api/telemetry/monitor

# Last 50 raw records
curl "https://<your-host>/api/telemetry/data/<VIN>?limit=50"

# Vehicle status (partner token, VIN auto-resolved)
curl https://<your-host>/api/vehicle/status

# Live SSE stream (VIN auto-resolved from connected vehicles)
curl -N https://<your-host>/api/telemetry/stream

# Mobile-friendly live view — open this URL directly in any browser
https://<your-host>/api/telemetry/live
```

Server logs show each decoded frame with the full merged vehicle state:

```
[WS] 7SAYGDEE2TF426856  txid=00000001  ts=2025-01-01T12:00:00.000Z  (delta: Soc, PackVoltage, Gear)
  BatteryLevel             85.2
  DetailedChargeState      "DetailedChargeStateDisconnected"
  Gear                     "ShiftStateP"
  Odometer                 12345.6
  PackVoltage              395.1
  Soc                      85.2
  VehicleSpeed             0
  ...
```

---

## Vehicle monitor (trip & charge tracking)

`src/telemetry/vehicleMonitor.ts` is called on every incoming record. It detects state transitions and logs events without any database.

### Trip detection

Triggered by `Gear` field changes:

```
[Monitor] TRIP STARTED   vin=7SAYGDEE2TF426856  gear=ShiftStateD  odometer=12345.6mi  soc=85.2%  time=12:01:00
[Monitor] TRIP PROGRESS  vin=7SAYGDEE2TF426856  distance=5.23mi  soc_used=2.1%  speed=42.0mph  duration=8m 12s
[Monitor] TRIP ENDED     vin=7SAYGDEE2TF426856  gear=ShiftStateP  distance=12.45mi  soc_used=4.8%  duration=18m 30s  odometer=12358.0mi
```

- Park/unknown → D/R/N = **trip started** (records start odometer + SoC)
- D/R/N → P/SNA = **trip ended** (logs distance, SoC used, duration)
- D → R or R → D = **gear change** logged
- Progress logged every **5 minutes** while driving

### Charging detection

Triggered by `DetailedChargeState` field changes:

```
[Monitor] CHARGE STARTED vin=7SAYGDEE2TF426856  state=DetailedChargeStateCharging  soc=42.0%  energy=28.50kWh  power=11.5kW
[Monitor] CHARGE PROGRESS vin=7SAYGDEE2TF426856  soc=68.3%  soc_gained=+26.3%  power=11.5kW  duration=1h 22m
[Monitor] CHARGE ENDED   vin=7SAYGDEE2TF426856  state=DetailedChargeStateComplete  soc_gained=+58.0%  energy_added=39.20kWh  duration=3h 10m  soc=100.0%
```

- Disconnected/Stopped → Charging/Starting = **charge started**
- Charging → Complete/Stopped/Disconnected = **charge ended** (logs SoC gained, kWh added)
- Progress logged every **5 minutes** while charging

### Monitor API

```bash
curl https://<your-host>/api/telemetry/monitor
```

```json
{
  "monitor": {
    "7SAYGDEE2TF426856": {
      "gear": "ShiftStateD",
      "detailedChargeState": "DetailedChargeStateDisconnected",
      "odometer": 12358.0,
      "soc": 80.5,
      "speed": 42.0,
      "onTrip": true,
      "tripStartedAt": "2025-01-01T12:01:00.000Z",
      "charging": false
    }
  }
}
```

---

## Telemetry fields

All fields must exactly match the Tesla proto enum in `protos/vehicle_data.proto`.

Default fields configured by `POST /api/vehicles/:id/configure-telemetry` (defined in `src/routes/telemetryConfig.ts`):

| Category | Field | Interval |
|----------|-------|----------|
| Motion | `VehicleSpeed`, `Gear` | 30 s |
| Motion | `Odometer` | 60 s |
| Battery | `Soc`, `BatteryLevel`, `EnergyRemaining` | 60 s |
| Battery | `EstBatteryRange`, `RatedRange`, `IdealBatteryRange` | 120 s |
| Charging | `DetailedChargeState`, `ChargeAmps`, `ChargerVoltage`, `ACChargingPower`, `DCChargingPower`, `ChargePortDoorOpen` | 60 s |
| Charging | `ACChargingEnergyIn`, `DCChargingEnergyIn`, `ChargeLimitSoc`, `TimeToFullCharge` | 120 s |
| Climate | `InsideTemp`, `OutsideTemp` | 120 s |
| Lifetime | `LifetimeEnergyUsed`, `LifetimeEnergyGainedRegen` | 60 s |
| TPMS | `TpmsPressureFl`, `TpmsPressureFr`, `TpmsPressureRl`, `TpmsPressureRr` | 300 s |
| Misc | `Locked` | 120 s |
| Misc | `VehicleName`, `Version` | 600 s |

`ACChargingPower` / `DCChargingPower` give real-time kW (L1 ~1.4 kW, L2 ~7–48 kW, Supercharger 100–250 kW). If a vehicle doesn't report these fields, `charger_power` falls back to the tick-to-tick energy rate derived from `ACChargingEnergyIn` / `DCChargingEnergyIn`.

### Lock status

`Locked` is stored in **`fleet_telemetry_state`** (column `locked boolean`) and updated whenever a `Locked` frame arrives (every 120 s). This is the right table to query for current lock status since it always holds the latest known value, even across server restarts.

`fleet_telemetry_data` also records `locked` per-row but only in rows where a `Locked` field was in that specific telemetry frame — all other rows have `null`. The value appearing as `false` is expected when the car is unlocked, which is the normal state between drives.

---

## API reference

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check |
| `GET` | `/.well-known/appspecific/com.tesla.3p.public-key.pem` | EC public key for Tesla domain verification |
| `GET` | `/auth/login` | Start OAuth flow (open in browser) |
| `GET` | `/auth/callback` | OAuth redirect handler |
| `GET` | `/auth/status` | Show stored token info |
| `POST` | `/auth/logout` | Clear stored tokens |
| `GET` | `/api/vehicles` | List vehicles via Tesla Fleet API (OAuth token) |
| `GET` | `/api/vehicle/status` | Vehicle status via Tesla Fleet API (VIN auto-resolved from store → DB; `?vin=` to override) |
| `GET` | `/api/1/vehicle/vehicle_data` | Full vehicle state (charge, drive, climate…) — VIN auto-resolved from `fleet_vehicles` |
| `GET` | `/api/1/vehicles/:vin/vehicle_data` | Same as above with explicit VIN; optional `?endpoints=charge_state;drive_state;…` |
| `POST` | `/api/vehicles/:id/configure-telemetry` | Send `fleet_telemetry_config` to vehicle |
| `DELETE` | `/api/vehicles/:id/configure-telemetry` | Remove telemetry config |
| `GET` | `/api/charging/history` | Charging history via Tesla Fleet API (partner token; `?vin=&startTime=&endTime=&pageNo=&pageSize=`) |
| `GET` | `/api/telemetry/connections` | Active WebSocket connections |
| `GET` | `/api/telemetry/vins` | VINs with received telemetry |
| `GET` | `/api/telemetry/data` | All recent records (query `?limit=N`) |
| `GET` | `/api/telemetry/data/:vin` | Records for one vehicle |
| `GET` | `/api/telemetry/latest/:vin` | Merged current state for one vehicle |
| `GET` | `/api/telemetry/monitor` | Trip & charge session status for all VINs |
| `GET` | `/api/telemetry/stream` | SSE stream — VIN auto-resolved from connected vehicles (`?vin=` to override) |
| `GET` | `/api/telemetry/stream/:vin` | SSE stream for a specific VIN |
| `GET` | `/api/telemetry/live` | Mobile-friendly HTML page rendering the SSE stream live in a browser (`?vin=` to override) |

### VIN auto-resolution

All endpoints that need a VIN resolve it in this order:
1. Explicit `?vin=` query param or `:vin` path segment (if provided)
2. Live WebSocket connection (in-memory telemetry store)
3. Most-recently-seen row in `fleet_vehicles` table

This means most endpoints work with no arguments once at least one vehicle has ever connected.

---

## Project structure

```
fleet-telemetry-server/
├── scripts/
│   ├── generate-keys.ts           Key generation (run once)
│   └── migrate-from-neon.ts       One-time Neon → Supabase migration (charging_sessions + trips)
├── src/
│   ├── server.ts                  Entry point (Express + WebSocket)
│   ├── config.ts                  Env-var config + OAuth scopes
│   ├── auth/
│   │   ├── pkce.ts                PKCE code_verifier / code_challenge
│   │   ├── tokenStore.ts          In-memory OAuth token storage
│   │   ├── teslaClient.ts         Axios client with auto token-refresh
│   │   └── resolveToken.ts        Extract token from session/header
│   ├── routes/
│   │   ├── wellKnown.ts           Serves EC public key for Tesla
│   │   ├── auth.ts                /auth/login, /callback, /status, /logout
│   │   ├── vehicles.ts            /api/vehicles (OAuth token)
│   │   ├── vehicleStatus.ts       /api/vehicle/status (partner token, auto-VIN)
│   │   ├── charging.ts            /api/charging/history (partner token)
│   │   ├── telemetryConfig.ts     /api/vehicles/:id/configure-telemetry
│   │   │                          Handles vehicle-command proxy routing for
│   │   │                          apiVersion ≥ 3 (2026+ Model Y etc.)
│   │   ├── telemetryData.ts       /api/telemetry/* (connections, stream, latest…)
│   │   ├── register.ts            /api/register
│   │   └── diagnostics.ts         /api/vehicles/:id/diagnostics
│   ├── startup/
│   │   └── initKeys.ts            Load keys from env vars on startup (Render)
│   └── telemetry/
│       ├── flatbuffers-frame.ts   Manual FlatBuffers parser (no code gen)
│       │                          Unwraps FlatbuffersEnvelope → FlatbuffersStream
│       │                          → protobuf bytes + VIN (DeviceId field 4)
│       │                          Builds binary FlatBuffers ACK (messageType=5)
│       ├── decoder.ts             Protobuf decoder (protobufjs)
│       ├── store.ts               In-memory ring buffer (1000 records/VIN)
│       │                          getMergedState() returns all fields seen so far
│       ├── wsServer.ts            WebSocket receiver, ACK sender, state logger
│       └── vehicleMonitor.ts      Log-only trip & charge session detector
├── protos/vehicle_data.proto      Tesla telemetry schema
│                                  (allow_alias = true — needed for InsideTemp_2/OutsideTemp_2)
└── keys/
    ├── private.pem                App private key (gitignored)
    ├── public.pem                 App public key (gitignored)
    └── server-ca.pem              TLS CA chain for Render.com (WE1 + GTS Root R4)
                                   Required by Tesla in fleet_telemetry_config
```

---

## Database schema additions

Run these once in the Supabase SQL editor before deploying the latest server version:

```sql
-- EPA factory range per vehicle model (used for battery health calculation)
ALTER TABLE fleet_vehicles ADD COLUMN IF NOT EXISTS epa_range_miles numeric;

-- Battery health written at charge close
ALTER TABLE fleet_charging_sessions ADD COLUMN IF NOT EXISTS battery_health numeric;

-- Trip enrichment: temperatures, TPMS, lifetime energy (start + end per trip)
ALTER TABLE fleet_trips ADD COLUMN IF NOT EXISTS start_inside_temp_c numeric;
ALTER TABLE fleet_trips ADD COLUMN IF NOT EXISTS end_inside_temp_c numeric;
ALTER TABLE fleet_trips ADD COLUMN IF NOT EXISTS start_outside_temp_c numeric;
ALTER TABLE fleet_trips ADD COLUMN IF NOT EXISTS end_outside_temp_c numeric;
ALTER TABLE fleet_trips ADD COLUMN IF NOT EXISTS start_lifetime_energy_used_kwh numeric;
ALTER TABLE fleet_trips ADD COLUMN IF NOT EXISTS end_lifetime_energy_used_kwh numeric;
ALTER TABLE fleet_trips ADD COLUMN IF NOT EXISTS start_lifetime_energy_regen_kwh numeric;
ALTER TABLE fleet_trips ADD COLUMN IF NOT EXISTS end_lifetime_energy_regen_kwh numeric;
ALTER TABLE fleet_trips ADD COLUMN IF NOT EXISTS start_tpms_fl_bar numeric;
ALTER TABLE fleet_trips ADD COLUMN IF NOT EXISTS end_tpms_fl_bar numeric;
ALTER TABLE fleet_trips ADD COLUMN IF NOT EXISTS start_tpms_fr_bar numeric;
ALTER TABLE fleet_trips ADD COLUMN IF NOT EXISTS end_tpms_fr_bar numeric;
ALTER TABLE fleet_trips ADD COLUMN IF NOT EXISTS start_tpms_rl_bar numeric;
ALTER TABLE fleet_trips ADD COLUMN IF NOT EXISTS end_tpms_rl_bar numeric;
ALTER TABLE fleet_trips ADD COLUMN IF NOT EXISTS start_tpms_rr_bar numeric;
ALTER TABLE fleet_trips ADD COLUMN IF NOT EXISTS end_tpms_rr_bar numeric;

-- New streaming fields stored in raw event log (opt-in via ENABLE_TELEMETRY_EVENTS=true)
ALTER TABLE fleet_telemetry_data ADD COLUMN IF NOT EXISTS lifetime_energy_used_kwh numeric;
ALTER TABLE fleet_telemetry_data ADD COLUMN IF NOT EXISTS lifetime_energy_regen_kwh numeric;
ALTER TABLE fleet_telemetry_data ADD COLUMN IF NOT EXISTS tpms_fl_bar numeric;
ALTER TABLE fleet_telemetry_data ADD COLUMN IF NOT EXISTS tpms_fr_bar numeric;
ALTER TABLE fleet_telemetry_data ADD COLUMN IF NOT EXISTS tpms_rl_bar numeric;
ALTER TABLE fleet_telemetry_data ADD COLUMN IF NOT EXISTS tpms_rr_bar numeric;

-- New streaming fields stored in current-state snapshot
ALTER TABLE fleet_telemetry_state ADD COLUMN IF NOT EXISTS lifetime_energy_used_kwh numeric;
ALTER TABLE fleet_telemetry_state ADD COLUMN IF NOT EXISTS lifetime_energy_regen_kwh numeric;
ALTER TABLE fleet_telemetry_state ADD COLUMN IF NOT EXISTS tpms_fl_bar numeric;
ALTER TABLE fleet_telemetry_state ADD COLUMN IF NOT EXISTS tpms_fr_bar numeric;
ALTER TABLE fleet_telemetry_state ADD COLUMN IF NOT EXISTS tpms_rl_bar numeric;
ALTER TABLE fleet_telemetry_state ADD COLUMN IF NOT EXISTS tpms_rr_bar numeric;
```

Then set the EPA range for each vehicle (check Tesla's spec page for your exact trim):

```sql
-- Example: 2026 Model Y AWD Juniper = 327 miles EPA
UPDATE fleet_vehicles SET epa_range_miles = 327 WHERE vin = '<YOUR_VIN>';
```

### Battery health calculation

Computed automatically at the end of every charge session using the `IdealBatteryRange` telemetry field and the vehicle's EPA range:

```
current_max_range  = ideal_range_mi / (end_soc_pct / 100)
battery_health_%   = (current_max_range / epa_range_miles) × 100
```

Example — 90% SOC, 290.5 mi ideal range, 327 mi EPA:

```
current_max_range = 290.5 / 0.90 = 322.78 mi
battery_health    = (322.78 / 327) × 100 = 98.71%
```

`battery_health` is `null` when `epa_range_miles` is not set, or when `IdealBatteryRange` / SOC were not available at charge close.

### Trip speed accuracy

- **`avg_speed`** — computed from `distance_miles / duration_hours` at trip close (reliable across WS reconnects).
- **`max_speed`** — written to `fleet_trips` whenever a new peak is observed during the trip and restored on reconnect, so a 70 mph peak recorded before a WS drop is preserved even if the vehicle reconnects at 5 mph.

---

## Data migration (Neon → Supabase)

`scripts/migrate-from-neon.ts` migrates historical `charging_sessions` and `trips` from the legacy Neon database into the Supabase `fleet_` tables.

```bash
NEON_DATABASE_URL="postgresql://user:pass@host/db?sslmode=verify-full" npm run migrate-neon
```

**Before running:**
1. Delete existing rows in `fleet_charging_sessions` if you want a clean re-import (the script upserts by ID).
2. `fleet_trips` rows are safe — the script inserts without original IDs so Supabase auto-assigns them above your existing SUPA trip IDs.

**After running:**
Fix the charging sessions sequence so new inserts don't collide with migrated IDs:
```sql
SELECT setval('fleet_charging_sessions_id_seq', (SELECT MAX(id) FROM fleet_charging_sessions));
```

**Connection note:** The script parses the Neon URL and sets `ssl.servername` explicitly. This is required for Neon's SNI-based proxy — omitting it causes the Postgres handshake to time out even though the TCP connection succeeds.

---

## Known issues / notes

### apiVersion ≥ 3 vehicles (2024+ models)

Tesla requires `fleet_telemetry_config` to be JWS-signed for these vehicles. Calling the endpoint directly (without the proxy) returns **HTTP 404** — the unsigned path no longer exists in Tesla's Fleet API. The vehicle-command proxy handles signing transparently. The proxy expects:
- Path: `/api/1/vehicles/fleet_telemetry_config` (no vehicle ID — exactly 5 path segments)
- Body: `{ vins: ["VIN_STRING"], config: { hostname, port, fields, ca } }`

The config persists on the vehicle across server restarts — you only need to re-push when adding new fields or changing intervals.

### CA certificate requirement

Tesla validates the `ca` field in the JWS claims against the certificate chain your server presents. An empty or invalid PEM causes:
```
"ca is not a valid PEM"
```
The `keys/server-ca.pem` file must contain the full intermediate + root chain.

### Location field needs re-auth

`Location` requires the `vehicle_location` OAuth scope. If telemetry was configured with a token issued before this scope was added, the vehicle won't send it. To enable:
1. Re-authenticate via `/auth/login` (scope is already requested in `src/config.ts`)
2. Re-run `POST /api/vehicles/:id/configure-telemetry` so the vehicle picks up the updated field list

Trip `start_location`/`end_location` and charging session `location` are populated automatically once the field streams — no other code changes needed.

### Proto allow_alias

`protos/vehicle_data.proto` contains `option allow_alias = true` in the `Field` enum. This is required because `InsideTemp_2` and `OutsideTemp_2` share the same numbers (85, 86) as `InsideTemp` and `OutsideTemp`. Without this option, protobufjs throws:
```
Error: duplicate id 85 in Enum Field
```

---

## Deployment (Render.com)

1. Push to GitHub — Render auto-deploys on push to `main`
2. Set environment variables in Render dashboard:
   - `TESLA_CLIENT_ID`, `TESLA_CLIENT_SECRET`
   - `TESLA_REDIRECT_URI` = `https://fleet-telemetry-server.onrender.com/auth/callback`
   - `SERVER_HOST` = `https://fleet-telemetry-server.onrender.com`
   - `PRIVATE_KEY_BASE64` = `base64 -i keys/private.pem | tr -d '\n'`
   - `PUBLIC_KEY_BASE64` = `base64 -i keys/public.pem | tr -d '\n'`
   - `SERVER_CA_CERT` = contents of `keys/server-ca.pem` (or leave unset to use the committed file)
3. After deploy, visit `https://fleet-telemetry-server.onrender.com/auth/login` to authenticate
4. Run `POST /api/vehicles/:id/configure-telemetry` from your local machine (with the proxy running) to configure the vehicle

Free-tier Render instances sleep after 15 minutes of inactivity — use a paid plan or a cron ping for production.

---

## Production considerations

| Concern | Recommendation |
|---------|----------------|
| **Token storage** | Replace `src/auth/tokenStore.ts` with Redis or a database |
| **Telemetry storage** | Replace `src/telemetry/store.ts` with InfluxDB, TimescaleDB, or BigQuery |
| **Vehicle monitor** | Extend `vehicleMonitor.ts` to write trip/charge events to a DB |
| **Private key** | Store in a secrets manager (AWS Secrets Manager, Vault) |
| **Render sleep** | Use a paid instance or a health-check cron to prevent cold starts |
