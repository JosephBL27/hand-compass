#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
tool_root="$project_dir/.local-tools/rust"
installer="$tool_root/rustup-init"
mkdir -p "$tool_root"

if [ ! -x "$tool_root/cargo/bin/cargo" ]; then
  curl --proto '=https' --tlsv1.2 -fsSL https://sh.rustup.rs -o "$installer"
  chmod 700 "$installer"
  CARGO_HOME="$tool_root/cargo" RUSTUP_HOME="$tool_root/rustup" "$installer" -y --profile minimal --default-toolchain stable --no-modify-path
fi

echo "Local Rust toolchain ready: $tool_root/cargo/bin/cargo"

