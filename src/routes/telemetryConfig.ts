import { Router, Request, Response } from "express";
import { AxiosInstance } from "axios";
import fs from "fs";
import path from "path";
import { config } from "../config";
import { resolveToken } from "../auth/resolveToken";
import { createTeslaApiClient } from "../auth/teslaClient";

// CA cert for the telemetry server's TLS chain (used by vehicles to verify WebSocket TLS).
// Read once at startup. Falls back to SERVER_CA_CERT env var (base64 or plain PEM).
function loadServerCa(): string | undefined {
  const envCa = process.env.SERVER_CA_CERT;
  if (envCa) return envCa.replace(/\\n/g, "\n");
  const caPath = path.resolve(__dirname, "../../keys/server-ca.pem");
  if (fs.existsSync(caPath)) return fs.readFileSync(caPath, "utf8");
  return undefined;
}

const SERVER_CA = loadServerCa();

const router = Router();

// Field names must exactly match the Tesla proto enum — see protos/vehicle_data.proto
// Kept to fields actually used by the trip/charge monitor and API display (~23 vs the original ~44).
// Fewer fields = fewer signals per vehicle reconnect (each field value = 1 billable Tesla API unit).
const DEFAULT_FIELDS: Record<string, { interval_seconds: number }> = {
  // ── Motion ────────────────────────────────────────────────────────────────
  VehicleSpeed:        { interval_seconds: 30 },
  Gear:                { interval_seconds: 30 }, // P/R/N/D — trip start/end detection
  Odometer:            { interval_seconds: 60 }, // trip distance
  // ── Battery ───────────────────────────────────────────────────────────────
  Soc:                 { interval_seconds: 60 }, // state of charge %
  BatteryLevel:        { interval_seconds: 60 }, // usable battery %
  EstBatteryRange:     { interval_seconds: 120 },
  RatedRange:          { interval_seconds: 120 },
  IdealBatteryRange:   { interval_seconds: 120 },
  EnergyRemaining:     { interval_seconds: 60 }, // kWh remaining
  // ── Charging ──────────────────────────────────────────────────────────────
  DetailedChargeState: { interval_seconds: 60 },
  ChargeAmps:          { interval_seconds: 60 },
  ChargerVoltage:      { interval_seconds: 60 }, // >0 = L1/L2 present
  ACChargingPower:     { interval_seconds: 60 },
  DCChargingPower:     { interval_seconds: 60 }, // >0 = Supercharger
  ACChargingEnergyIn:  { interval_seconds: 120 }, // session kWh (AC)
  DCChargingEnergyIn:  { interval_seconds: 120 }, // session kWh (DC)
  ChargeLimitSoc:      { interval_seconds: 120 },
  TimeToFullCharge:    { interval_seconds: 120 },
  ChargePortDoorOpen:  { interval_seconds: 60 },
  // ── Climate / misc ────────────────────────────────────────────────────────
  InsideTemp:                { interval_seconds: 120 },
  OutsideTemp:               { interval_seconds: 120 },
  LifetimeEnergyUsed:        { interval_seconds: 300 }, // cumulative kWh used
  LifetimeEnergyGainedRegen: { interval_seconds: 300 }, // cumulative regen kWh
  TpmsPressureFl:            { interval_seconds: 300 }, // bar
  TpmsPressureFr:            { interval_seconds: 300 },
  TpmsPressureRl:            { interval_seconds: 300 },
  TpmsPressureRr:            { interval_seconds: 300 },
  Locked:                    { interval_seconds: 120 },
  VehicleName:               { interval_seconds: 600 },
  Version:                   { interval_seconds: 600 },
};

// Wakes the vehicle and polls until online (up to 60 s)
async function wakeAndWait(client: AxiosInstance, id: string): Promise<void> {
  console.log(`[TelemetryConfig] Waking vehicle ${id}…`);
  await client.post(`/vehicles/${id}/wake_up`).catch(() => {});

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    try {
      const res = await client.get(`/vehicles/${id}`);
      const state: string = res.data?.response?.state ?? "";
      console.log(`[TelemetryConfig] Vehicle state: ${state}`);
      if (state === "online") return;
    } catch {
      // ignore transient errors while polling
    }
  }
  throw new Error("Vehicle did not come online within 60 seconds");
}

/**
 * POST /api/vehicles/:id/configure-telemetry
 * Wakes the vehicle if needed, then sends fleet_telemetry_config pointing at this server.
 */
