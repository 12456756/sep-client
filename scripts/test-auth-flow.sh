#!/bin/bash
# Test complete SEP authentication flow
#
# Credentials are read from the environment — nothing is hardcoded.
#   SEP_BASE_URL   backend base URL (default: http://localhost:3001)
#   SEP_EMAIL      login email      (required)
#   SEP_PASSWORD   login password   (required)
#
# Usage:
#   SEP_EMAIL=you@example.com SEP_PASSWORD=... ./scripts/test-auth-flow.sh

set -euo pipefail

BASE_URL="${SEP_BASE_URL:-http://localhost:3001}"
EMAIL="${SEP_EMAIL:-}"
PASSWORD="${SEP_PASSWORD:-}"
FINGERPRINT="${SEP_FINGERPRINT:-test-device-cli}"
PLATFORM="${SEP_PLATFORM:-$(uname | tr '[:upper:]' '[:lower:]')}"

if [[ -z "$EMAIL" || -z "$PASSWORD" ]]; then
  echo "error: SEP_EMAIL and SEP_PASSWORD must be set" >&2
  echo "  SEP_EMAIL=you@example.com SEP_PASSWORD=... $0" >&2
  exit 1
fi

command -v jq >/dev/null || { echo "error: jq is required" >&2; exit 1; }

# Build JSON bodies with jq so values are escaped rather than interpolated.
echo "=== Step 1: Login ==="
LOGIN_BODY=$(jq -nc \
  --arg email "$EMAIL" \
  --arg password "$PASSWORD" \
  --arg fingerprint "$FINGERPRINT" \
  --arg platform "$PLATFORM" \
  '{email: $email, password: $password, fingerprint: $fingerprint, platform: $platform}')

LOGIN_RESPONSE=$(curl -s -X POST "$BASE_URL/client/auth/login" \
  -H "Content-Type: application/json" \
  -d "$LOGIN_BODY")

# Print the shape of the response without leaking token values.
echo "$LOGIN_RESPONSE" | jq '{accessToken: (.accessToken | if . then "<redacted>" else null end),
                             refreshToken: (.refreshToken | if . then "<redacted>" else null end)}
                            + (del(.accessToken, .refreshToken))'

ACCESS_TOKEN=$(echo "$LOGIN_RESPONSE" | jq -r '.accessToken // empty')
REFRESH_TOKEN=$(echo "$LOGIN_RESPONSE" | jq -r '.refreshToken // empty')

if [[ -z "$ACCESS_TOKEN" || -z "$REFRESH_TOKEN" ]]; then
  echo "error: login did not return tokens" >&2
  exit 1
fi

echo ""
echo "=== Step 2: Get Instances ==="
SUBSCRIPTIONS=$(curl -s -X GET "$BASE_URL/client/subscriptions" \
  -H "Authorization: Bearer $ACCESS_TOKEN")

echo "$SUBSCRIPTIONS" | jq '.'

SUBSCRIPTION_ID=$(echo "$SUBSCRIPTIONS" | jq -r '.[0].id // empty')

if [[ -z "$SUBSCRIPTION_ID" ]]; then
  echo "error: no instances returned for this account" >&2
  exit 1
fi

echo ""
echo "=== Step 3: Get Instance Token ==="
TOKEN_BODY=$(jq -nc \
  --arg refreshToken "$REFRESH_TOKEN" \
  --arg subscriptionId "$SUBSCRIPTION_ID" \
  '{refreshToken: $refreshToken, subscriptionId: $subscriptionId}')

TOKEN_RESPONSE=$(curl -s -X POST "$BASE_URL/client/auth/token" \
  -H "Content-Type: application/json" \
  -d "$TOKEN_BODY")

# instanceToken is a live credential — report only its presence and TTL.
echo "$TOKEN_RESPONSE" | jq '{instanceToken: (.instanceToken | if . then "<redacted>" else null end),
                             expiresIn, instance}'

if [[ "$(echo "$TOKEN_RESPONSE" | jq -r '.instanceToken // empty')" == "" ]]; then
  echo "error: token exchange failed" >&2
  exit 1
fi

echo ""
echo "✅ Authentication flow completed successfully!"
