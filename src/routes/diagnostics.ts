import { Router, Request, Response } from "express";
import { resolveToken } from "../auth/resolveToken";
import { createTeslaApiClient } from "../auth/teslaClient";

const router = Router();

/**
 * GET /api/vehicles/:id/diagnostics
 * Runs a series of checks to identify why fleet_telemetry_config is failing.
 */
router.get("/api/vehicles/:id/diagnostics", async (req: Request, res: Response) => {
  const { id } = req.params;
  const token = resolveToken(req);

  if (!token) {
    res.status(401).json({ error: "Pass Authorization: Bearer <token>" });
    return;
  }

  const client = createTeslaApiClient(token);
  const results: Record<string, unknown> = {};

  // 1 — vehicle state
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

  // 2 — fleet_telemetry_config GET (read current config)
  try {
    const r = await client.get(`/vehicles/${id}/fleet_telemetry_config`);
    results.fleetTelemetryConfigGet = { ok: true, data: r.data };
  } catch (e: any) {
    results.fleetTelemetryConfigGet = {
      ok: false,
      status: e.response?.status,
      detail: typeof e.response?.data === "string"
        ? e.response.data.slice(0, 300)
        : e.response?.data,
    };
  }

  // 3 — signed_command check (indicates whether virtual key is needed)
  try {
    const r = await client.get(`/vehicles/${id}/vehicle_data?endpoints=vehicle_state`);
    results.vehicleData = { ok: true, state: r.data?.response?.vehicle_state?.car_version };
  } catch (e: any) {
    results.vehicleData = { ok: false, status: e.response?.status, detail: e.response?.data };
  }

  res.json({
    vehicleId: id,
    fleetApiBaseUrl: client.defaults.baseURL,
    results,
    nextAction:
      results.fleetTelemetryConfigGet && (results.fleetTelemetryConfigGet as any).status === 404
        ? "Virtual key likely not added. Open https://tesla.com/_ak/<your-render-domain> on your phone with the Tesla app installed."
        : "Check results above",
  });
});

export default router;
