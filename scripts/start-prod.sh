#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
SERVER_DIR="$ROOT/Overlord-Server"
BUN_BIN="${BUN_BIN:-bun}"

cd "$SERVER_DIR"
if ! command -v "$BUN_BIN" >/dev/null 2>&1; then
	echo "[server] bun not found. Set BUN_BIN to your bun binary or install bun for this environment." >&2
	exit 1
fi
echo "[server] using bun at: $(command -v $BUN_BIN)"

echo "[build] bun install..."
"$BUN_BIN" install

echo "[build] building Tailwind CSS..."
"$BUN_BIN" run build:css

echo "[build] building server bundle..."
"$BUN_BIN" run build

echo "[build] compiling Linux production executable..."
"$BUN_BIN" run build:prod:linux

echo "[build] copying Overlord-Client source for runtime builds..."
mkdir -p "$SERVER_DIR/dist/Overlord-Client"
rsync -a --exclude='build' --exclude='.git' --exclude='.vscode' "$ROOT/Overlord-Client/" "$SERVER_DIR/dist/Overlord-Client/" 2>/dev/null \
	|| {
		rm -rf "$SERVER_DIR/dist/Overlord-Client"
		cp -a "$ROOT/Overlord-Client" "$SERVER_DIR/dist/Overlord-Client"
		rm -rf "$SERVER_DIR/dist/Overlord-Client/build" "$SERVER_DIR/dist/Overlord-Client/.git" "$SERVER_DIR/dist/Overlord-Client/.vscode"
	}

echo "[server] starting compiled executable..."
PORT="${PORT:-5173}" \
HOST="${HOST:-0.0.0.0}" \
OVERLORD_USER="${OVERLORD_USER:-admin}" \
LOG_LEVEL="${LOG_LEVEL:-info}" \
NODE_ENV="${NODE_ENV:-production}" \
OVERLORD_ROOT="$SERVER_DIR" \
"$SERVER_DIR/dist/overlord-server-linux-x64"
