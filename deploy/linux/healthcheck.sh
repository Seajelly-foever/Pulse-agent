#!/usr/bin/env bash
set -euo pipefail

web_url="${PULSE_WEB_URL:-http://127.0.0.1:3000}"
gateway_url="${PULSE_GATEWAY_URL:-http://127.0.0.1:8789/health}"
harness_url="${PULSE_HARNESS_URL:-http://127.0.0.1:8090/health}"

check() {
  local name="$1"
  local url="$2"
  if curl --fail --silent --show-error --max-time 10 "$url" >/dev/null; then
    printf '%s: ok\n' "$name"
  else
    printf '%s: failed (%s)\n' "$name" "$url" >&2
    return 1
  fi
}

check harness "$harness_url"
check gateway "$gateway_url"
check web "$web_url"
printf 'Pulse healthcheck: ok\n'
