/**
 * In-memory token store for local development.
 * In production, replace with a persistent store (Redis, DB, etc.).
 */

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // unix ms
  scope: string;
}

// Pending PKCE sessions keyed by state
interface PendingSession {
  codeVerifier: string;
  createdAt: number;
}

const tokens = new Map<string, TokenSet>(); // userId → TokenSet
const pendingSessions = new Map<string, PendingSession>(); // state → session

const SESSION_TTL_MS = 10 * 60 * 1000; // 10 min

export const tokenStore = {
  savePending(state: string, codeVerifier: string) {
    pendingSessions.set(state, { codeVerifier, createdAt: Date.now() });
  },

  consumePending(state: string): string | undefined {
    const session = pendingSessions.get(state);
    if (!session) return undefined;
    pendingSessions.delete(state);
    if (Date.now() - session.createdAt > SESSION_TTL_MS) return undefined;
    return session.codeVerifier;
  },

  save(userId: string, tokenSet: TokenSet) {
    tokens.set(userId, tokenSet);
  },

  get(userId: string): TokenSet | undefined {
    return tokens.get(userId);
  },

  // Returns the primary (first) stored token for single-user dev setups
  getPrimary(): TokenSet | undefined {
    return tokens.values().next().value;
  },

  isExpired(tokenSet: TokenSet): boolean {
    return Date.now() >= tokenSet.expiresAt - 60_000; // 1-min buffer
  },

  clear(userId: string) {
    tokens.delete(userId);
  },

  clearAll() {
    tokens.clear();
  },
};
