import { Router, Request, Response } from "express";
import { createTeslaApiClient } from "../auth/teslaClient";
import { tokenStore } from "../auth/tokenStore";
import { telemetryStore } from "../telemetry/store";
import { getFirstVin } from "../db/repository";

const router = Router();

async function resolveVin(override?: string): Promise<string | null> {
  if (override) return override;
  return telemetryStore.getVins()[0] ?? await getFirstVin();
}

/**
 * GET /api/vehicle/status
 * Proxies Tesla Fleet API GET /api/1/vehicles/{vin} using the stored user OAuth token.
 * VIN is auto-resolved from the in-memory telemetry store or fleet_vehicles table.
 * Override with ?vin= query param.
 */
router.get("/api/vehicle/status", async (req: Request, res: Response) => {
  const vin = await resolveVin(req.query.vin ? String(req.query.vin) : undefined);
  if (!vin) {
    res.status(400).json({ error: "No vehicle found. Pass ?vin= or wait for a vehicle to connect." });
    return;
  }

  const tokenSet = tokenStore.getPrimary();
  if (!tokenSet) {
    res.status(401).json({ error: "Not authenticated. Visit /auth/login first." });
    return;
  }

  try {
    const client = createTeslaApiClient(tokenSet);
    const response = await client.get(`/vehicles/${vin}`);
    res.json({ vin, data: response.data });
  } catch (err: any) {
    console.error("[Vehicle Status] API error:", err.response?.data ?? err.message);
    res.status(err.response?.status ?? 500).json({
      error: "Failed to fetch vehicle status",
      detail: err.response?.data ?? err.message,
    });
  }
});

/**
 * GET /api/1/vehicles/:vin/vehicle_data
 * GET /api/1/vehicle/vehicle_data  (VIN auto-resolved from fleet_vehicles)
 * Proxies Tesla Fleet API GET /api/1/vehicles/{vin}/vehicle_data.
 * Returns full vehicle state (charge_state, drive_state, climate_state, etc.).
 *
 * Optional query param: ?endpoints=charge_state;climate_state;drive_state;...
 */
async function handleVehicleData(vin: string, req: Request, res: Response): Promise<void> {
  const tokenSet = tokenStore.getPrimary();
  if (!tokenSet) {
    res.status(401).json({ error: "Not authenticated. Visit /auth/login first." });
    return;
  }

  try {
    const client = createTeslaApiClient(tokenSet);
    const params = req.query.endpoints ? { endpoints: req.query.endpoints } : undefined;
    const response = await client.get(`/vehicles/${vin}/vehicle_data`, { params });
    res.json(response.data);
  } catch (err: any) {
    console.error("[Vehicle Data] API error:", err.response?.data ?? err.message);
    res.status(err.response?.status ?? 500).json({
      error: "Failed to fetch vehicle data",
      detail: err.response?.data ?? err.message,
    });
  }
}

router.get("/api/1/vehicles/:vin/vehicle_data", async (req: Request, res: Response) => {
  await handleVehicleData(req.params.vin, req, res);
});

async function handleVehicleDataAutoVin(req: Request, res: Response): Promise<void> {
  const vin = await resolveVin();
  if (!vin) {
    res.status(400).json({ error: "No vehicle found in fleet_vehicles table." });
    return;
  }
  await handleVehicleData(vin, req, res);
}

router.get("/api/1/vehicle/vehicle_data", handleVehicleDataAutoVin);
router.get("/api/vehicle/vehicle_data",   handleVehicleDataAutoVin);

export default router;
