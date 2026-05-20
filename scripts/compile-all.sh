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

# Noir circuits (non-contract). Same docker image as contracts to keep the
# nargo binary aligned with .aztec-version. The circuit's target/ is mounted
# back via the workspace bind so the host sees the produced clearing.json.
if [ -d circuits ]; then
  for dir in circuits/*/; do
    if [ -f "$dir/Nargo.toml" ]; then
      echo "→ Compiling $dir"
      pkg_rel="${dir%/}"
      docker run --rm --entrypoint bash \
        -v "$ROOT:/work" -w "/work/$pkg_rel" \
        "aztecprotocol/aztec:$VERSION" \
        -c 'export PATH=/usr/src/noir/noir-repo/target/release:$PATH && nargo compile --silence-warnings'

      # bb write_vk produces the verification key 5d-3 will embed on-chain.
      # bb binary path: /usr/src/barretenberg/ts/build/arm64-linux/bb
      # (not /usr/src/barretenberg/cpp/build/bin/bb — that path is absent in 4.2.1)
      pkg_name="$(basename "$pkg_rel")"
      bc_path="$pkg_rel/target/$pkg_name.json"
      vk_path="$pkg_rel/target/vk.bin"
      if [ -f "$ROOT/$bc_path" ]; then
        echo "→ Writing VK for $pkg_rel"
        docker run --rm --entrypoint bash \
          -v "$ROOT:/work" -w /work \
          "aztecprotocol/aztec:$VERSION" \
          -c "/usr/src/barretenberg/ts/build/arm64-linux/bb write_vk -b $bc_path -o $vk_path -t noir-recursive"
      fi
    fi
  done
  echo "All circuits compiled + VKs written."
fi
