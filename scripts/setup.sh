#!/usr/bin/env bash
# One-command install for macOS / Linux: dependencies, build, then the guided setup.
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required (version 20 or newer). Install it from https://nodejs.org and re-run." >&2
  exit 1
fi
major=$(node -p 'process.versions.node.split(".")[0]')
if [ "$major" -lt 20 ]; then
  echo "Node $(node -v) is too old; version 20 or newer is required." >&2
  exit 1
fi

echo "Installing dependencies..."
npm install --no-audit --no-fund
echo "Building..."
npm run build --silent

exec node dist/server.js setup
