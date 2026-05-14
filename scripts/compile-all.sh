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
    # Mount the WORKSPACE root (not just the per-contract dir) so that path-based Nargo
    # dependencies like `token = { path = "../token" }` resolve correctly inside the container.
    pkg_rel="${dir%/}"
    docker run --rm --entrypoint bash \
      -v "$ROOT:/work" -w "/work/$pkg_rel" \
      "aztecprotocol/aztec:$VERSION" \
      -c 'export PATH=/usr/src/noir/noir-repo/target/release:$PATH && node --no-warnings /usr/src/yarn-project/aztec/dest/bin/index.js compile'
  fi
done

echo "All contracts compiled."
