#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
output="${1:-$root/outputs/pulse-linux-source.tar.gz}"
mkdir -p "$(dirname "$output")"

tar \
  --exclude='.git' \
  --exclude='.DS_Store' \
  --exclude='.env*' \
  --exclude='.dev.vars*' \
  --exclude='.next' \
  --exclude='.pnpm-store' \
  --exclude='.vinext' \
  --exclude='.wrangler' \
  --exclude='dist' \
  --exclude='node_modules' \
  --exclude='local-runtime/node_modules' \
  --exclude='local-runtime/data' \
  --exclude='local-runtime/vendor' \
  --exclude='harness-service/.venv' \
  --exclude='harness-service/data' \
  --exclude='harness-service/harness-service' \
  --exclude='__pycache__' \
  --exclude='*.pyc' \
  --exclude='outputs' \
  --exclude='work' \
  --exclude='tmp' \
  --exclude='tsconfig.tsbuildinfo' \
  -czf "$output" \
  -C "$root" .

chmod 0600 "$output"
printf '%s\n' "$output"
