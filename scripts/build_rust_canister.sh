#!/usr/bin/env bash
set -euo pipefail

CRATE_NAME="${1:-stablecoin}"

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CRATE_DIR="$ROOT_DIR/canisters/$CRATE_NAME"

if [[ ! -d "$CRATE_DIR" ]]; then
  echo "Canister crate not found: $CRATE_DIR" >&2
  exit 1
fi

echo "Building Rust canister: $CRATE_NAME"
pushd "$CRATE_DIR" >/dev/null

# Respect custom cargo target dir if provided
TARGET_DIR="${CARGO_TARGET_DIR:-$CRATE_DIR/target}"

# Build to wasm32-unknown-unknown
cargo build --target wasm32-unknown-unknown --release

WASM_PATH="$TARGET_DIR/wasm32-unknown-unknown/release/${CRATE_NAME}.wasm"

# Optionally optimize if ic-cdk-optimizer is installed
if command -v ic-cdk-optimizer >/dev/null 2>&1; then
  echo "Optimizing wasm with ic-cdk-optimizer"
  ic-cdk-optimizer "$WASM_PATH" -o "$WASM_PATH"
else
  echo "ic-cdk-optimizer not found; skipping optimization"
fi

popd >/dev/null
echo "Built $CRATE_NAME at $WASM_PATH"
