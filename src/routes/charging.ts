import { Router, Request, Response } from "express";
import { resolveToken } from "../auth/resolveToken";
import { createTeslaApiClient } from "../auth/teslaClient";

const router = Router();

/**
 * GET /api/charging/history
 * Proxies Tesla Fleet API /dx/charging/history.
 *
 * Query params (all optional, passed through to Tesla):
 *   vin        — filter to a specific vehicle
 *   startTime  — ISO 8601 start of range
 *   endTime    — ISO 8601 end of range
 *   pageNo     — page number (1-based)
 *   pageSize   — results per page
 */
router.get("/api/charging/history", async (req: Request, res: Response) => {
  const token = resolveToken(req);
  if (!token) {
    res.status(401).json({ error: "Not authenticated. Visit /auth/login or pass Authorization: Bearer <token>" });
    return;
  }

  const { vin, startTime, endTime, pageNo, pageSize } = req.query;

  const params: Record<string, string> = {};
  if (vin)       params.vin       = String(vin);
  if (startTime) params.startTime = String(startTime);
  if (endTime)   params.endTime   = String(endTime);
  if (pageNo)    params.pageNo    = String(pageNo);
  if (pageSize)  params.pageSize  = String(pageSize);

  try {
    const client = createTeslaApiClient(token);
    const response = await client.get("/dx/charging/history", { params });
    res.json(response.data);
  } catch (err: any) {
    console.error("[Charging History] API error:", err.response?.data ?? err.message);
    res.status(err.response?.status ?? 500).json({
      error: "Failed to fetch charging history",
      detail: err.response?.data ?? err.message,
    });
  }
});

export default router;
