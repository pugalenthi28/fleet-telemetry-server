import { Router, Request, Response } from "express";
import axios from "axios";
import { config } from "../config";
import { generatePKCE, generateState } from "../auth/pkce";
import { tokenStore, TokenSet } from "../auth/tokenStore";

const router = Router();

/**
 * GET /auth/login
 * Redirects the browser to Tesla's OAuth authorization page.
 * Open this URL in a browser to authenticate your Tesla account.
 */
router.get("/auth/login", (req: Request, res: Response) => {
  const { codeVerifier, codeChallenge } = generatePKCE();
  const state = generateState();

  tokenStore.savePending(state, codeVerifier);

  const params = new URLSearchParams({
    response_type: "code",
    client_id: config.tesla.clientId,
    redirect_uri: config.tesla.redirectUri,
    scope: config.tesla.scopes.join(" "),
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });

  const authUrl = `${config.tesla.authBaseUrl}/authorize?${params}`;
  console.log("[Auth] Redirecting to Tesla OAuth:", authUrl);
  res.redirect(authUrl);
});

/**
 * GET /auth/callback
 * Tesla redirects here after the user authorizes the app.
 * Exchanges the authorization code for access + refresh tokens.
 */
router.get("/auth/callback", async (req: Request, res: Response) => {
  const { code, state, error } = req.query as Record<string, string>;

  if (error) {
    res.status(400).json({ error: "OAuth error", detail: error });
    return;
  }

  if (!code || !state) {
    res.status(400).json({ error: "Missing code or state parameter" });
    return;
  }

  const codeVerifier = tokenStore.consumePending(state);
  if (!codeVerifier) {
    res.status(400).json({ error: "Invalid or expired state. Please re-initiate login." });
    return;
  }

  try {
    const tokenRes = await axios.post(
      `${config.tesla.authBaseUrl}/token`,
      new URLSearchParams({
        grant_type: "authorization_code",
        client_id: config.tesla.clientId,
        client_secret: config.tesla.clientSecret,
        code,
        redirect_uri: config.tesla.redirectUri,
        code_verifier: codeVerifier,
        audience: config.tesla.audience,
      }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );

    const data = tokenRes.data;

    // Decode the JWT sub claim to use as userId key
    const jwtPayload = JSON.parse(
      Buffer.from(data.access_token.split(".")[1], "base64url").toString()
    );
    const userId: string = jwtPayload.sub ?? "default";

    const tokenSet: TokenSet = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + data.expires_in * 1000,
      scope: data.scope,
    };

    tokenStore.save(userId, tokenSet);

    console.log(`[Auth] Token stored for user ${userId}, scopes: ${data.scope}`);

    res.json({
      message: "Authentication successful!",
      userId,
      scope: data.scope,
      expiresIn: data.expires_in,
      nextStep: "Visit /api/vehicles to list your vehicles, then POST /api/vehicles/:id/configure-telemetry",
    });
  } catch (err: any) {
    console.error("[Auth] Token exchange failed:", err.response?.data ?? err.message);
    res.status(500).json({
      error: "Token exchange failed",
      detail: err.response?.data ?? err.message,
    });
  }
});

/**
 * GET /auth/status
 * Returns whether a token is currently stored.
 */
router.get("/auth/status", (req: Request, res: Response) => {
  const token = tokenStore.getPrimary();
  if (!token) {
    res.json({ authenticated: false, message: "Visit /auth/login to authenticate" });
    return;
  }
  res.json({
    authenticated: true,
    expired: tokenStore.isExpired(token),
    expiresAt: new Date(token.expiresAt).toISOString(),
    scope: token.scope,
  });
});

/**
 * POST /auth/logout
 * Clears all stored tokens.
 */
router.post("/auth/logout", (req: Request, res: Response) => {
  tokenStore.clearAll();
  res.json({ message: "Logged out – all tokens cleared" });
});

/**
 * GET /auth/virtual-key
 * Returns the URL to open on your phone (with Tesla app installed) to add
 * this app's public key as a virtual key to your vehicle.
 * This is required once before vehicle commands and fleet_telemetry_config will work.
 */
router.get("/auth/virtual-key", (req: Request, res: Response) => {
  const domain = new URL(config.serverHost).hostname;
  const virtualKeyUrl = `https://tesla.com/_ak/${domain}`;
  res.json({
    message: "Open this URL on your phone with the Tesla app installed",
    virtualKeyUrl,
    instructions: [
      "1. Copy the virtualKeyUrl above",
      "2. Open it in Safari/Chrome on your iPhone/Android (Tesla app must be installed)",
      "3. Tesla app opens and asks which vehicle to add the key to",
      "4. Select your vehicle and tap Add",
      "5. Come back and retry POST /api/vehicles/:id/configure-telemetry",
    ],
  });
});

export default router;
