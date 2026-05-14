#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VERSION="$(tr -d '[:space:]' < "$ROOT/.aztec-version")"

if [ ! -d contracts ]; then
  echo "No contracts/ directory. Nothing to compile."
  exit 0
fi

for dir in contracts/*/; do
  if [ -f "$dir/Nargo.toml" ]; then
    echo "→ Compiling $dir"
    (cd "$dir" && VERSION="$VERSION" aztec compile)
  fi
done

echo "All contracts compiled."
