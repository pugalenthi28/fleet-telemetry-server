#!/bin/bash
# scripts/configure-telemetry.sh
#
# Push the telemetry field config to a vehicle.
# Uses the token already stored on the server — only prompts for login if needed.
#
# Usage:
#   ./scripts/configure-telemetry.sh                  # prompts for vehicle ID
#   ./scripts/configure-telemetry.sh <vehicle_id>
#   VEHICLE_ID=3744136962213327 ./scripts/configure-telemetry.sh

set -e

PROD_SERVER="https://fleet-telemetry-server.onrender.com"
LOCAL_SERVER="http://localhost:3001"

# Load .env for VEHICLE_ID if present
if [ -f .env ]; then
  export $(grep -v '^#' .env | grep -E '^VEHICLE_ID=' | xargs) 2>/dev/null || true
fi

VEHICLE_ID="${1:-${VEHICLE_ID:-}}"

# ── Vehicle ID ────────────────────────────────────────────────────────────────

if [ -z "$VEHICLE_ID" ]; then
  echo "Vehicle ID (numeric — from GET /api/vehicles):"
  read -r VEHICLE_ID
fi

if [ -z "$VEHICLE_ID" ]; then
  echo "❌  No vehicle ID provided. Exiting."
  exit 1
fi

# ── Pick server ───────────────────────────────────────────────────────────────

if curl -sf "$LOCAL_SERVER/health" > /dev/null 2>&1; then
  TARGET="$LOCAL_SERVER"
  echo "Using local server ($LOCAL_SERVER)"
  if lsof -i :4443 > /dev/null 2>&1; then
    echo "Vehicle-command proxy on :4443 ✔"
  else
    echo "⚠  No proxy on :4443 — newer vehicles (api_version ≥ 3) may fail."
    echo "   Start: ~/vehicle-command/tesla-http-proxy -key-file keys/private.pem -cert ~/vehicle-command/proxy-tls.crt -tls-key ~/vehicle-command/proxy-tls.key -port 4443 -verbose"
    echo ""
    read -rp "Continue anyway? [y/N] " CONT
    [[ "$CONT" =~ ^[Yy]$ ]] || exit 0
  fi
else
  TARGET="$PROD_SERVER"
  echo "Using production server ($PROD_SERVER)"
fi

# ── Check auth — use stored token, only login if missing ─────────────────────

AUTH_STATUS=$(curl -sf "$TARGET/auth/status" 2>/dev/null || echo '{"authenticated":false}')
AUTHENTICATED=$(echo "$AUTH_STATUS" | python3 -c "import sys,json; print(json.load(sys.stdin).get('authenticated','false'))" 2>/dev/null || echo "false")

AUTH_HEADER=""
if [ "$AUTHENTICATED" = "True" ] || [ "$AUTHENTICATED" = "true" ]; then
  echo "Server already authenticated ✔  (using stored token)"
else
  echo ""
  echo "Server has no token — opening Tesla login…"
  echo "→ $PROD_SERVER/auth/login"
  echo ""
  echo "After login, copy the access_token from the page and paste it below."
  echo ""
  open "$PROD_SERVER/auth/login" 2>/dev/null \
    || xdg-open "$PROD_SERVER/auth/login" 2>/dev/null \
    || true

  echo "Copy the access_token from the page, then press Enter here."
  read -r _DUMMY

  # Read from clipboard (macOS pbpaste / Linux xclip)
  if command -v pbpaste &>/dev/null; then
    TOKEN=$(pbpaste | tr -d '[:space:]')
  elif command -v xclip &>/dev/null; then
    TOKEN=$(xclip -selection clipboard -o | tr -d '[:space:]')
  fi

  if [ -z "$TOKEN" ]; then
    echo "❌  Clipboard empty or unreadable. Exiting."
    exit 1
  fi
  echo "Token read from clipboard ✔"
  AUTH_HEADER="-H \"Authorization: Bearer $TOKEN\""
fi

# ── Configure telemetry ───────────────────────────────────────────────────────

echo ""
echo "Sending fleet_telemetry_config to vehicle $VEHICLE_ID…"
echo ""

TMPBODY=$(mktemp)
trap "rm -f $TMPBODY" EXIT

if [ -n "$TOKEN" ]; then
  HTTP_CODE=$(curl -s -o "$TMPBODY" -w "%{http_code}" -X POST \
    "$TARGET/api/vehicles/$VEHICLE_ID/configure-telemetry" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json")
else
  HTTP_CODE=$(curl -s -o "$TMPBODY" -w "%{http_code}" -X POST \
    "$TARGET/api/vehicles/$VEHICLE_ID/configure-telemetry" \
    -H "Content-Type: application/json")
fi

python3 -m json.tool "$TMPBODY" 2>/dev/null || cat "$TMPBODY"
echo ""

if [ "$HTTP_CODE" = "200" ]; then
  echo "✅  Telemetry configured successfully!"
else
  echo "❌  Failed — HTTP $HTTP_CODE (see response above)"
  exit 1
fi
