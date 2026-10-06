#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
manifest="$project_dir/tools/local-solver/Cargo.toml"
binary="$project_dir/tools/local-solver/target/release/poker-solver-sidecar"

if command -v cargo >/dev/null 2>&1; then
  cargo_cmd=$(command -v cargo)
else
  tool_root="$project_dir/.local-tools/rust"
  cargo_cmd="$tool_root/cargo/bin/cargo"
  if [ ! -x "$cargo_cmd" ]; then
    echo "Rust is required to build the local solver. Run: npm run solver:install-toolchain" >&2
    exit 1
  fi
  export CARGO_HOME="$tool_root/cargo"
  export RUSTUP_HOME="$tool_root/rustup"
fi

if [ "${1:-}" = "--build-only" ]; then
  "$cargo_cmd" build --release --locked --manifest-path "$manifest"
  exit 0
fi

if [ ! -x "$binary" ]; then
  "$cargo_cmd" build --release --locked --manifest-path "$manifest"
fi

exec "$binary"
