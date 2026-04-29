import dotenv from "dotenv";
import path from "path";

dotenv.config();

function required(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export const config = {
  port: parseInt(optional("PORT", "3000"), 10),
  serverHost: optional("SERVER_HOST", "http://localhost:3000"),

  tesla: {
    clientId: optional("TESLA_CLIENT_ID", ""),
    clientSecret: optional("TESLA_CLIENT_SECRET", ""),
    redirectUri: optional("TESLA_REDIRECT_URI", "http://localhost:3000/auth/callback"),
    audience: optional("TESLA_AUDIENCE", "https://fleet-api.prd.na.vn.cloud.tesla.com"),
    authBaseUrl: "https://auth.tesla.com/oauth2/v3",
    // Fleet API base URL is derived from the audience
    get fleetApiBaseUrl() {
      return this.audience + "/api/1";
    },
    scopes: [
      "openid",
      "offline_access",
      "vehicle_device_data",
      "vehicle_cmds",
      "vehicle_charging_cmds",
    ],
  },

  keys: {
    privatePath: path.resolve(optional("PRIVATE_KEY_PATH", "./keys/private.pem")),
    publicPath: path.resolve(optional("PUBLIC_KEY_PATH", "./keys/public.pem")),
  },

  sessionSecret: optional("SESSION_SECRET", "dev_secret_change_in_production"),
};
