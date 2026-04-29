import { Request } from "express";
import { tokenStore, TokenSet } from "./tokenStore";
import { config } from "../config";

/**
 * Resolves a TokenSet from either:
 *   1. Authorization: Bearer <access_token>  header in the request
 *   2. The in-memory token store (set after /auth/login)
 *
 * Using the header lets you call API endpoints directly with a token
 * without relying on server-side session state (useful on Render free tier
 * which restarts and wipes memory).
 */
export function resolveToken(req: Request): TokenSet | undefined {
  const authHeader = req.headers["authorization"];
  if (authHeader?.startsWith("Bearer ")) {
    const accessToken = authHeader.slice(7).trim();
    if (accessToken) {
      return {
        accessToken,
        refreshToken: "",
        expiresAt: Date.now() + 8 * 60 * 60 * 1000, // assume 8h validity
        scope: config.tesla.scopes.join(" "),
      };
    }
  }
  return tokenStore.getPrimary();
}
