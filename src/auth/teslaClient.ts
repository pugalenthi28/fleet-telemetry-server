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

  // Auto-refresh expired tokens before each request
  client.interceptors.request.use(async (axiosConfig) => {
    if (tokenStore.isExpired(tokenSet)) {
      const refreshed = await refreshAccessToken(tokenSet.refreshToken);
      tokenSet.accessToken = refreshed.accessToken;
      tokenSet.refreshToken = refreshed.refreshToken;
      tokenSet.expiresAt = refreshed.expiresAt;
      axiosConfig.headers["Authorization"] = `Bearer ${refreshed.accessToken}`;
    }
    return axiosConfig;
  });

  return client;
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
