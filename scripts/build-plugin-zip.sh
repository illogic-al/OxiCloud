#!/usr/bin/env bash
# Build the example plugin (wasm/oxicloud-plugin-hello) and bundle its
# plugin.toml + compiled .wasm into an installable .zip — the exact shape the
# admin "Install a plugin" upload (and POST /api/admin/plugins) expects.
#
# Output: dist/oxicloud-plugin-hello.zip  (plugin.toml + hello.wasm at the root)
#
# Requirements: the wasm32-unknown-unknown target. The devenv provides it via
# `languages.rust.targets` in devenv.nix; otherwise:
#     rustup target add wasm32-unknown-unknown

set -euo pipefail
cd "$(dirname "$0")/.."

CRATE=wasm/oxicloud-plugin-hello
# Pin the wasm build to the crate-local target dir. The devenv sets a global
# CARGO_TARGET_DIR (outside the repo) which would otherwise relocate the
# artifact away from the path below.
export CARGO_TARGET_DIR="$PWD/$CRATE/target"
ARTIFACT="$CRATE/target/wasm32-unknown-unknown/release/oxicloud_plugin_hello.wasm"
OUT_DIR=dist
OUT_ZIP="$OUT_DIR/oxicloud-plugin-hello.zip"
OUT_ZIP_ABS="$PWD/$OUT_ZIP"

echo "building $CRATE on wasm32-unknown-unknown…"
cargo build \
    --manifest-path "$CRATE/Cargo.toml" \
    --target wasm32-unknown-unknown \
    --release

# Stage plugin.toml + the module under the entrypoint name the manifest declares
# (entrypoint = "hello.wasm"), then zip the staging dir's contents at the root.
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cp "$CRATE/plugin.toml" "$STAGE/plugin.toml"
cp "$ARTIFACT" "$STAGE/hello.wasm"

mkdir -p "$OUT_DIR"
rm -f "$OUT_ZIP"
# `zip` isn't in the devenv toolchain; python3 is. `-c` creates an archive,
# storing the given paths. Run from the staging dir so entries are at the root.
( cd "$STAGE" && python3 -m zipfile -c "$OUT_ZIP_ABS" plugin.toml hello.wasm )

echo "bundled → $OUT_ZIP"
python3 -m zipfile -l "$OUT_ZIP"
