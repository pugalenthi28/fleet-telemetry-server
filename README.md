# fleet-telemetry-server

A Node.js / TypeScript server that receives real-time streaming telemetry from Tesla vehicles using the [Tesla Fleet API](https://developer.tesla.com/docs/fleet-api).

---

## Architecture

```
Tesla Vehicle
     │  WebSocket (wss://)  Protobuf frames
     ▼
  ngrok tunnel (local dev) / load-balancer (prod)
     │
     ▼
┌──────────────────────────────────┐
│  Express HTTP server (:3000)     │
│  ├─ /.well-known/… public key    │  ◄── Tesla domain verification
│  ├─ /auth/*          OAuth 2.0   │  ◄── Browser login flow
│  ├─ /api/vehicles    Fleet API   │  ◄── List vehicles
│  ├─ /api/vehicles/:id/configure-telemetry  ◄── Tell vehicle where to stream
│  └─ /api/telemetry/* data query  │
│                                  │
│  WebSocket server (same port)    │
│  └─ ws(s)://host/streaming       │  ◄── Receives Protobuf frames from vehicle
└──────────────────────────────────┘
```

---

## Quick-start (local testing with ngrok)

### 1 — Prerequisites

```bash
# Node.js ≥ 18, ngrok CLI
brew install ngrok          # or https://ngrok.com/download
ngrok config add-authtoken <your-ngrok-token>
```

### 2 — Install & generate keys

```bash
npm install
npm run generate-keys       # creates keys/private.pem and keys/public.pem
```

The **private key** is used to prove domain ownership to Tesla.
**Never commit it** — it is already in `.gitignore`.

### 3 — Start ngrok

```bash
ngrok http 3000
```

Note the `https://xxxx.ngrok-free.app` forwarding URL — you will use it in the next steps.

### 4 — Configure environment

```bash
cp .env.example .env
```

Edit `.env` and fill in:

| Variable | Value |
|----------|-------|
| `TESLA_CLIENT_ID` | From Tesla Developer Portal |
| `TESLA_CLIENT_SECRET` | From Tesla Developer Portal |
| `TESLA_REDIRECT_URI` | `https://<ngrok-url>/auth/callback` |
| `SERVER_HOST` | `https://<ngrok-url>` |

### 5 — Start the server

```bash
npm run dev
```

---

## Step-by-step: from zero to streaming data

### Step A — Verify the public key is reachable

Tesla will check this URL when you register your application:

```bash
curl https://<ngrok-url>/.well-known/appspecific/com.tesla.3p.public-key.pem
```

You should see your PEM-encoded EC public key.

### Step B — Register a Tesla Developer Application

1. Go to [developer.tesla.com](https://developer.tesla.com/en_US/dashboard)
2. Click **Create Application**
3. Fill in:
   - **Application name**: any name
   - **OAuth redirect URIs**: `https://<ngrok-url>/auth/callback`
   - **Origin domain** (for public key verification): `<ngrok-url>` (without `https://`)
4. Save → copy your **Client ID** and **Client Secret** into `.env`
5. Under the application's **Security** tab, paste your public key content from `keys/public.pem`, **or** Tesla will auto-fetch it from the `.well-known` URL you registered

### Step C — Authenticate your Tesla account

Open this URL in a browser:

```
http://localhost:3001/auth/login
```

This redirects to Tesla's OAuth login. Sign in with your Tesla account.
After approval you are redirected back to `/auth/callback`, which exchanges the code for tokens and stores them in memory.

Check status:
```bash
curl http://localhost:3001/auth/status
```

### Step D — Find your vehicle ID

```bash
curl http://localhost:3001/api/vehicles
```

Note the `id` (not `vehicle_id`) of the vehicle you want to stream from.

### Step E — Configure the vehicle to stream to this server

```bash
curl -X POST http://localhost:3000/api/vehicles/<id>/configure-telemetry
```

This calls `POST /api/1/vehicles/{id}/fleet_telemetry_config` on the Tesla Fleet API, pointing the vehicle at `<ngrok-url>:443`.

You can customise which fields and intervals are streamed:

```bash
curl -X POST http://localhost:3000/api/vehicles/<id>/configure-telemetry \
  -H "Content-Type: application/json" \
  -d '{
    "fields": {
      "VehicleSpeed":    { "interval_seconds": 5  },
      "BatteryLevel":    { "interval_seconds": 30 },
      "Latitude":        { "interval_seconds": 5  },
      "Longitude":       { "interval_seconds": 5  }
    }
  }'
```

### Step F — Accept the request in the Tesla mobile app

After Step E, a notification appears in the **Tesla app on your phone**:

> *"[App name] wants to access vehicle data"*

Tap **Allow**. The vehicle will then begin establishing the WebSocket connection to your server.

### Step G — Watch the data arrive

```bash
# Active WebSocket connections
curl http://localhost:3001/api/telemetry/connections

# Latest snapshot for your vehicle
curl http://localhost:3001/api/telemetry/latest/<VIN>

# Last 50 records
curl "http://localhost:3000/api/telemetry/data/<VIN>?limit=50"
```

Server logs will show each decoded frame:
```
[WS] Vehicle connected  (total: 1)
[WS] 5YJ3E1EA1JF000000 txid=abc123  fields=VehicleSpeed, Latitude, Longitude, BatteryLevel
```

---

## Telemetry fields reference

Full list of available fields:
[developer.tesla.com/docs/fleet-api/fleet-telemetry#data-parameters](https://developer.tesla.com/docs/fleet-api/fleet-telemetry#data-parameters)

Common fields used in this server by default:

| Field | Description |
|-------|-------------|
| `VehicleSpeed` | Speed in km/h |
| `Odometer` | Total km |
| `BatteryLevel` | State of charge (%) |
| `Latitude` / `Longitude` | GPS position |
| `Heading` | Compass heading |
| `PowerState` | Drive / Sleep / Charge |
| `ShiftState` | P / D / R / N |
| `InsideTemp` / `OutsideTemp` | °C |
| `ChargeState` | Charging state |
| `TimeToFullCharge` | Hours remaining |
| `SentryMode` | On / Off |

---

## Protobuf schema

The proto file at [protos/vehicle_data.proto](protos/vehicle_data.proto) must match what Tesla vehicles send.

To get Tesla's official, up-to-date proto:

```bash
curl -LO https://raw.githubusercontent.com/teslamotors/fleet-telemetry/main/protos/vehicle_data.proto
mv vehicle_data.proto protos/
```

---

## Moving to production

| Concern | Recommendation |
|---------|----------------|
| **Public HTTPS URL** | Deploy behind a reverse proxy (nginx, Caddy) with a valid TLS certificate, or use a cloud provider (Railway, Render, Fly.io) |
| **Token storage** | Replace `src/auth/tokenStore.ts` with Redis or a database |
| **Telemetry storage** | Replace `src/telemetry/store.ts` with InfluxDB, TimescaleDB, or BigQuery |
| **Port** | Set `SERVER_HOST` to your production HTTPS URL; vehicles always connect on 443 |
| **Private key** | Store in a secrets manager (AWS Secrets Manager, Vault) — never in the repo |

---

## Project structure

```
fleet-telemetry-server/
├── scripts/generate-keys.ts    Key generation (run once)
├── src/
│   ├── server.ts               Entry point (Express + WebSocket)
│   ├── config.ts               Env-var config
│   ├── auth/
│   │   ├── pkce.ts             PKCE helper (code_verifier / code_challenge)
│   │   ├── tokenStore.ts       In-memory OAuth token storage
│   │   └── teslaClient.ts      Axios client with auto token-refresh
│   ├── routes/
│   │   ├── wellKnown.ts        Serves the EC public key
│   │   ├── auth.ts             /auth/login, /auth/callback, /auth/status
│   │   ├── vehicles.ts         /api/vehicles
│   │   ├── telemetryConfig.ts  /api/vehicles/:id/configure-telemetry
│   │   └── telemetryData.ts    /api/telemetry/*
│   └── telemetry/
│       ├── wsServer.ts         WebSocket receiver + ACK sender
│       ├── decoder.ts          Protobuf decoder (protobufjs)
│       └── store.ts            In-memory telemetry ring buffer
├── protos/vehicle_data.proto   Tesla telemetry schema
└── keys/                       Generated key pair (gitignored)
```
