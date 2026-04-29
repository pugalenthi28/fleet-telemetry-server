import { WebSocketServer, WebSocket } from "ws";
import http from "http";
import { decodePayload } from "./decoder";
import { parseFrame, buildAck } from "./flatbuffers-frame";
import { telemetryStore } from "./store";
import { processVehicleEvent } from "./vehicleMonitor";

interface ConnectedVehicle {
  vin?: string;
  connectedAt: Date;
  messagesReceived: number;
}

const connectedVehicles = new Map<WebSocket, ConnectedVehicle>();

export function attachWebSocketServer(httpServer: http.Server) {
  const wss = new WebSocketServer({ noServer: true });

  // Upgrade HTTP connections at /streaming to WebSocket
  httpServer.on("upgrade", (request, socket, head) => {
    // Tesla vehicles connect to the root path or /streaming
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
    };
    connectedVehicles.set(ws, meta);
    console.log(`[WS] Vehicle connected  (total: ${connectedVehicles.size})`);

    ws.on("message", async (raw: Buffer) => {
      try {
        const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);

        // Tesla vehicles send FlatbuffersEnvelope (messageType=4) wrapping
        // a FlatbuffersStream whose payload bytes are a protobuf Payload.
        const frame = parseFrame(buf);
        if (!frame) {
          console.warn("[WS] Unrecognised frame (not a FlatbuffersStream), ignoring");
          return;
        }

        const record = await decodePayload(frame.payloadBytes);

        // Prefer VIN from FlatbuffersStream.DeviceId (always present) over
        // the protobuf Payload vin field (sometimes absent).
        if (frame.vin) record.vin = frame.vin;

        meta.vin = record.vin;
        meta.messagesReceived++;

        telemetryStore.append(record);
        processVehicleEvent(record);

        // Log the full merged state (not just the delta) so every line shows
        // the complete current picture of the vehicle.
        const state = telemetryStore.getMergedState(record.vin);
        const fieldLines = Object.entries(state)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => `  ${k.padEnd(28)} ${JSON.stringify(v)}`)
          .join("\n");
        console.log(`\n[WS] ${record.vin}  txid=${frame.txid}  ts=${new Date(record.createdAt).toISOString()}  (delta: ${Object.keys(record.fields).join(", ")})\n${fieldLines}`);

        // ACK — send FlatbuffersEnvelope with messageType=5 (StreamAck) and same txid
        ws.send(buildAck(frame.txid));
      } catch (err) {
        console.error("[WS] Failed to decode message:", err);
      }
    });

    ws.on("close", () => {
      const vin = connectedVehicles.get(ws)?.vin ?? "unknown";
      connectedVehicles.delete(ws);
      console.log(`[WS] Vehicle disconnected  vin=${vin}  (total: ${connectedVehicles.size})`);
    });

    ws.on("error", (err) => {
      console.error("[WS] Socket error:", err.message);
    });
  });

  console.log("[WS] Telemetry WebSocket server attached (ws:// upgrade on / and /streaming)");
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
