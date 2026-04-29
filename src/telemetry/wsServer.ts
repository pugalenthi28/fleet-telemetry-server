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
}

const connectedVehicles = new Map<WebSocket, ConnectedVehicle>();

// Only upsert fleet_telemetry_state once per minute — reduces DB writes significantly
const STATE_UPSERT_INTERVAL_MS = 60_000;

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
    const meta: ConnectedVehicle = {
      connectedAt: new Date(),
      messagesReceived: 0,
      lastStateUpsertAt: 0,
    };
    connectedVehicles.set(ws, meta);
    console.log(`[WS] Vehicle connected  (total: ${connectedVehicles.size})`);

    ws.on("message", async (raw: Buffer) => {
      try {
        const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);

        const frame = parseFrame(buf);
        if (!frame) {
          console.warn("[WS] Unrecognised frame, ignoring");
          return;
        }

        const record = await decodePayload(frame.payloadBytes);
        if (frame.vin) record.vin = frame.vin;

        meta.vin = record.vin;
        meta.messagesReceived++;

        if (meta.messagesReceived === 1) {
          // First message: register vehicle and restore any active sessions from DB
          upsertVehicle(record.vin, record.fields["VehicleName"] as string | undefined);
          restoreActiveSessionsFromDB(record.vin);
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

        // Raw event log (opt-in via ENABLE_TELEMETRY_EVENTS=true)
        insertTelemetryData(record);

        // Concise log — key fields only, not the full 30-field dump
        logTelemetry(record.vin, frame.txid, record.createdAt, record.fields);

        ws.send(buildAck(frame.txid));
      } catch (err) {
        console.error("[WS] Failed to decode message:", err);
      }
    });

    ws.on("close", () => {
      const vin = connectedVehicles.get(ws)?.vin;
      connectedVehicles.delete(ws);
      console.log(`[WS] Vehicle disconnected  vin=${vin ?? "unknown"}  (total: ${connectedVehicles.size})`);
      if (vin) handleVehicleDisconnect(vin);
    });

    ws.on("error", (err) => {
      console.error("[WS] Socket error:", err.message);
    });
  });

  console.log("[WS] Telemetry WebSocket server attached");
  return wss;
}

function logTelemetry(vin: string, txid: string, createdAt: number, fields: Record<string, unknown>): void {
  const ts    = new Date(createdAt).toISOString().replace("T", " ").slice(0, 19);
  const gear  = fields["Gear"]                as string | undefined;
  const soc   = fields["Soc"]                 as number | undefined;
  const speed = fields["VehicleSpeed"]        as number | undefined;
  const cs    = fields["DetailedChargeState"] as string | undefined;
  const acKw  = fields["ACChargingPower"]     as number | undefined;
  const dcKw  = fields["DCChargingPower"]     as number | undefined;
  const range = fields["EstBatteryRange"]     as number | undefined;
  const odo   = fields["Odometer"]            as number | undefined;

  const parts: string[] = [`[${ts}] vin=${vin.slice(-6)}  txid=${txid}`];
  if (gear  !== undefined) parts.push(`gear=${shorten(gear, "ShiftState")}`);
  if (speed !== undefined) parts.push(`speed=${speed.toFixed(1)}mph`);
  if (soc   !== undefined) parts.push(`soc=${soc.toFixed(1)}%`);
  if (range !== undefined) parts.push(`range=${range.toFixed(1)}mi`);
  if (odo   !== undefined) parts.push(`odo=${odo.toFixed(1)}mi`);
  if (cs    !== undefined) parts.push(`charge=${shorten(cs, "DetailedChargeState")}`);
  if (acKw  !== undefined) parts.push(`ac=${acKw.toFixed(1)}kW`);
  if (dcKw  !== undefined) parts.push(`dc=${dcKw.toFixed(1)}kW`);

  // Show remaining delta field names compactly
  const logged = new Set(["Gear","VehicleSpeed","Soc","EstBatteryRange","Odometer","DetailedChargeState","ACChargingPower","DCChargingPower"]);
  const other  = Object.keys(fields).filter(k => !logged.has(k));
  if (other.length) parts.push(`+[${other.join(",")}]`);

  console.log(parts.join("  "));
}

function shorten(val: string, prefix: string): string {
  return val.startsWith(prefix) ? val.slice(prefix.length) : val;
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
