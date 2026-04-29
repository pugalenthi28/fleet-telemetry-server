import { Router, Request, Response } from "express";
import { config } from "../config";
import { tokenStore } from "../auth/tokenStore";
import { createTeslaApiClient } from "../auth/teslaClient";

const router = Router();

/**
 * Default telemetry fields to stream.
 * Adjust intervals (seconds) to match your needs.
 * Full field list: https://developer.tesla.com/docs/fleet-api/fleet-telemetry#data-parameters
 */
const DEFAULT_FIELDS: Record<string, { interval_seconds: number }> = {
  VehicleSpeed:      { interval_seconds: 5  },
  Odometer:          { interval_seconds: 30 },
  BatteryLevel:      { interval_seconds: 30 },
  Latitude:          { interval_seconds: 5  },
  Longitude:         { interval_seconds: 5  },
  Heading:           { interval_seconds: 5  },
  Elevation:         { interval_seconds: 10 },
  PowerState:        { interval_seconds: 30 },
  ShiftState:        { interval_seconds: 5  },
  InsideTemp:        { interval_seconds: 60 },
  OutsideTemp:       { interval_seconds: 60 },
  ChargeState:       { interval_seconds: 30 },
  TimeToFullCharge:  { interval_seconds: 60 },
  SentryMode:        { interval_seconds: 60 },
};

/**
 * POST /api/vehicles/:id/configure-telemetry
 * Sends a fleet_telemetry_config command to the vehicle, pointing it at this server.
 *
 * Body (optional):
 * {
 *   "fields": { "FieldName": { "interval_seconds": N }, … }
 * }
 */
router.post("/api/vehicles/:id/configure-telemetry", async (req: Request, res: Response) => {
  const { id } = req.params;
  const token = tokenStore.getPrimary();

  if (!token) {
    res.status(401).json({ error: "Not authenticated. Visit /auth/login first." });
    return;
  }

  // Derive the hostname the vehicle should stream to
  const serverUrl = new URL(config.serverHost);
  const hostname = serverUrl.hostname;
  // Use 443 if behind a TLS proxy (ngrok/prod), else the configured port
  const port =
    serverUrl.port ? parseInt(serverUrl.port, 10) :
    serverUrl.protocol === "https:" ? 443 : 80;

  const fields = req.body?.fields ?? DEFAULT_FIELDS;

  const telemetryConfig = {
    hostname,
    port,
    fields,
  };

  console.log(`[TelemetryConfig] Configuring vehicle ${id} → ${hostname}:${port}`);

  try {
    const client = createTeslaApiClient(token);
    const response = await client.post(`/vehicles/${id}/fleet_telemetry_config`, {
      config: telemetryConfig,
    });

    res.json({
      message: "Telemetry configured successfully",
      vehicleId: id,
      config: telemetryConfig,
      response: response.data,
    });
  } catch (err: any) {
    console.error("[TelemetryConfig] API error:", err.response?.data ?? err.message);
    res.status(err.response?.status ?? 500).json({
      error: "Failed to configure telemetry",
      detail: err.response?.data ?? err.message,
    });
  }
});

/**
 * DELETE /api/vehicles/:id/configure-telemetry
 * Removes the fleet_telemetry_config from the vehicle.
 */
router.delete("/api/vehicles/:id/configure-telemetry", async (req: Request, res: Response) => {
  const { id } = req.params;
  const token = tokenStore.getPrimary();

  if (!token) {
    res.status(401).json({ error: "Not authenticated." });
    return;
  }

  try {
    const client = createTeslaApiClient(token);
    const response = await client.delete(`/vehicles/${id}/fleet_telemetry_config`);

    res.json({
      message: "Telemetry configuration removed",
      vehicleId: id,
      response: response.data,
    });
  } catch (err: any) {
    res.status(err.response?.status ?? 500).json({
      error: "Failed to remove telemetry config",
      detail: err.response?.data ?? err.message,
    });
  }
});

export default router;
