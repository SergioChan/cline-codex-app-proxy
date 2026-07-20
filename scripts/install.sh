#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 18+ is required. Install Node from https://nodejs.org/ and rerun this script." >&2
  exit 1
fi

NODE_MAJOR="$(node -p "Number(process.versions.node.split('.')[0])")"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "Node.js 18+ is required. Current version: $(node --version)" >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required for the source installation." >&2
  exit 1
fi

cd "$ROOT"
npm install
npm run build:gui
npm run install:global

if ! command -v ocx >/dev/null 2>&1 || ! ocx help >/dev/null; then
  echo "The package was installed, but 'ocx' is unavailable. Check your npm global PATH." >&2
  exit 1
fi

echo "Installed cline-codex-app-proxy from $ROOT"
echo "Next: ocx cline setup"
