import { Router, Request, Response } from "express";
import { telemetryStore, telemetryEvents, TelemetryRecord } from "../telemetry/store";
import { getConnectedVehicleStats } from "../telemetry/wsServer";
import { getMonitorStats } from "../telemetry/vehicleMonitor";

const router = Router();

/**
 * GET /api/telemetry/connections
 * Active WebSocket connections (live vehicles).
 */
router.get("/api/telemetry/connections", (req: Request, res: Response) => {
  res.json({ connections: getConnectedVehicleStats() });
});

/**
 * GET /api/telemetry/vins
 * Lists VINs for which data has been received.
 */
router.get("/api/telemetry/vins", (req: Request, res: Response) => {
  res.json({ vins: telemetryStore.getVins() });
});

/**
 * GET /api/telemetry/data
 * Recent telemetry records across all vehicles.
 * Query params: ?limit=100
 */
router.get("/api/telemetry/data", (req: Request, res: Response) => {
  const limit = Math.min(parseInt((req.query.limit as string) ?? "100", 10), 1000);
  res.json({ records: telemetryStore.getAll(limit) });
});

/**
 * GET /api/telemetry/data/:vin
 * Recent telemetry records for a specific vehicle.
 * Query params: ?limit=100
 */
router.get("/api/telemetry/data/:vin", (req: Request, res: Response) => {
  const { vin } = req.params;
  const limit = Math.min(parseInt((req.query.limit as string) ?? "100", 10), 1000);
  res.json({ vin, records: telemetryStore.getByVin(vin, limit) });
});

/**
 * GET /api/telemetry/latest/:vin
 * Most recent merged telemetry state for a vehicle.
 */
router.get("/api/telemetry/latest/:vin", (req: Request, res: Response) => {
  const { vin } = req.params;
  const state = telemetryStore.getMergedState(vin);
  if (Object.keys(state).length === 0) {
    res.status(404).json({ error: `No telemetry data received for VIN: ${vin}` });
    return;
  }
  res.json({ vin, state });
});

/**
 * GET /api/telemetry/monitor
 * Current vehicle monitor state (trip / charge session) for all tracked VINs.
 */
router.get("/api/telemetry/monitor", (_req: Request, res: Response) => {
  res.json({ monitor: getMonitorStats() });
});

// 2 KB of spaces — fills browser receive buffers so Safari/Chrome mobile
// render the stream immediately instead of hanging in "loading" state.
const SSE_PADDING = `: ${"pad".padEnd(2048, " ")}\n\n`;

function openSseStream(vin: string, req: Request, res: Response) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  // Disable Nagle's algorithm so each write is sent as its own TCP packet
  const socket = (res as any).socket;
  if (socket) {
    socket.setNoDelay(true);
    socket.setTimeout(0); // disable idle timeout — SSE connections are intentionally long-lived
  }

  res.flushHeaders();

  // Padding comment fills mobile browser buffers so the stream renders immediately.
  // Then send the confirmed VIN so clients know which vehicle they're subscribed to.
  res.write(SSE_PADDING);
  res.write(`retry: 5000\n`);
  res.write(`event: connected\ndata: ${JSON.stringify({ vin })}\n\n`);

  // Heartbeat every 15 s — mobile networks and Render's proxy drop idle SSE connections
  const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 15_000);

  const push = (record: TelemetryRecord) => {
    res.write(`data: ${JSON.stringify({ ts: new Date(record.createdAt).toISOString(), fields: record.fields })}\n\n`);
  };

  telemetryEvents.on(vin, push);

  req.on("close", () => {
    clearInterval(heartbeat);
    telemetryEvents.off(vin, push);
  });
}

/**
 * GET /api/telemetry/live
 * Mobile-friendly HTML page that renders the SSE stream in a browser.
 */
