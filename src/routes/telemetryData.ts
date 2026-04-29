import { Router, Request, Response } from "express";
import { telemetryStore } from "../telemetry/store";
import { getConnectedVehicleStats } from "../telemetry/wsServer";
import { getMonitorStats } from "../telemetry/vehicleMonitor";

const router = Router();

/**
 * GET /api/telemetry/connections
 * Active WebSocket connections (live vehicles).
 */
router.get("/api/telemetry/connections", (req: Request, res: Response) => {
  res.json({ connections: getConnectedVehicleStats() });
});

/**
 * GET /api/telemetry/vins
 * Lists VINs for which data has been received.
 */
router.get("/api/telemetry/vins", (req: Request, res: Response) => {
  res.json({ vins: telemetryStore.getVins() });
});

/**
 * GET /api/telemetry/data
 * Recent telemetry records across all vehicles.
 * Query params: ?limit=100
 */
router.get("/api/telemetry/data", (req: Request, res: Response) => {
  const limit = Math.min(parseInt((req.query.limit as string) ?? "100", 10), 1000);
  res.json({ records: telemetryStore.getAll(limit) });
});

/**
 * GET /api/telemetry/data/:vin
 * Recent telemetry records for a specific vehicle.
 * Query params: ?limit=100
 */
router.get("/api/telemetry/data/:vin", (req: Request, res: Response) => {
  const { vin } = req.params;
  const limit = Math.min(parseInt((req.query.limit as string) ?? "100", 10), 1000);
  res.json({ vin, records: telemetryStore.getByVin(vin, limit) });
});

/**
 * GET /api/telemetry/latest/:vin
 * Most recent merged telemetry state for a vehicle.
 */
router.get("/api/telemetry/latest/:vin", (req: Request, res: Response) => {
  const { vin } = req.params;
  const state = telemetryStore.getMergedState(vin);
  if (Object.keys(state).length === 0) {
    res.status(404).json({ error: `No telemetry data received for VIN: ${vin}` });
    return;
  }
  res.json({ vin, state });
});

/**
 * GET /api/telemetry/monitor
 * Current vehicle monitor state (trip / charge session) for all tracked VINs.
 */
router.get("/api/telemetry/monitor", (_req: Request, res: Response) => {
  res.json({ monitor: getMonitorStats() });
});

export default router;
