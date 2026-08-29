#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
SERVER_SRC="$ROOT/Overlord-Server"
CLIENT_SRC="$ROOT/Overlord-Client"
LITE_SRC="$ROOT/Overlord-Lite"
LITE_PLUGIN_SRC="$ROOT/plugins/rust-lite-builder"
DIST_CLIENTS_SRC="$ROOT/dist-clients"
RELEASE_DIR="$ROOT/release/prod-package"

if [[ ! -f "$SERVER_SRC/package.json" ]]; then
  echo "[error] Overlord-Server not found at: $SERVER_SRC" >&2
  exit 1
fi

if [[ ! -f "$CLIENT_SRC/go.mod" ]]; then
  echo "[error] Overlord-Client not found at: $CLIENT_SRC" >&2
  exit 1
fi

if [[ ! -f "$LITE_SRC/Cargo.toml" ]]; then
  echo "[error] Overlord-Lite not found at: $LITE_SRC" >&2
  exit 1
fi

if [[ ! -f "$LITE_PLUGIN_SRC/config.json" ]]; then
  echo "[error] Rust Lite Builder plugin not found at: $LITE_PLUGIN_SRC" >&2
  exit 1
fi

if ! command -v bun >/dev/null 2>&1; then
  echo "[error] bun was not found in PATH." >&2
  exit 1
fi

if ! command -v go >/dev/null 2>&1; then
  echo "[error] go was not found in PATH." >&2
  exit 1
fi

copy_tree_excluding() {
  local src="$1"
  local dst="$2"
  shift 2

  mkdir -p "$dst"
  if command -v rsync >/dev/null 2>&1; then
    local excludes=()
    for pattern in "$@"; do
      excludes+=(--exclude "$pattern")
    done
    rsync -a --delete "${excludes[@]}" "$src/" "$dst/"
  else
    local tar_excludes=()
    for pattern in "$@"; do
      tar_excludes+=("--exclude=$pattern")
    done
    (cd "$src" && tar "${tar_excludes[@]}" -cf - .) | (cd "$dst" && tar -xf -)
  fi
}

echo "[1/6] Building server bundle..."
pushd "$SERVER_SRC" >/dev/null
bun install
bun run build:css
bun run build
popd >/dev/null

echo "[2/6] Skipping prebuilt client binaries (prod package exports client source only)"

echo "[3/6] Preparing release folder..."
rm -rf "$RELEASE_DIR"
mkdir -p "$RELEASE_DIR"

echo "[4/6] Exporting Overlord-Server..."
copy_tree_excluding "$SERVER_SRC" "$RELEASE_DIR/Overlord-Server" "node_modules" ".git" ".vscode"

echo "[5/6] Exporting Overlord-Client source for runtime builds..."
copy_tree_excluding "$CLIENT_SRC" "$RELEASE_DIR/Overlord-Client" "build" ".git" ".vscode"

echo "[6/6] Exporting Overlord-Lite source and Rust builder plugin..."
copy_tree_excluding "$LITE_SRC" "$RELEASE_DIR/Overlord-Lite" "target" ".git" ".vscode"
copy_tree_excluding "$LITE_PLUGIN_SRC" "$RELEASE_DIR/Overlord-Server/plugins/rust-lite-builder" "data" "rust-lite-builder.zip"

echo "[extra] Minifying and fingerprinting production web assets..."
pushd "$SERVER_SRC" >/dev/null
bun run scripts/minify-public.ts --dir "$RELEASE_DIR/Overlord-Server/public"
bun run scripts/fingerprint-public-assets.ts --dir "$RELEASE_DIR/Overlord-Server/public"
popd >/dev/null

if [[ -d "$DIST_CLIENTS_SRC" ]]; then
  echo "[extra] Copying prebuilt dist-clients..."
  mkdir -p "$RELEASE_DIR/dist-clients"
  cp -a "$DIST_CLIENTS_SRC/." "$RELEASE_DIR/dist-clients/"
fi

cat > "$RELEASE_DIR/start-prod-release.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT/Overlord-Server"
export HOST="${HOST:-0.0.0.0}"
export PORT="${PORT:-5173}"
export LOG_LEVEL="${LOG_LEVEL:-info}"
export NODE_ENV="${NODE_ENV:-production}"
bun install
bun run src/index.ts
EOF
chmod +x "$RELEASE_DIR/start-prod-release.sh"

echo
echo "[ok] Production package created:"
echo "     $RELEASE_DIR"
echo
echo "Run this from the package folder:"
echo "     ./start-prod-release.sh"
