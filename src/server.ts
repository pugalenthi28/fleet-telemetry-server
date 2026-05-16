import http from "http";
import express, { Request, Response } from "express";
import { config } from "./config";
import { initKeysFromEnv } from "./startup/initKeys";
import { attachWebSocketServer, flushPendingSignals } from "./telemetry/wsServer";
import { pingSupabase } from "./db/supabase";

// Prevent unhandled promise rejections from crashing the process.
// Render restarts the service on process exit, so we log and continue instead.
process.on("unhandledRejection", (reason) => {
  console.error("[Server] Unhandled rejection (process kept alive):", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[Server] Uncaught exception (process kept alive):", err.message);
});

// Render sends SIGTERM before restarting — flush in-memory signal counts so
// the day's total isn't lost across deploys.
process.on("SIGTERM", async () => {
  console.log("[Server] SIGTERM — flushing pending signal counts…");
  await flushPendingSignals();
  process.exit(0);
});

initKeysFromEnv();

// Routes
import wellKnownRouter from "./routes/wellKnown";
import authRouter from "./routes/auth";
import vehiclesRouter from "./routes/vehicles";
import telemetryConfigRouter from "./routes/telemetryConfig";
import telemetryDataRouter from "./routes/telemetryData";
import registerRouter from "./routes/register";
import diagnosticsRouter from "./routes/diagnostics";
import chargingRouter from "./routes/charging";

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Routes ────────────────────────────────────────────────────────────────────

app.use(wellKnownRouter);       // /.well-known/appspecific/com.tesla.3p.public-key.pem
app.use(authRouter);            // /auth/*
app.use(registerRouter);        // /api/register
app.use(diagnosticsRouter);    // /api/vehicles/:id/diagnostics
app.use(vehiclesRouter);        // /api/vehicles
app.use(chargingRouter);        // /api/charging/*
app.use(telemetryConfigRouter); // /api/vehicles/:id/configure-telemetry
app.use(telemetryDataRouter);   // /api/telemetry/*

app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.get("/", (_req: Request, res: Response) => {
  res.json({
    service: "Tesla Fleet Telemetry Server",
    endpoints: {
      "── System ──────────────────────────────────────────────────────": "",
      "GET  /health":                                    "Health check",
      "GET  /.well-known/…/com.tesla.3p.public-key.pem": "Tesla domain verification public key",
      "── Auth ────────────────────────────────────────────────────────": "",
      "GET  /auth/login":                                "Start OAuth flow (open in browser)",
      "GET  /auth/callback":                             "OAuth redirect handler",
      "GET  /auth/status":                               "Check token status",
      "POST /auth/logout":                               "Clear stored tokens",
      "── Vehicles ────────────────────────────────────────────────────": "",
      "POST /api/register":                              "Register vehicle with Tesla (domain + key)",
      "GET  /api/vehicles":                              "List vehicles linked to the account",
      "GET  /api/vehicles/:id/diagnostics":              "Fetch diagnostics for one vehicle",
      "POST /api/vehicles/:id/configure-telemetry":      "Push telemetry streaming config to vehicle",
      "DEL  /api/vehicles/:id/configure-telemetry":      "Remove telemetry streaming config",
      "── Charging ────────────────────────────────────────────────────": "",
      "GET  /api/charging/history":                        "Tesla charging history (?vin=&startTime=&endTime=&pageNo=&pageSize=)",
      "── Telemetry ───────────────────────────────────────────────────": "",
      "GET  /api/telemetry/connections":                 "Active WebSocket connections (live vehicles)",
      "GET  /api/telemetry/vins":                        "VINs that have sent data since server start",
      "GET  /api/telemetry/latest/:vin":                 "Merged current state for one vehicle",
      "GET  /api/telemetry/data":                        "Recent raw telemetry frames (?limit=100)",
      "GET  /api/telemetry/data/:vin":                   "Recent frames for one vehicle (?limit=100)",
      "GET  /api/telemetry/monitor":                     "Trip & charge session status for all VINs",
      "GET  /api/telemetry/stream/:vin":                 "Server-Sent Events — live frames, no DB calls",
    },
  });
});

// ── HTTP + WebSocket server ───────────────────────────────────────────────────

const server = http.createServer(app);

// Attach WebSocket server – vehicles connect to ws(s)://host/ or /streaming
attachWebSocketServer(server);

server.listen(config.port, () => {
  console.log(`🚗  Fleet server :${config.port}  →  ${config.serverHost}`);
  pingSupabase();
});

export default server;
