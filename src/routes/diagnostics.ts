import { Router, Request, Response } from "express";
import { resolveToken } from "../auth/resolveToken";
import { createTeslaApiClient } from "../auth/teslaClient";

const router = Router();

router.get("/api/vehicles/:id/diagnostics", async (req: Request, res: Response) => {
  const { id } = req.params;
  const token = resolveToken(req);

  if (!token) {
    res.status(401).json({ error: "Pass Authorization: Bearer <token>" });
    return;
  }

  const client = createTeslaApiClient(token);
  const results: Record<string, unknown> = {};

  // 1 — basic vehicle info
  try {
    const r = await client.get(`/vehicles/${id}`);
    results.vehicle = {
      ok: true,
      state: r.data?.response?.state,
      vin: r.data?.response?.vin,
      apiVersion: r.data?.response?.api_version,
    };
  } catch (e: any) {
    results.vehicle = { ok: false, status: e.response?.status, detail: e.response?.data };
  }

  // 2 — fleet status (key capability + safety_screen_streaming_toggle_enabled for legacy S/X)
  try {
    const r = await client.get(`/vehicles/${id}/fleet_status`);
    const resp = r.data?.response ?? {};
    results.fleetStatus = {
      ok: true,
      virtualKeySupported: resp.virtual_key_supported,
      safetyScreenStreamingToggleEnabled: resp.safety_screen_streaming_toggle_enabled,
      raw: resp,
    };
  } catch (e: any) {
    results.fleetStatus = {
      ok: false,
      status: e.response?.status,
      detail: e.response?.data,
    };
  }

  // 3 — current fleet telemetry config + key_paired flag
  try {
    const r = await client.get(`/vehicles/${id}/fleet_telemetry_config`);
    const resp = r.data?.response ?? {};
    results.fleetTelemetryConfig = {
      ok: true,
      keyPaired: resp.key_paired,
      synced: resp.synced,
      limitReached: resp.limit_reached,
      config: resp.config,
    };
  } catch (e: any) {
    results.fleetTelemetryConfig = {
      ok: false,
      status: e.response?.status,
      detail: typeof e.response?.data === "string"
        ? e.response.data.slice(0, 300)
        : e.response?.data,
    };
  }

  // 4 — vehicle data (confirms vehicle is reachable)
  try {
    const r = await client.get(`/vehicles/${id}/vehicle_data?endpoints=vehicle_state`);
    results.vehicleData = {
      ok: true,
      firmwareVersion: r.data?.response?.vehicle_state?.car_version,
    };
  } catch (e: any) {
    results.vehicleData = { ok: false, status: e.response?.status, detail: e.response?.data };
  }

  // Derive recommended next action
  const fleetStatus = results.fleetStatus as any;
  const telConfig = results.fleetTelemetryConfig as any;

  let nextAction: string;
  if (fleetStatus?.ok && fleetStatus?.safetyScreenStreamingToggleEnabled === false && fleetStatus?.virtualKeySupported === false) {
    nextAction =
      "Legacy vehicle (Model S/X) — virtual key pairing is not supported. " +
      "The driver must enable the streaming toggle inside the car: " +
      "Controls → Safety → Allow Mobile Access → enable 'Data Sharing'. " +
      "See https://github.com/teslamotors/fleet-telemetry/issues/395";
  } else if (telConfig?.ok && telConfig?.keyPaired === false) {
    nextAction =
      "Virtual key not yet paired. Open https://tesla.com/_ak/<your-render-domain> on " +
      "your phone while the car is online, then confirm in the Tesla app.";
  } else if (telConfig?.ok && telConfig?.keyPaired === true) {
    nextAction = "Key is paired. POST /api/vehicles/:id/configure-telemetry should work now.";
  } else {
    nextAction = "Check results above for details.";
  }

  res.json({
    vehicleId: id,
    fleetApiBaseUrl: client.defaults.baseURL,
    results,
    nextAction,
  });
});

export default router;
