#!/bin/bash
# scripts/configure-telemetry.sh
#
# Push the telemetry field config to a vehicle.
# Auto-starts the local server and vehicle-command proxy if not already running,
# fetches the Tesla access token from the prod server (no local OAuth needed),
# then cleans up on exit.
#
# Usage:
#   ./scripts/configure-telemetry.sh                  # prompts for vehicle ID
#   ./scripts/configure-telemetry.sh <vehicle_id>
#   VEHICLE_ID=3744136962213327 ./scripts/configure-telemetry.sh

set -e

LOCAL_SERVER="http://localhost:3001"
PROXY_PORT=4443
PROXY_BIN="$HOME/vehicle-command/tesla-http-proxy"
PROXY_CERT="$HOME/vehicle-command/proxy-tls.crt"
PROXY_TLS_KEY="$HOME/vehicle-command/proxy-tls.key"
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Load .env for VEHICLE_ID and SERVER_HOST
if [ -f "$SCRIPT_DIR/.env" ]; then
  export $(grep -v '^#' "$SCRIPT_DIR/.env" | grep -E '^(VEHICLE_ID|SERVER_HOST)=' | xargs) 2>/dev/null || true
fi

VEHICLE_ID="${1:-${VEHICLE_ID:-}}"

if [ -z "$VEHICLE_ID" ]; then
  echo "Vehicle ID (numeric — from GET /api/vehicles):"
  read -r VEHICLE_ID
fi

if [ -z "$VEHICLE_ID" ]; then
  echo "❌  No vehicle ID provided. Exiting."
  exit 1
fi

if [ -z "$SERVER_HOST" ]; then
  echo "❌  SERVER_HOST not set in .env (e.g. https://fleet-telemetry-server.onrender.com)"
  exit 1
fi

PROD_SERVER="${SERVER_HOST%/}"  # strip trailing slash

# ── Cleanup ───────────────────────────────────────────────────────────────────

STARTED_PIDS=()
TMPBODY=""

cleanup() {
  if [ ${#STARTED_PIDS[@]} -gt 0 ]; then
    echo ""
    echo "Stopping background processes…"
    for pid in "${STARTED_PIDS[@]}"; do
      kill "$pid" 2>/dev/null || true
    done
  fi
  [ -n "$TMPBODY" ] && rm -f "$TMPBODY" 2>/dev/null || true
}
trap cleanup EXIT

# ── Start proxy if needed ─────────────────────────────────────────────────────

if lsof -i :$PROXY_PORT > /dev/null 2>&1; then
  echo "Vehicle-command proxy on :$PROXY_PORT ✔  (already running)"
elif [ -x "$PROXY_BIN" ]; then
  echo "Starting vehicle-command proxy…"
  "$PROXY_BIN" \
    -key-file "$SCRIPT_DIR/keys/private.pem" \
    -cert    "$PROXY_CERT" \
    -tls-key "$PROXY_TLS_KEY" \
    -port    $PROXY_PORT > /tmp/tesla-proxy.log 2>&1 &
  STARTED_PIDS+=($!)
  for i in $(seq 1 10); do
    sleep 0.5
    if lsof -i :$PROXY_PORT > /dev/null 2>&1; then
      echo "Proxy started ✔"
      break
    fi
    if [ "$i" -eq 10 ]; then
      echo "❌  Proxy failed to start — check /tmp/tesla-proxy.log"
      exit 1
    fi
  done
else
  echo "⚠  Proxy binary not found at $PROXY_BIN"
  echo "   Newer vehicles (api_version ≥ 3) will fail without it."
  read -rp "   Continue anyway? [y/N] " CONT
  [[ "$CONT" =~ ^[Yy]$ ]] || exit 0
fi

# ── Start local server if needed ──────────────────────────────────────────────

if curl -sf "$LOCAL_SERVER/health" > /dev/null 2>&1; then
  echo "Local server on :3001 ✔  (already running)"
else
  echo "Starting local server…"
  cd "$SCRIPT_DIR" && npm run dev > /tmp/fleet-telemetry-dev.log 2>&1 &
  STARTED_PIDS+=($!)
  echo -n "Waiting for server"
  for i in $(seq 1 30); do
    sleep 1
    if curl -sf "$LOCAL_SERVER/health" > /dev/null 2>&1; then
      echo " ✔"
      break
    fi
    echo -n "."
    if [ "$i" -eq 30 ]; then
      echo ""
      echo "❌  Local server failed to start — check /tmp/fleet-telemetry-dev.log"
      exit 1
    fi
  done
fi

# ── Fetch token from prod server (bypasses local OAuth state mismatch) ────────
#
# TESLA_REDIRECT_URI points to the prod server, so local OAuth can never complete.
# Instead, fetch the access token from the already-authenticated prod server and
# pass it as a Bearer header — resolveToken() on the local server accepts this.

echo "Fetching token from prod server ($PROD_SERVER)…"
TOKEN_RESP=$(curl -sf "$PROD_SERVER/auth/token" 2>/dev/null || echo '{}')
PROD_TOKEN=$(echo "$TOKEN_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('access_token',''))" 2>/dev/null || echo "")

if [ -z "$PROD_TOKEN" ]; then
  echo "Prod server has no token — opening Tesla login in browser…"
  open "$PROD_SERVER/auth/login" 2>/dev/null \
    || xdg-open "$PROD_SERVER/auth/login" 2>/dev/null \
    || echo "   → Open manually: $PROD_SERVER/auth/login"
  echo ""
  echo "Complete the Tesla login, then press Enter here."
  read -r _DUMMY

  TOKEN_RESP=$(curl -sf "$PROD_SERVER/auth/token" 2>/dev/null || echo '{}')
  PROD_TOKEN=$(echo "$TOKEN_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('access_token',''))" 2>/dev/null || echo "")

  if [ -z "$PROD_TOKEN" ]; then
    echo "❌  Still no token. Visit $PROD_SERVER/auth/login and try again."
    exit 1
  fi
fi

echo "Token fetched ✔"

# ── Configure telemetry ───────────────────────────────────────────────────────

echo ""
echo "Sending fleet_telemetry_config to vehicle $VEHICLE_ID…"
echo ""

TMPBODY=$(mktemp)

HTTP_CODE=$(curl -s -o "$TMPBODY" -w "%{http_code}" -X POST \
  "$LOCAL_SERVER/api/vehicles/$VEHICLE_ID/configure-telemetry" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $PROD_TOKEN")

python3 -m json.tool "$TMPBODY" 2>/dev/null || cat "$TMPBODY"
echo ""

if [ "$HTTP_CODE" = "200" ]; then
  echo "✅  Telemetry configured successfully!"
else
  echo "❌  Failed — HTTP $HTTP_CODE (see response above)"
  exit 1
fi
