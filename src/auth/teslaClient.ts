import axios, { AxiosInstance } from "axios";
import { config } from "../config";
import { tokenStore, TokenSet } from "./tokenStore";

export function createTeslaApiClient(tokenSet: TokenSet): AxiosInstance {
  const client = axios.create({
    baseURL: config.tesla.fleetApiBaseUrl,
    headers: {
      Authorization: `Bearer ${tokenSet.accessToken}`,
      "Content-Type": "application/json",
    },
  });

  client.interceptors.request.use(async (axiosConfig) => {
    if (tokenStore.isExpired(tokenSet)) {
      const refreshed = await refreshAccessToken(tokenSet.refreshToken);
      tokenSet.accessToken = refreshed.accessToken;
      tokenSet.refreshToken = refreshed.refreshToken;
      tokenSet.expiresAt = refreshed.expiresAt;
      axiosConfig.headers["Authorization"] = `Bearer ${refreshed.accessToken}`;
    }
    const fullUrl = `${axiosConfig.baseURL ?? ""}${axiosConfig.url ?? ""}`;
    console.log(`[Tesla API] ${axiosConfig.method?.toUpperCase()} ${fullUrl}`);
    return axiosConfig;
  });

  client.interceptors.response.use(
    (res) => res,
    (err) => {
      const status = err.response?.status;
      const url = err.config?.url;
      const body = typeof err.response?.data === "string"
        ? err.response.data.slice(0, 200)   // truncate HTML
        : JSON.stringify(err.response?.data);
      console.error(`[Tesla API] ERROR ${status} on ${url} → ${body}`);
      return Promise.reject(err);
    }
  );

  return client;
}

// Partner token cache — client_credentials tokens are long-lived (8h), cache in memory.
let cachedPartnerToken: { accessToken: string; expiresAt: number } | null = null;

export async function getPartnerToken(): Promise<string> {
  if (cachedPartnerToken && Date.now() < cachedPartnerToken.expiresAt - 60_000) {
    return cachedPartnerToken.accessToken;
  }
  const response = await axios.post(
    `${config.tesla.authBaseUrl}/token`,
    new URLSearchParams({
      grant_type:    "client_credentials",
      client_id:     config.tesla.clientId,
      client_secret: config.tesla.clientSecret,
      scope:         config.tesla.scopes.join(" "),
      audience:      config.tesla.audience,
    }),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } },
  );
  const data = response.data;
  cachedPartnerToken = {
    accessToken: data.access_token,
    expiresAt:   Date.now() + data.expires_in * 1000,
  };
  return cachedPartnerToken.accessToken;
}

export async function refreshAccessToken(refreshToken: string): Promise<TokenSet> {
  const response = await axios.post(
    `${config.tesla.authBaseUrl}/token`,
    new URLSearchParams({
      grant_type: "refresh_token",
      client_id: config.tesla.clientId,
      refresh_token: refreshToken,
    }),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );

  const data = response.data;
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? refreshToken,
    expiresAt: Date.now() + data.expires_in * 1000,
    scope: data.scope,
  };
}
