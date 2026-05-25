import axios from "axios";
import { Router, Request, Response } from "express";
import { getPartnerToken } from "../auth/teslaClient";
import { config } from "../config";
import { telemetryStore } from "../telemetry/store";

const router = Router();

/**
 * GET /api/vehicle/status
 * Proxies Tesla Fleet API GET /api/1/vehicles/{vin} using a partner token.
 * VIN is auto-resolved from the in-memory telemetry store (first connected vehicle),
 * or overridden via ?vin= query param.
 */
router.get("/api/vehicle/status", async (req: Request, res: Response) => {
  const vinParam = req.query.vin ? String(req.query.vin) : undefined;

  const vin = vinParam ?? telemetryStore.getVins()[0];
  if (!vin) {
    res.status(400).json({
      error: "No VIN available. Pass ?vin= or wait for a vehicle to connect.",
    });
    return;
  }

  try {
    const partnerToken = await getPartnerToken();
    const response = await axios.get(
      `${config.tesla.fleetApiBaseUrl}/vehicles/${vin}`,
      { headers: { Authorization: `Bearer ${partnerToken}` } },
    );
    res.json({ vin, data: response.data });
  } catch (err: any) {
    console.error("[Vehicle Status] API error:", err.response?.data ?? err.message);
    res.status(err.response?.status ?? 500).json({
      error: "Failed to fetch vehicle status",
      detail: err.response?.data ?? err.message,
    });
  }
});

export default router;
