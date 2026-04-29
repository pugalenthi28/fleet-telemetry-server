import { Router, Request, Response } from "express";
import { AxiosInstance } from "axios";
import { config } from "../config";
import { resolveToken } from "../auth/resolveToken";
import { createTeslaApiClient } from "../auth/teslaClient";

const router = Router();

const DEFAULT_FIELDS: Record<string, { interval_seconds: number }> = {
  VehicleSpeed:     { interval_seconds: 5  },
  Odometer:         { interval_seconds: 30 },
  BatteryLevel:     { interval_seconds: 30 },
  Latitude:         { interval_seconds: 5  },
  Longitude:        { interval_seconds: 5  },
  Heading:          { interval_seconds: 5  },
  Elevation:        { interval_seconds: 10 },
  PowerState:       { interval_seconds: 30 },
  ShiftState:       { interval_seconds: 5  },
  InsideTemp:       { interval_seconds: 60 },
  OutsideTemp:      { interval_seconds: 60 },
  ChargeState:      { interval_seconds: 30 },
  TimeToFullCharge: { interval_seconds: 60 },
  SentryMode:       { interval_seconds: 60 },
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
  const telemetryConfig = { hostname, port, fields };

  try {
    const client = createTeslaApiClient(token);

    // Check current state first
    const vehicleRes = await client.get(`/vehicles/${id}`);
    const state: string = vehicleRes.data?.response?.state ?? "";

    if (state !== "online") {
      await wakeAndWait(client, id);
    }

    console.log(`[TelemetryConfig] Sending fleet_telemetry_config → ${hostname}:${port}`);
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