router.post("/api/vehicles/:id/configure-telemetry", async (req: Request, res: Response) => {
  const { id } = req.params;
  const token = resolveToken(req);

  if (!token) {
    res.status(401).json({ error: "Not authenticated. Visit /auth/login or pass Authorization: Bearer <token>" });
    return;
  }

  const serverUrl = new URL(config.serverHost);
  const hostname = serverUrl.hostname;
  const port =
    serverUrl.port ? parseInt(serverUrl.port, 10) :
    serverUrl.protocol === "https:" ? 443 : 80;

  const fields = req.body?.fields ?? DEFAULT_FIELDS;
  // ca must be a valid PEM cert chain — Tesla requires it even for public CAs.
  // Caller can override; otherwise fall back to the cert read from keys/server-ca.pem.
  const ca: string | undefined = req.body?.ca || SERVER_CA;
  const telemetryConfig: Record<string, unknown> = { hostname, port, fields };
  if (ca) telemetryConfig.ca = ca;

  try {
    const client = createTeslaApiClient(token);

    // Check current state first
    console.log(`[TelemetryConfig] Looking up vehicle ${id}…`);
    let vehicleRes;
    try {
      vehicleRes = await client.get(`/vehicles/${id}`);
    } catch (lookupErr: any) {
      const status = lookupErr.response?.status;
      const detail = lookupErr.response?.data ?? lookupErr.message;
      console.error(`[TelemetryConfig] Vehicle lookup failed (HTTP ${status}):`, JSON.stringify(detail).slice(0, 200));
      res.status(status ?? 500).json({ error: `Vehicle lookup failed (HTTP ${status})`, detail });
      return;
    }
    const state: string = vehicleRes.data?.response?.state ?? "";
    const vin: string = vehicleRes.data?.response?.vin ?? id;
    console.log(`[TelemetryConfig] Vehicle found: vin=${vin} state=${state}`);

    if (state !== "online") {
      await wakeAndWait(client, id);
    }

    // For apiVersion >= 3 vehicles (like the 2026 Model Y), Tesla requires the
    // fleet_telemetry_config command to be signed using the app's private key.
    // This must be routed through the Tesla vehicle-command proxy.
    // See: https://github.com/teslamotors/vehicle-command
    // Set VEHICLE_COMMAND_PROXY_URL=https://localhost:4443 to enable.
    const proxyUrl = process.env.VEHICLE_COMMAND_PROXY_URL;

    console.log(`[TelemetryConfig] Sending fleet_telemetry_config → ${hostname}:${port}${proxyUrl ? ` via proxy ${proxyUrl}` : " (direct — may need proxy for newer vehicles)"}`);

    let response;
    if (proxyUrl) {
      // Route through vehicle-command proxy which handles JWS signing.
      //
      // The proxy intercepts POST /api/1/vehicles/fleet_telemetry_config (no vehicle ID
      // in path — len==5 after splitting by "/"), signs the config as a JWT, then
      // forwards to Tesla's /api/1/vehicles/fleet_telemetry_config_jws endpoint.
      //
      // Body must be { vins: [VIN], config: {...} } — VIN (not numeric ID) required.
      const axios = (await import("axios")).default;
      const https = (await import("https")).default;
      const agent = new https.Agent({ rejectUnauthorized: false });
      response = await axios.post(
        `${proxyUrl}/api/1/vehicles/fleet_telemetry_config`,
        { vins: [vin], config: telemetryConfig },
        {
          headers: { Authorization: `Bearer ${token.accessToken}`, "Content-Type": "application/json" },
          httpsAgent: agent,
        }
      );
    } else {
      response = await client.post(`/vehicles/${id}/fleet_telemetry_config`, {
        config: telemetryConfig,
      });
    }

    res.json({
      message: "Telemetry configured successfully",
      vehicleId: id,
      config: telemetryConfig,
      response: response.data,
    });
  } catch (err: any) {
    const detail = err.response?.data ?? err.message;
    console.error("[TelemetryConfig] Error:", detail);
    res.status(err.response?.status ?? 500).json({
      error: "Failed to configure telemetry",
      detail,
    });
  }
});

/**
 * DELETE /api/vehicles/:id/configure-telemetry
 */
router.delete("/api/vehicles/:id/configure-telemetry", async (req: Request, res: Response) => {
  const { id } = req.params;
  const token = resolveToken(req);

  if (!token) {
    res.status(401).json({ error: "Not authenticated." });
    return;
  }

  try {
    const client = createTeslaApiClient(token);
    const response = await client.delete(`/vehicles/${id}/fleet_telemetry_config`);
    res.json({ message: "Telemetry configuration removed", vehicleId: id, response: response.data });
  } catch (err: any) {
    res.status(err.response?.status ?? 500).json({
      error: "Failed to remove telemetry config",
      detail: err.response?.data ?? err.message,
    });
  }
});

export default router;
