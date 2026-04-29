import { Router, Request, Response } from "express";
import axios from "axios";
import { config } from "../config";

const router = Router();

/**
 * POST /api/register
 * One-time call that registers this application's domain with Tesla's Fleet API.
 * Uses client_credentials (app token, not user token).
 * Must be called once per region before any Fleet API calls will work.
 */
router.post("/api/register", async (req: Request, res: Response) => {
  try {
    // Step 1 – get a client credentials (partner) token
    const tokenRes = await axios.post(
      `${config.tesla.authBaseUrl}/token`,
      new URLSearchParams({
        grant_type: "client_credentials",
        client_id: config.tesla.clientId,
        client_secret: config.tesla.clientSecret,
        scope: config.tesla.scopes.join(" "),
        audience: config.tesla.audience,
      }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );

    const partnerToken: string = tokenRes.data.access_token;

    // Step 2 – register the domain hosting the public key
    const domain = new URL(config.serverHost).hostname;

    const registerRes = await axios.post(
      `${config.tesla.fleetApiBaseUrl}/partner_accounts`,
      { domain },
      { headers: { Authorization: `Bearer ${partnerToken}` } }
    );

    console.log(`[Register] Partner account registered for domain: ${domain}`);
    res.json({
      message: "Partner account registered successfully",
      domain,
      response: registerRes.data,
    });
  } catch (err: any) {
    console.error("[Register] Failed:", err.response?.data ?? err.message);
    res.status(err.response?.status ?? 500).json({
      error: "Registration failed",
      detail: err.response?.data ?? err.message,
    });
  }
});

export default router;
