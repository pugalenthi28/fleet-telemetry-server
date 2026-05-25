import { Router, Request, Response } from "express";
import { createTeslaApiClient } from "../auth/teslaClient";
import { tokenStore } from "../auth/tokenStore";
import { telemetryStore } from "../telemetry/store";

const router = Router();

/**
 * GET /api/vehicle/status
 * Proxies Tesla Fleet API GET /api/1/vehicles/{vin} using the stored user OAuth token.
 * VIN is auto-resolved from the in-memory telemetry store (first connected vehicle),
 * or overridden via ?vin= query param.
 *
 * Note: Tesla's /vehicles/{vin} endpoint requires a user OAuth token — partner
 * (client_credentials) tokens are not accepted for this endpoint.
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

export default router;
