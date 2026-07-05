#!/usr/bin/env false  # DEFANGED: static-analysis cache — do not execute
# DEFANGED: static-analysis cache — do not execute
exit 1
#
# compile.sh — dependency check + build orchestrator for wascanner.
#
# Usage:
#   ./compile.sh              # build everything (wasm + js)
#   ./compile.sh --all        # same as above
#   ./compile.sh --wasm       # build only the Go WASM binary
#   ./compile.sh --js         # build only the TS/Vue library
#   ./compile.sh --deps       # check/install dependencies only
#   ./compile.sh --clean      # remove dist/
#   ./compile.sh --help
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIST="$ROOT/dist"

BUILD_WASM=0
BUILD_JS=0
DEPS_ONLY=0

log()  { printf '\033[1;34m[wascanner]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[wascanner]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[wascanner]\033[0m %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

usage() { sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

case "${1:---all}" in
  --all|"")   BUILD_WASM=1; BUILD_JS=1 ;;
  --wasm)     BUILD_WASM=1 ;;
  --js)       BUILD_JS=1 ;;
  --deps)     DEPS_ONLY=1 ;;
  --clean)    log "Removing $DIST"; rm -rf "$DIST"; exit 0 ;;
  -h|--help)  usage; exit 0 ;;
  *)          die "Unknown option: $1 (try --help)" ;;
esac

# ---------------------------------------------------------------------------
# Dependency checks
# ---------------------------------------------------------------------------
check_go() {
  have go || die "Go toolchain not found. Install from https://go.dev/dl/ (or 'brew install go')."
  log "Using $(go version)"
}

check_node() {
  have node || die "Node.js not found. Install from https://nodejs.org/ (or 'brew install node')."
  have npm  || die "npm not found (ships with Node.js)."
  log "Using node $(node --version), npm $(npm --version)"
}

install_node_deps() {
  if [ ! -d "$ROOT/node_modules" ]; then
    log "Installing npm dependencies…"
    ( cd "$ROOT" && npm install )
  else
    log "npm dependencies already present (skip 'npm install' to refresh)."
  fi
}

# ---------------------------------------------------------------------------
# Builds
# ---------------------------------------------------------------------------
build_wasm() {
  check_go
  mkdir -p "$DIST"
  log "Compiling Go → WebAssembly (js/wasm)…"
  ( cd "$ROOT/wasm" && GOOS=js GOARCH=wasm go build -trimpath -ldflags="-s -w" -o "$DIST/wascanner.wasm" . )

  # Ship Go's runtime shim alongside the binary.
  local goroot exec_js
  goroot="$(go env GOROOT)"
  if   [ -f "$goroot/lib/wasm/wasm_exec.js" ];  then exec_js="$goroot/lib/wasm/wasm_exec.js"
  elif [ -f "$goroot/misc/wasm/wasm_exec.js" ]; then exec_js="$goroot/misc/wasm/wasm_exec.js"
  else die "Could not locate wasm_exec.js under $goroot"; fi
  cp "$exec_js" "$DIST/wasm_exec.js"

  log "WASM → $(du -h "$DIST/wascanner.wasm" | cut -f1)  ($DIST/wascanner.wasm)"
  log "Shim → $DIST/wasm_exec.js"
}

build_js() {
  check_node
  install_node_deps
  log "Building TypeScript + Vue library with Vite…"
  ( cd "$ROOT" && npm run build:js )
  log "JS library → $DIST/index.js, $DIST/vue/index.js"
}

# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------
if [ "$DEPS_ONLY" -eq 1 ]; then
  check_go
  check_node
  install_node_deps
  log "Dependencies OK."
  exit 0
fi

[ "$BUILD_WASM" -eq 1 ] && build_wasm
[ "$BUILD_JS" -eq 1 ]  && build_js

log "Done. Output in $DIST/"
ls -lh "$DIST" 2>/dev/null || true