router.get("/api/telemetry/live", (req: Request, res: Response) => {
  const vin = req.query.vin ? String(req.query.vin) : (telemetryStore.getVins()[0] ?? "");
  const streamUrl = vin ? `/api/telemetry/stream/${vin}` : "/api/telemetry/stream";
  res.setHeader("Content-Type", "text/html");
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Live Telemetry${vin ? " · " + vin.slice(-6) : ""}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;padding:12px;font-size:13px}
  h1{font-size:15px;font-weight:700;color:#38bdf8;margin-bottom:8px}
  #status{display:inline-block;padding:2px 10px;border-radius:999px;font-size:11px;font-weight:600;margin-bottom:10px;background:#1e293b;color:#94a3b8}
  #status.ok{background:#052e16;color:#4ade80}
  #status.err{background:#450a0a;color:#f87171}
  #grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:6px}
  .card{background:#1e293b;border-radius:8px;padding:8px 10px;border:1px solid #334155}
  .key{font-size:10px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:.4px;margin-bottom:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .val{font-size:15px;font-weight:700;color:#f1f5f9;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .ts{font-size:10px;color:#475569;margin-top:8px;text-align:right}
  .new{animation:flash .6s ease}
  @keyframes flash{0%{background:#1e3a5f}100%{background:#1e293b}}
</style>
</head>
<body>
<h1>⚡ Live Telemetry${vin ? " &mdash; " + vin.slice(-6) : ""}</h1>
<div id="status">connecting…</div>
<div id="ts" class="ts"></div>
<div id="grid"></div>
<script>
const status=document.getElementById('status');
const grid=document.getElementById('grid');
const tsEl=document.getElementById('ts');
const cards={};
function upsert(key,val){
  if(val===null||val===undefined||val==='')return;
  const display=typeof val==='object'?JSON.stringify(val):String(val);
  if(cards[key]){
    if(cards[key].dataset.val!==display){
      cards[key].dataset.val=display;
      cards[key].querySelector('.val').textContent=display;
      cards[key].classList.remove('new');
      void cards[key].offsetWidth;
      cards[key].classList.add('new');
    }
  } else {
    const c=document.createElement('div');
    c.className='card';c.dataset.val=display;
    c.innerHTML='<div class="key">'+key+'</div><div class="val">'+display+'</div>';
    cards[key]=c;grid.appendChild(c);
  }
}
const es=new EventSource('${streamUrl}');
es.onopen=()=>{status.textContent='connected';status.className='ok'};
es.onerror=()=>{status.textContent='disconnected — retrying…';status.className='err'};
es.addEventListener('connected',e=>{
  const d=JSON.parse(e.data);
  status.textContent='connected · '+d.vin;status.className='ok';
});
es.onmessage=e=>{
  const d=JSON.parse(e.data);
  tsEl.textContent='Last update: '+new Date(d.ts).toLocaleTimeString();
  Object.entries(d.fields).forEach(([k,v])=>upsert(k,v));
};
</script>
</body>
</html>`);
});

/**
 * GET /api/telemetry/stream
 * Server-Sent Events — auto-resolves VIN from the in-memory store.
 * Override with ?vin= query param if multiple vehicles are connected.
 */
router.get("/api/telemetry/stream", (req: Request, res: Response) => {
  const vinParam = req.query.vin ? String(req.query.vin) : undefined;
  const vin = vinParam ?? telemetryStore.getVins()[0];
  if (!vin) {
    res.status(400).json({ error: "No VIN available. Pass ?vin= or wait for a vehicle to connect." });
    return;
  }
  openSseStream(vin, req, res);
});

/**
 * GET /api/telemetry/stream/:vin
 * Server-Sent Events — pushes each incoming telemetry frame in real time.
 * No DB calls; purely in-memory fan-out. Connect with EventSource in the browser.
 */
router.get("/api/telemetry/stream/:vin", (req: Request, res: Response) => {
  openSseStream(req.params.vin, req, res);
});

export default router;
