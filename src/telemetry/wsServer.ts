import { WebSocketServer, WebSocket } from "ws";
import http from "http";
import { decodePayload } from "./decoder";
import { parseFrame, buildAck } from "./flatbuffers-frame";
import { telemetryStore } from "./store";
import { processVehicleEvent, restoreActiveSessionsFromDB, handleVehicleDisconnect } from "./vehicleMonitor";
import { upsertVehicle, upsertTelemetryState, insertTelemetryData } from "../db/repository";

interface ConnectedVehicle {
  vin?: string;
  connectedAt: Date;
  messagesReceived: number;
  lastStateUpsertAt: number;
  lastTelemetryDataAt: number;
  // Resolves when restoreActiveSessionsFromDB completes for this connection.
  // Subsequent messages await this before calling processVehicleEvent so the
  // catch-up detection never races with session restore.
  restoreReady: Promise<void>;
  resolveRestore: () => void;
}

const connectedVehicles = new Map<WebSocket, ConnectedVehicle>();

// Upsert intervals — state snapshot every 5 min, telemetry event log every 5 min
const STATE_UPSERT_INTERVAL_MS   = 5 * 60_000;
const TELEMETRY_DATA_INTERVAL_MS = 5 * 60_000;

export function attachWebSocketServer(httpServer: http.Server) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (request, socket, head) => {
    if (request.url === "/" || request.url?.startsWith("/streaming")) {
      wss.handleUpgrade(request, socket as any, head, (ws) => {
        wss.emit("connection", ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  wss.on("connection", (ws: WebSocket) => {
    let resolveRestore!: () => void;
    const restoreReady = new Promise<void>((res) => { resolveRestore = res; });

    const meta: ConnectedVehicle = {
      connectedAt: new Date(),
      messagesReceived: 0,
      lastStateUpsertAt: 0,
      lastTelemetryDataAt: 0,
      restoreReady,
      resolveRestore,
    };
    connectedVehicles.set(ws, meta);

    ws.on("message", async (raw: Buffer) => {
      try {
        const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);

        const frame = parseFrame(buf);
        if (!frame) return;

        const record = await decodePayload(frame.payloadBytes);
        if (frame.vin) record.vin = frame.vin;

        meta.vin = record.vin;
        meta.messagesReceived++;

        if (meta.messagesReceived === 1) {
          const vehicleName = record.fields["VehicleName"] as string | undefined;
          console.log(`[WS] 🔌 ${vehicleName ?? record.vin.slice(-6)} connected  (active: ${connectedVehicles.size})`);
          upsertVehicle(record.vin, vehicleName);
          await restoreActiveSessionsFromDB(record.vin);
          meta.resolveRestore(); // unblock all subsequent message handlers
        } else {
          await meta.restoreReady; // wait until first message's restore is done
        }

        telemetryStore.append(record);
        processVehicleEvent(record);

        // Throttle state upsert to once per minute
        const now = Date.now();
        if (now - meta.lastStateUpsertAt >= STATE_UPSERT_INTERVAL_MS) {
          meta.lastStateUpsertAt = now;
          const state = telemetryStore.getMergedState(record.vin);
          upsertTelemetryState(record.vin, state);
        }

        // Raw event log — throttled to once per 5 min (opt-in via ENABLE_TELEMETRY_EVENTS=true)
        if (now - meta.lastTelemetryDataAt >= TELEMETRY_DATA_INTERVAL_MS) {
          meta.lastTelemetryDataAt = now;
          insertTelemetryData(record);
        }

        ws.send(buildAck(frame.txid));
      } catch (err: unknown) {
        // Corrupted/truncated frames are common during reconnects — skip silently
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("index out of range") || msg.includes("RangeError")) {
          return;
        }
        console.warn(`[WS] Bad frame skipped: ${msg}`);
      }
    });

    ws.on("close", () => {
      const vin = connectedVehicles.get(ws)?.vin;
      connectedVehicles.delete(ws);
      if (vin) {
        console.log(`[WS] 🔌 ${vin.slice(-6)} disconnected  (active: ${connectedVehicles.size})`);
        handleVehicleDisconnect(vin).catch((err) =>
          console.error(`[WS] disconnect handler error for ${vin.slice(-6)}:`, err instanceof Error ? err.message : err),
        );
      }
    });

    ws.on("error", (err) => {
      console.error("[WS] Socket error:", err.message);
    });
  });

  return wss;
}


export function getConnectedVehicleStats() {
  const stats: Array<{ vin?: string; connectedAt: string; messagesReceived: number }> = [];
  for (const meta of connectedVehicles.values()) {
    stats.push({
      vin: meta.vin,
      connectedAt: meta.connectedAt.toISOString(),
      messagesReceived: meta.messagesReceived,
    });
  }
  return stats;
}
