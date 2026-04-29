import { Router, Request, Response } from "express";
import { resolveToken } from "../auth/resolveToken";
import { createTeslaApiClient } from "../auth/teslaClient";

const router = Router();

/**
 * GET /api/vehicles
 * Lists vehicles accessible to the authenticated account.
 */
router.get("/api/vehicles", async (req: Request, res: Response) => {
  const token = resolveToken(req);
  if (!token) {
    res.status(401).json({ error: "Not authenticated. Visit /auth/login or pass Authorization: Bearer <token>" });
    return;
  }

  try {
    const client = createTeslaApiClient(token);
    const response = await client.get("/vehicles");

    const vehicles = (response.data.response ?? []).map((v: any) => ({
      id: v.id,
      vehicleId: v.vehicle_id,
      vin: v.vin,
      displayName: v.display_name,
      state: v.state,
      color: v.color,
      calendarEnabled: v.calendar_enabled,
      apiVersion: v.api_version,
    }));

    res.json({ count: vehicles.length, vehicles });
  } catch (err: any) {
    console.error("[Vehicles] API error:", err.response?.data ?? err.message);
    res.status(err.response?.status ?? 500).json({
      error: "Failed to fetch vehicles",
      detail: err.response?.data ?? err.message,
    });
  }
});

export default router;
