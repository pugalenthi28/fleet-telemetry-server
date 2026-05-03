import http from "http";
import express, { Request, Response } from "express";
import { config } from "./config";
import { initKeysFromEnv } from "./startup/initKeys";
import { attachWebSocketServer } from "./telemetry/wsServer";
import { pingSupabase } from "./db/supabase";

// Prevent unhandled promise rejections from crashing the process.
// Render restarts the service on process exit, so we log and continue instead.
process.on("unhandledRejection", (reason) => {
  console.error("[Server] Unhandled rejection (process kept alive):", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[Server] Uncaught exception (process kept alive):", err.message);
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

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Routes ────────────────────────────────────────────────────────────────────

app.use(wellKnownRouter);       // /.well-known/appspecific/com.tesla.3p.public-key.pem
app.use(authRouter);            // /auth/*
app.use(registerRouter);        // /api/register
app.use(diagnosticsRouter);    // /api/vehicles/:id/diagnostics
app.use(vehiclesRouter);        // /api/vehicles
app.use(telemetryConfigRouter); // /api/vehicles/:id/configure-telemetry
app.use(telemetryDataRouter);   // /api/telemetry/*

app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.get("/", (_req: Request, res: Response) => {
  res.json({
    service: "Tesla Fleet Telemetry Server",
    endpoints: {
      "GET  /health":                              "Health check",
      "GET  /.well-known/…/com.tesla.3p.public-key.pem": "Tesla domain verification public key",
      "GET  /auth/login":                          "Start OAuth flow (open in browser)",
      "GET  /auth/callback":                       "OAuth redirect handler",
      "GET  /auth/status":                         "Check auth status",
      "POST /auth/logout":                         "Clear stored tokens",
      "GET  /api/vehicles":                        "List vehicles",
      "POST /api/vehicles/:id/configure-telemetry":"Configure vehicle telemetry streaming",
      "DEL  /api/vehicles/:id/configure-telemetry":"Remove telemetry config",
      "GET  /api/telemetry/connections":           "Live WebSocket connections",
      "GET  /api/telemetry/vins":                  "VINs with received data",
      "GET  /api/telemetry/data":                  "All recent telemetry",
      "GET  /api/telemetry/data/:vin":             "Telemetry history for one vehicle",
      "GET  /api/telemetry/latest/:vin":           "Merged current state for one vehicle",
      "GET  /api/telemetry/monitor":               "Trip & charge session status for all VINs",
      "GET  /api/telemetry/stream/:vin":           "Server-Sent Events — live telemetry frames (no DB)",
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
