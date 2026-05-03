#!/bin/bash
# scripts/configure-telemetry.sh
#
# Authenticate with Tesla and push the telemetry field config to a vehicle.
#
# Usage:
#   ./scripts/configure-telemetry.sh                  # prompts for everything
#   ./scripts/configure-telemetry.sh <vehicle_id>     # skips vehicle ID prompt
#   VEHICLE_ID=3744136962213327 ./scripts/configure-telemetry.sh
#
# Requires: curl
# Optional: set VEHICLE_COMMAND_PROXY_URL if your vehicle needs signed commands (api_version >= 3)

set -e

# ── Config ────────────────────────────────────────────────────────────────────

PROD_SERVER="https://fleet-telemetry-server.onrender.com"
LOCAL_SERVER="http://localhost:3001"

# Load .env for VEHICLE_ID if present
if [ -f .env ]; then
  export $(grep -v '^#' .env | grep -E '^VEHICLE_ID=' | xargs) 2>/dev/null || true
fi

VEHICLE_ID="${1:-${VEHICLE_ID:-}}"

# ── Step 1: vehicle ID ────────────────────────────────────────────────────────

if [ -z "$VEHICLE_ID" ]; then
  echo "Vehicle ID (numeric — from GET /api/vehicles or Tesla app):"
  read -r VEHICLE_ID
fi

if [ -z "$VEHICLE_ID" ]; then
  echo "❌  No vehicle ID provided. Exiting."
  exit 1
fi

# ── Step 2: get a fresh token with vehicle_location scope ─────────────────────

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " Step 1 of 2 — Authenticate"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo " Opening Tesla login in your browser…"
echo " → $PROD_SERVER/auth/login"
echo ""
echo " ✔ Log in with your Tesla account"
echo " ✔ Approve ALL permissions (including Location)"
echo " ✔ Copy the access_token from the JSON response"
echo ""

open "$PROD_SERVER/auth/login" 2>/dev/null \
  || xdg-open "$PROD_SERVER/auth/login" 2>/dev/null \
  || echo " (Could not open browser automatically — open the URL above manually)"

echo ""
read -rsp " Paste access_token: " TOKEN
echo ""

if [ -z "$TOKEN" ]; then
  echo "❌  No token provided. Exiting."
  exit 1
fi

# ── Step 3: proxy check ───────────────────────────────────────────────────────

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " Step 2 of 2 — Configure telemetry"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Prefer local server (uses local proxy for signed commands on newer vehicles).
# Fall back to production if local server is not running.
if curl -sf "$LOCAL_SERVER/health" > /dev/null 2>&1; then
  TARGET="$LOCAL_SERVER"
  echo " Using local server ($LOCAL_SERVER)"
  if curl -sf "https://localhost:4443" > /dev/null 2>&1 || \
     lsof -i :4443 > /dev/null 2>&1; then
    echo " Vehicle-command proxy detected on :4443 ✔"
  else
    echo " ⚠  No proxy on :4443 — newer vehicles (api_version ≥ 3) may fail."
    echo "    Start it with:"
    echo "    ~/vehicle-command/tesla-http-proxy \\"
    echo "      -key-file keys/private.pem \\"
    echo "      -cert ~/vehicle-command/proxy-tls.crt \\"
    echo "      -tls-key ~/vehicle-command/proxy-tls.key \\"
    echo "      -port 4443 -verbose"
    echo ""
    read -rp " Continue anyway? [y/N] " CONT
    [[ "$CONT" =~ ^[Yy]$ ]] || exit 0
  fi
else
  TARGET="$PROD_SERVER"
  echo " Local server not running — using production ($PROD_SERVER)"
fi

echo ""
echo " Sending fleet_telemetry_config to vehicle $VEHICLE_ID…"
echo ""

RESULT=$(curl -s -w "\n%{http_code}" -X POST \
  "$TARGET/api/vehicles/$VEHICLE_ID/configure-telemetry" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json")

HTTP_CODE=$(echo "$RESULT" | tail -1)
BODY=$(echo "$RESULT" | head -n -1)

echo "$BODY" | python3 -m json.tool 2>/dev/null || echo "$BODY"
echo ""

if [ "$HTTP_CODE" = "200" ]; then
  echo "✅  Telemetry configured successfully! (HTTP $HTTP_CODE)"
else
  echo "❌  Failed — HTTP $HTTP_CODE (see response above)"
  exit 1
fi
