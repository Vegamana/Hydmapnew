#!/usr/bin/env bash
# Cloudflare Pages build command.
#
# There is no bundler; this is the entire "build". It stamps the public
# environment variables into frontend/js/config.js so the deployed site has
# real values while the repo keeps placeholders.
#
# Set in Pages -> Settings -> Environment variables:
#   SUPABASE_URL, SUPABASE_ANON_KEY, GOOGLE_MAPS_BROWSER_KEY,
#   RAZORPAY_KEY_ID, PAYMENTS_ENABLED
set -euo pipefail

CONFIG="frontend/js/config.js"

require() {
  if [ -z "${!1:-}" ]; then
    echo "Missing environment variable: $1" >&2
    exit 1
  fi
}

require SUPABASE_URL
require SUPABASE_ANON_KEY
require GOOGLE_MAPS_BROWSER_KEY

: "${RAZORPAY_KEY_ID:=}"
: "${PAYMENTS_ENABLED:=false}"

# '|' as the sed delimiter because every value here contains slashes.
sed -i.bak \
  -e "s|__SUPABASE_URL__|${SUPABASE_URL}|g" \
  -e "s|__SUPABASE_ANON_KEY__|${SUPABASE_ANON_KEY}|g" \
  -e "s|__GOOGLE_MAPS_BROWSER_KEY__|${GOOGLE_MAPS_BROWSER_KEY}|g" \
  -e "s|__RAZORPAY_KEY_ID__|${RAZORPAY_KEY_ID}|g" \
  -e "s|__PAYMENTS_ENABLED__|${PAYMENTS_ENABLED}|g" \
  "$CONFIG"

rm -f "${CONFIG}.bak"

if grep -q "__[A-Z_]*__" "$CONFIG"; then
  echo "config.js still has unreplaced placeholders:" >&2
  grep -o "__[A-Z_]*__" "$CONFIG" >&2
  exit 1
fi

echo "config.js stamped for ${SUPABASE_URL}"
