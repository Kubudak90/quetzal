# ZSwap-on-Aztec — Week 1: Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scaffold the ZSwap monorepo with Aztec toolchain pinned, two deployable test-token contracts (tUSDC and tETH), green Noir TXE tests, green TypeScript integration tests, and CI compiling on every PR.

**Architecture:** pnpm workspaces monorepo. Each Noir contract is a separate Nargo package under `contracts/`. TypeScript packages under `aggregator/`, `cli/`, `tests/`. Test tokens depend on `@defi-wonderland/aztec-standards` token contract as a Nargo git dependency, configured with a mint authority for testing. Aztec 4.x removed the self-contained sandbox, so local development uses `scripts/dev.sh` which orchestrates `anvil` (L1, from Foundry) + `aztec start --local-network` (L2). CI uses both as service containers.

**Tech Stack:** Aztec `v4.2.1` (Aztec Sandbox, `aztec-nr`, Noir, Barretenberg Honk prover), `@aztec/aztec.js`, Node 22, pnpm 9+, TypeScript 5.6+, Vitest.

**Reference spec:** `docs/superpowers/specs/2026-05-14-zswap-aztec-mvp-design.md`

---

## File Structure (created in this plan)

```
aztec-project/
├── .github/workflows/
│   └── ci.yml                           # CI pipeline
├── .gitignore
├── package.json                         # root, defines pnpm workspaces
├── pnpm-workspace.yaml
├── pnpm-lock.yaml                       # auto-generated
├── README.md                            # quickstart
├── tsconfig.base.json                   # shared TS config
├── .nvmrc                               # Node version pin
├── .aztec-version                       # Aztec version pin (informational)
├── contracts/
│   ├── token-a/
│   │   ├── Nargo.toml
│   │   ├── src/main.nr                  # tUSDC contract
│   │   └── src/test.nr                  # TXE tests
│   └── token-b/
│       ├── Nargo.toml
│       ├── src/main.nr                  # tETH contract
│       └── src/test.nr                  # TXE tests
├── tests/
│   ├── package.json
│   ├── tsconfig.json
│   ├── vitest.config.ts
│   └── integration/
│       ├── tokens.test.ts               # token deploy/mint/transfer
│       └── helpers/
│           ├── sandbox.ts               # start/stop sandbox helpers
│           └── wallets.ts               # test wallet helpers
└── scripts/
    ├── deploy-tokens.ts                 # one-shot local deploy
    └── compile-all.sh                   # compile every contract package
```

---

## Pre-flight: Verify environment

- [ ] **Step 0: Check current state and verify host environment**

Run these from the repo root (`/Users/huseyinarslan/Desktop/aztec-project`):

```bash
node --version          # expect: v22.x or newer
pnpm --version          # expect: 9.x or newer (install via: corepack enable && corepack prepare pnpm@latest --activate)
docker --version        # expect: Docker installed and daemon running
git log --oneline -5    # expect: at least one commit (the spec commit 1eb9443)
ls docs/superpowers/specs/  # expect: 2 spec files
```

If any check fails, stop and resolve before continuing. The plan assumes Node 22, pnpm 9+, Docker running, and the spec already committed.

---

## Task 1: Install toolchain, pin versions, dev orchestrator

Aztec 4.x removed the self-contained sandbox. Local development requires an external L1 (we use anvil from Foundry). The pinned version is invoked via `VERSION=4.2.1 aztec ...` because Aztec's wrapper script reads `VERSION` (or `NETWORK`) env var and defaults to `:latest`; `docker tag` retags don't persist across `aztec` invocations because the wrapper re-pulls `:latest` on each call.

**Files:**
- Create: `.aztec-version` (read by scripts to pin Docker image tag)
- Create: `.nvmrc`
- Create: `scripts/dev.sh` (anvil + Aztec local-network orchestrator)

- [ ] **Step 1: Install the Aztec CLI (if not already installed)**

```bash
which aztec || bash -i <(curl -s https://install.aztec.network)
```

Expected: `which aztec` returns `~/.aztec/bin/aztec`.

- [ ] **Step 2: Install Foundry / anvil (if not already installed)**

```bash
which anvil || (curl -L https://foundry.paradigm.xyz | bash && foundryup)
```

Expected: `anvil --version` returns a version (e.g., `anvil Version: 1.5.x`).

- [ ] **Step 3: Pull the pinned Aztec Docker image**

```bash
export VERSION=4.2.1
aztec-up -v "$VERSION"
docker pull aztecprotocol/aztec:$VERSION
VERSION=$VERSION aztec --version
```

Expected: Last command reports `4.2.1`. (Note: `aztec --version` *without* `VERSION=` will hit `:latest`, which may differ — this is the wrapper's default behavior, not a misconfiguration.)

- [ ] **Step 4: Record the version pins in repo**

Create `.aztec-version`:

```
4.2.1
```

Create `.nvmrc`:

```
22
```

- [ ] **Step 5: Create `scripts/dev.sh` orchestrator**

This script starts anvil + Aztec local-network together and tears them down on Ctrl+C. It reads the version pin from `.aztec-version`.

```bash
#!/usr/bin/env bash
#
# Start the local dev stack: anvil (L1) + Aztec local-network (L2).
#
# Aztec 4.x removed the self-contained sandbox; local development requires an
# external L1 RPC. We use anvil from Foundry (https://book.getfoundry.sh).
#
# Usage:
#   scripts/dev.sh             # start both, foreground; Ctrl+C stops both
#   scripts/dev.sh --down      # stop everything started by a previous run
#
# Endpoints when ready:
#   anvil:  http://localhost:8545
#   aztec:  http://localhost:8080 (PXE / Aztec node JSON-RPC)
#

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VERSION="$(tr -d '[:space:]' < "$ROOT/.aztec-version")"
ANVIL_PORT=8545
AZTEC_PORT=8080
L1_CHAIN_ID=31337
ANVIL_PID_FILE="$ROOT/.aztec-store/anvil.pid"
mkdir -p "$ROOT/.aztec-store"

cleanup() {
  echo
  echo "→ Stopping Aztec containers..."
  docker ps --filter "ancestor=aztecprotocol/aztec:$VERSION" --format '{{.ID}}' \
    | xargs -r docker stop > /dev/null || true
  if [ -f "$ANVIL_PID_FILE" ]; then
    local pid
    pid="$(cat "$ANVIL_PID_FILE")"
    if kill -0 "$pid" 2>/dev/null; then
      echo "→ Stopping anvil (pid $pid)..."
      kill "$pid" 2>/dev/null || true
    fi
    rm -f "$ANVIL_PID_FILE"
  fi
  echo "→ Done."
}

# --down command
if [ "${1:-}" = "--down" ]; then
  cleanup
  exit 0
fi

# Sanity checks
command -v docker >/dev/null || { echo "docker not found in PATH"; exit 1; }
command -v anvil >/dev/null || {
  cat <<EOF
anvil not found. Install Foundry first:
  curl -L https://foundry.paradigm.xyz | bash
  foundryup
EOF
  exit 1
}
docker info >/dev/null 2>&1 || { echo "Docker daemon not running"; exit 1; }

# Refuse to run if anvil is already on the port (might be the user's other work)
if lsof -i ":$ANVIL_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port $ANVIL_PORT already in use. Stop the other anvil first or run: scripts/dev.sh --down"
  exit 1
fi

# Start anvil
echo "→ Starting anvil on :$ANVIL_PORT (chain $L1_CHAIN_ID)..."
anvil --port "$ANVIL_PORT" --chain-id "$L1_CHAIN_ID" --silent > "$ROOT/.aztec-store/anvil.log" 2>&1 &
ANVIL_PID=$!
echo "$ANVIL_PID" > "$ANVIL_PID_FILE"

# Trap so Ctrl+C cleans up both
trap cleanup INT TERM EXIT

# Wait for anvil to accept JSON-RPC
for i in $(seq 1 30); do
  if curl -sf -X POST -H "Content-Type: application/json" \
      -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
      "http://localhost:$ANVIL_PORT" > /dev/null 2>&1; then
    echo "→ anvil ready."
    break
  fi
  sleep 1
  if [ "$i" = "30" ]; then echo "anvil failed to come up"; exit 1; fi
done

# Start Aztec local-network in the foreground (this blocks)
echo "→ Starting Aztec local-network ($VERSION) on :$AZTEC_PORT..."
VERSION="$VERSION" aztec start --local-network \
  --l1-rpc-urls "http://host.docker.internal:$ANVIL_PORT" \
  --l1-chain-id "$L1_CHAIN_ID"
```

Make it executable:

```bash
chmod +x scripts/dev.sh
```

- [ ] **Step 6: Smoke-test the dev stack**

In one terminal:

```bash
scripts/dev.sh
```

Wait until Aztec output shows `Started sequencer` and (later) PXE endpoints are exposed. This takes ~60-90 sec on first run.

In a second terminal, verify both endpoints respond:

```bash
# anvil (block number)
curl -sf -X POST -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
  http://localhost:8545

# aztec node (responds to GET with 405 Method Not Allowed = service alive)
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8080
```

Expected: anvil returns a `{"result":"0x..."}` JSON; aztec returns `405`. Both indicate alive services.

Press `Ctrl+C` in the first terminal to tear down. Verify cleanup with:

```bash
docker ps --filter "ancestor=aztecprotocol/aztec:4.2.1"   # empty
lsof -i :8545                                              # empty
```

- [ ] **Step 7: Commit**

```bash
git add .aztec-version .nvmrc scripts/dev.sh
git commit -m "chore: pin Aztec to 4.2.1, add anvil + aztec dev orchestrator"
```

---

## Task 2: Scaffold pnpm workspace monorepo

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `.gitignore`
- Create: `README.md`

- [ ] **Step 1: Create root `package.json`**

```json
{
  "name": "zswap-aztec",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "packageManager": "pnpm@9.12.0",
  "engines": {
    "node": ">=22"
  },
  "scripts": {
    "compile": "bash scripts/compile-all.sh",
    "test": "pnpm -r --filter './tests/**' test",
    "test:noir": "bash scripts/compile-all.sh && for d in contracts/*/; do (cd \"$d\" && aztec test) ; done",
    "lint": "pnpm -r --if-present lint",
    "typecheck": "pnpm -r --if-present typecheck"
  }
}
```

- [ ] **Step 2: Create `pnpm-workspace.yaml`**

```yaml
packages:
  - 'tests/**'
  - 'aggregator'
  - 'cli'
```

(Noir contracts are not pnpm packages; they're handled separately.)

- [ ] **Step 3: Create `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "esModuleInterop": true,
    "skipLibCheck": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "isolatedModules": true,
    "resolveJsonModule": true,
    "declaration": true,
    "sourceMap": true,
    "lib": ["ES2022"],
    "types": ["node"]
  }
}
```

- [ ] **Step 4: Create `.gitignore`**

```
node_modules/
*.log
.DS_Store

# Aztec / Noir build artifacts
target/
*.json.gz
codegenCache.json

# Aztec PXE local state
store/
.aztec-store/

# IDE
.vscode/
.idea/

# pnpm
.pnpm-debug.log
```

- [ ] **Step 5: Create `README.md`**

```markdown
# ZSwap-on-Aztec

MEV-resistant dark-pool DEX on Aztec Network. Penumbra-style frequent batch auction with native private state, built in Noir.

**Status:** Pre-alpha. Week 1 of MVP implementation.

## Quickstart

Requires: Node 22+, pnpm 9+, Docker, Aztec CLI `4.2.1`.

```bash
# Install Aztec toolchain (one-time)
bash -i <(curl -s https://install.aztec.network)
export VERSION=$(cat .aztec-version)
aztec-up

# Install JS dependencies
pnpm install

# Compile all Noir contracts
pnpm compile

# Run Noir TXE tests
pnpm test:noir

# In a separate terminal, start the local dev stack (anvil + aztec)
scripts/dev.sh

# Then run TypeScript integration tests
pnpm test
```

## Documentation

- [MVP Design Spec](docs/superpowers/specs/2026-05-14-zswap-aztec-mvp-design.md)
- [Protocol Roadmap](docs/superpowers/specs/2026-05-14-zswap-aztec-roadmap.md)

## License

MIT.
```

- [ ] **Step 6: Initialize pnpm**

Run:

```bash
pnpm install
```

Expected: Creates `pnpm-lock.yaml`. No errors (workspace is empty but valid).

- [ ] **Step 7: Commit**

```bash
git add package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json .gitignore README.md
git commit -m "chore: scaffold pnpm workspace monorepo"
```

---

## Task 3: Add the `compile-all.sh` script

**Files:**
- Create: `scripts/compile-all.sh`

- [ ] **Step 1: Create the script**

```bash
#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ ! -d contracts ]; then
  echo "No contracts/ directory. Nothing to compile."
  exit 0
fi

for dir in contracts/*/; do
  if [ -f "$dir/Nargo.toml" ]; then
    echo "→ Compiling $dir"
    (cd "$dir" && aztec compile)
  fi
done

echo "All contracts compiled."
```

- [ ] **Step 2: Make it executable**

Run:

```bash
chmod +x scripts/compile-all.sh
```

- [ ] **Step 3: Smoke-test (should be a no-op since contracts/ doesn't exist yet)**

Run:

```bash
./scripts/compile-all.sh
```

Expected output: `No contracts/ directory. Nothing to compile.`

- [ ] **Step 4: Commit**

```bash
git add scripts/compile-all.sh
git commit -m "chore: add compile-all script for Noir contracts"
```

---

## Task 4: Create tUSDC test token contract

The test token uses the `@defi-wonderland/aztec-standards` token via Nargo dependency. This gives us a working, audited private-token implementation. We thinly wrap it to brand it as `tUSDC` and configure decimals.

**Files:**
- Create: `contracts/token-a/Nargo.toml`
- Create: `contracts/token-a/src/main.nr`

- [ ] **Step 1: Create `contracts/token-a/Nargo.toml`**

```toml
[package]
name = "token_a"
type = "contract"
authors = [""]
compiler_version = ">=0.40.0"

[dependencies]
aztec = { git = "https://github.com/AztecProtocol/aztec-packages", tag = "v4.2.1", directory = "noir-projects/aztec-nr/aztec" }
aztec_standards = { git = "https://github.com/defi-wonderland/aztec-standards", tag = "v4.2.1", directory = "contracts/token_contract" }
```

(Tag pinning protects against breaking changes. If `defi-wonderland/aztec-standards` doesn't have this tag, switch to a commit SHA after consulting their releases page.)

- [ ] **Step 2: Create `contracts/token-a/src/main.nr`**

```rust
use dep::aztec::macros::aztec;

#[aztec]
pub contract TokenA {
    use dep::aztec::prelude::AztecAddress;
    use dep::aztec_standards::token_contract::TokenContract;

    // tUSDC test token: 6 decimals (matches real USDC)
    global TOKEN_NAME: str<5> = "tUSDC";
    global TOKEN_SYMBOL: str<5> = "tUSDC";
    global TOKEN_DECIMALS: u8 = 6;

    #[public]
    #[initializer]
    fn constructor(admin: AztecAddress) {
        TokenContract::initialize(admin, TOKEN_NAME, TOKEN_SYMBOL, TOKEN_DECIMALS);
    }

    // Re-export the standard token interface. Concrete delegations live in the
    // dependency; we only inherit them by exporting the same module.
}

mod test;
```

(Note: the exact re-export mechanism depends on the `aztec-standards` API surface. If direct re-export isn't supported in v4.2.1, switch this to a fork-and-copy approach where `main.nr` directly contains the token logic with our token-specific globals. Verify against `https://github.com/defi-wonderland/aztec-standards/tree/main/contracts/token_contract/src` before writing.)

- [ ] **Step 3: Compile the contract**

Run:

```bash
(cd contracts/token-a && aztec compile)
```

Expected: `target/token_a-TokenA.json` created. No compilation errors.

- [ ] **Step 4: Commit (compilation succeeded, no tests yet)**

```bash
git add contracts/token-a/Nargo.toml contracts/token-a/src/main.nr
git commit -m "feat(token-a): add tUSDC contract scaffold (compiles)"
```

---

## Task 5: Write TXE test for tUSDC

**Files:**
- Create: `contracts/token-a/src/test.nr`

- [ ] **Step 1: Write the failing test**

```rust
use dep::aztec::test::helpers::test_environment::TestEnvironment;
use dep::aztec::prelude::AztecAddress;
use crate::TokenA;

#[test]
unconstrained fn mint_and_check_balance() {
    let mut env = TestEnvironment::_new();
    let admin = env.create_account(1);
    env.impersonate(admin);

    // Deploy TokenA
    let contract = env.deploy("./target/token_a-TokenA.json").call(admin);
    let token = TokenA::at(contract.address());

    // Mint 1_000_000 tUSDC (6 decimals → 1.0 USDC = 1_000_000)
    token.mint_to_private(admin, 1_000_000_000_000).call(&mut env.private());

    // Check the admin's private balance equals what we minted
    let balance = token.balance_of_private(admin).view(&mut env.private());
    assert(balance == 1_000_000_000_000, "minted balance mismatch");
}

#[test]
unconstrained fn private_transfer_moves_balance() {
    let mut env = TestEnvironment::_new();
    let alice = env.create_account(1);
    let bob = env.create_account(2);
    env.impersonate(alice);

    let contract = env.deploy("./target/token_a-TokenA.json").call(alice);
    let token = TokenA::at(contract.address());

    // Alice mints 100 tUSDC to herself, then transfers 30 to Bob
    token.mint_to_private(alice, 100_000_000).call(&mut env.private());
    token.transfer(alice, bob, 30_000_000).call(&mut env.private());

    let alice_balance = token.balance_of_private(alice).view(&mut env.private());
    let bob_balance = token.balance_of_private(bob).view(&mut env.private());
    assert(alice_balance == 70_000_000, "alice should have 70 tUSDC");
    assert(bob_balance == 30_000_000, "bob should have 30 tUSDC");
}
```

(The TXE helper API surface, `mint_to_private`/`balance_of_private` signatures, and exact function names are governed by `aztec-standards`. Before running, verify against the dependency's public interface at the pinned tag. If method names differ, adjust this test to match — the assertions are the spec.)

- [ ] **Step 2: Run test to verify it fails (because contract isn't recompiled with test module yet)**

Run:

```bash
(cd contracts/token-a && aztec test)
```

Expected: Compilation succeeds, tests run. If `aztec-standards` API matches exactly, tests pass. If not, tests fail with a clear "method not found" error — that tells you which method names to fix.

- [ ] **Step 3: Reconcile any method-name mismatches**

If a test fails because of a method-name mismatch (e.g., `mint_to_private` should be `mint_privately`), update the test to match the `aztec-standards` token's actual public function names. The intent of each test (mint, check balance, transfer between private balances) is the contract; only the exact method invocations may need adjustment.

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
(cd contracts/token-a && aztec test)
```

Expected: Both tests pass.

- [ ] **Step 5: Commit**

```bash
git add contracts/token-a/src/test.nr
git commit -m "test(token-a): tUSDC mint, balance, and private transfer TXE tests"
```

---

## Task 6: Create tETH test token contract (mirror of Task 4-5)

**Files:**
- Create: `contracts/token-b/Nargo.toml`
- Create: `contracts/token-b/src/main.nr`
- Create: `contracts/token-b/src/test.nr`

- [ ] **Step 1: Create `contracts/token-b/Nargo.toml`**

```toml
[package]
name = "token_b"
type = "contract"
authors = [""]
compiler_version = ">=0.40.0"

[dependencies]
aztec = { git = "https://github.com/AztecProtocol/aztec-packages", tag = "v4.2.1", directory = "noir-projects/aztec-nr/aztec" }
aztec_standards = { git = "https://github.com/defi-wonderland/aztec-standards", tag = "v4.2.1", directory = "contracts/token_contract" }
```

- [ ] **Step 2: Create `contracts/token-b/src/main.nr`**

```rust
use dep::aztec::macros::aztec;

#[aztec]
pub contract TokenB {
    use dep::aztec::prelude::AztecAddress;
    use dep::aztec_standards::token_contract::TokenContract;

    // tETH test token: 18 decimals (matches real ETH)
    global TOKEN_NAME: str<4> = "tETH";
    global TOKEN_SYMBOL: str<4> = "tETH";
    global TOKEN_DECIMALS: u8 = 18;

    #[public]
    #[initializer]
    fn constructor(admin: AztecAddress) {
        TokenContract::initialize(admin, TOKEN_NAME, TOKEN_SYMBOL, TOKEN_DECIMALS);
    }
}

mod test;
```

- [ ] **Step 3: Create `contracts/token-b/src/test.nr`**

```rust
use dep::aztec::test::helpers::test_environment::TestEnvironment;
use dep::aztec::prelude::AztecAddress;
use crate::TokenB;

#[test]
unconstrained fn mint_and_check_balance_18_decimals() {
    let mut env = TestEnvironment::_new();
    let admin = env.create_account(1);
    env.impersonate(admin);

    let contract = env.deploy("./target/token_b-TokenB.json").call(admin);
    let token = TokenB::at(contract.address());

    // Mint 1 tETH (18 decimals)
    token.mint_to_private(admin, 1_000_000_000_000_000_000).call(&mut env.private());

    let balance = token.balance_of_private(admin).view(&mut env.private());
    assert(balance == 1_000_000_000_000_000_000, "minted balance mismatch");
}

#[test]
unconstrained fn private_transfer_18_decimals() {
    let mut env = TestEnvironment::_new();
    let alice = env.create_account(1);
    let bob = env.create_account(2);
    env.impersonate(alice);

    let contract = env.deploy("./target/token_b-TokenB.json").call(alice);
    let token = TokenB::at(contract.address());

    token.mint_to_private(alice, 5_000_000_000_000_000_000).call(&mut env.private());
    token.transfer(alice, bob, 2_500_000_000_000_000_000).call(&mut env.private());

    let alice_balance = token.balance_of_private(alice).view(&mut env.private());
    let bob_balance = token.balance_of_private(bob).view(&mut env.private());
    assert(alice_balance == 2_500_000_000_000_000_000, "alice should have 2.5 tETH");
    assert(bob_balance == 2_500_000_000_000_000_000, "bob should have 2.5 tETH");
}
```

- [ ] **Step 4: Compile and test**

Run:

```bash
(cd contracts/token-b && aztec compile && aztec test)
```

Expected: Compilation succeeds, both tests pass.

- [ ] **Step 5: Commit**

```bash
git add contracts/token-b/
git commit -m "feat(token-b): add tETH contract with TXE tests"
```

---

## Task 7: Create TypeScript test package skeleton

**Files:**
- Create: `tests/package.json`
- Create: `tests/tsconfig.json`
- Create: `tests/vitest.config.ts`

- [ ] **Step 1: Create `tests/package.json`**

```json
{
  "name": "@zswap/tests",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@aztec/aztec.js": "4.2.1",
    "@aztec/accounts": "4.2.1"
  },
  "devDependencies": {
    "@types/node": "^22.7.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Create `tests/tsconfig.json`**

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./",
    "types": ["node", "vitest/globals"]
  },
  "include": ["**/*.ts"],
  "exclude": ["dist", "node_modules"]
}
```

- [ ] **Step 3: Create `tests/vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    testTimeout: 120_000, // Aztec deploy/PXE ops can be slow
    hookTimeout: 120_000,
    pool: "forks",
    poolOptions: {
      forks: { singleFork: true }, // serialize: one sandbox connection at a time
    },
  },
});
```

- [ ] **Step 4: Install dependencies**

Run:

```bash
pnpm install
```

Expected: `tests/node_modules` populated, `@aztec/aztec.js@4.2.1` resolved.

- [ ] **Step 5: Commit**

```bash
git add tests/package.json tests/tsconfig.json tests/vitest.config.ts pnpm-lock.yaml
git commit -m "chore(tests): scaffold TypeScript integration-test package"
```

---

## Task 8: Write sandbox + wallets test helpers

**Files:**
- Create: `tests/integration/helpers/sandbox.ts`
- Create: `tests/integration/helpers/wallets.ts`

- [ ] **Step 1: Create `tests/integration/helpers/sandbox.ts`**

```ts
import { createPXEClient, waitForPXE, type PXE } from "@aztec/aztec.js";

const PXE_URL = process.env.PXE_URL ?? "http://localhost:8080";

/**
 * Connect to a running Aztec PXE at PXE_URL. Throws after 30s if not reachable.
 * The dev stack (anvil + Aztec local-network) must be started externally via:
 *   scripts/dev.sh
 */
export async function connectToSandbox(): Promise<PXE> {
  const pxe = createPXEClient(PXE_URL);
  await waitForPXE(pxe, { interval: 1000, timeout: 30_000 });
  return pxe;
}
```

- [ ] **Step 2: Create `tests/integration/helpers/wallets.ts`**

```ts
import { getDeployedTestAccountsWallets } from "@aztec/accounts/testing";
import type { AccountWallet, PXE } from "@aztec/aztec.js";

/**
 * Returns the pre-funded test wallets that the sandbox auto-deploys.
 * Throws if fewer than `min` wallets are available.
 */
export async function getTestWallets(pxe: PXE, min = 2): Promise<AccountWallet[]> {
  const wallets = await getDeployedTestAccountsWallets(pxe);
  if (wallets.length < min) {
    throw new Error(`expected at least ${min} test wallets, got ${wallets.length}`);
  }
  return wallets;
}
```

- [ ] **Step 3: Commit**

```bash
git add tests/integration/helpers/
git commit -m "test: add sandbox + wallet integration-test helpers"
```

---

## Task 9: Write token integration tests (deploy, mint, transfer end-to-end)

**Files:**
- Create: `tests/integration/tokens.test.ts`

- [ ] **Step 1: Generate TypeScript bindings for the compiled contracts**

Run from repo root:

```bash
aztec codegen contracts/token-a/target -o tests/integration/generated
aztec codegen contracts/token-b/target -o tests/integration/generated
```

Expected: `tests/integration/generated/TokenA.ts` and `tests/integration/generated/TokenB.ts` created with typed contract classes.

- [ ] **Step 2: Add the generated directory to .gitignore**

Append to `.gitignore`:

```
# Codegen artifacts
tests/integration/generated/
```

- [ ] **Step 3: Write the failing integration test**

Create `tests/integration/tokens.test.ts`:

```ts
import { beforeAll, describe, expect, test } from "vitest";
import { AztecAddress, type AccountWallet, type PXE } from "@aztec/aztec.js";
import { connectToSandbox } from "./helpers/sandbox.js";
import { getTestWallets } from "./helpers/wallets.js";
import { TokenAContract } from "./generated/TokenA.js";
import { TokenBContract } from "./generated/TokenB.js";

describe("token contracts", () => {
  let pxe: PXE;
  let admin: AccountWallet;
  let alice: AccountWallet;

  beforeAll(async () => {
    pxe = await connectToSandbox();
    const wallets = await getTestWallets(pxe, 2);
    admin = wallets[0]!;
    alice = wallets[1]!;
  });

  test("tUSDC: deploy + mint + private balance read", async () => {
    const token = await TokenAContract.deploy(admin, admin.getAddress()).send().deployed();

    await token.methods
      .mint_to_private(admin.getAddress(), 1_000_000_000_000n)
      .send()
      .wait();

    const balance = await token.methods.balance_of_private(admin.getAddress()).simulate();
    expect(balance).toBe(1_000_000_000_000n);
  });

  test("tETH: deploy + mint + private transfer to second wallet", async () => {
    const token = await TokenBContract.deploy(admin, admin.getAddress()).send().deployed();

    await token.methods
      .mint_to_private(admin.getAddress(), 5_000_000_000_000_000_000n)
      .send()
      .wait();

    const tokenAsAdmin = token.withWallet(admin);
    await tokenAsAdmin.methods
      .transfer(admin.getAddress(), alice.getAddress(), 2_000_000_000_000_000_000n)
      .send()
      .wait();

    const adminBalance = await token.methods
      .balance_of_private(admin.getAddress())
      .simulate();
    const aliceBalance = await token
      .withWallet(alice)
      .methods.balance_of_private(alice.getAddress())
      .simulate();

    expect(adminBalance).toBe(3_000_000_000_000_000_000n);
    expect(aliceBalance).toBe(2_000_000_000_000_000_000n);
  });
});
```

- [ ] **Step 4: Start the sandbox in another terminal**

Run:

```bash
scripts/dev.sh
```

Wait for `Aztec PXE running on http://localhost:8080`.

- [ ] **Step 5: Run the integration tests**

In the repo terminal:

```bash
pnpm --filter @zswap/tests test
```

Expected: Both tests pass. First run can take 60-90 seconds due to contract deployment cost.

- [ ] **Step 6: If a test fails because of API surface mismatch**

The `@defi-wonderland/aztec-standards` token may expose `mint_to_private` under a different name (e.g., `mint_privately`, `_mint`). Inspect the generated `TokenAContract.methods` keys (the codegen output has them all). Adjust the test method calls to match. The test's assertions about balances are the spec; the call shapes follow whatever the dependency exposes.

- [ ] **Step 7: Stop the sandbox (back in the sandbox terminal)**

Press `Ctrl+C` in the terminal running `aztec start`.

- [ ] **Step 8: Commit**

```bash
git add .gitignore tests/integration/tokens.test.ts
git commit -m "test: tUSDC and tETH deploy + mint + private transfer integration tests"
```

---

## Task 10: Add deploy-tokens helper script

**Files:**
- Create: `scripts/deploy-tokens.ts`

- [ ] **Step 1: Create the deploy script**

```ts
#!/usr/bin/env node
/**
 * One-shot deployment script for the two test tokens to a running Aztec
 * sandbox. Prints the deployed contract addresses to stdout.
 *
 * Run with: pnpm tsx scripts/deploy-tokens.ts
 */
import { createPXEClient, waitForPXE } from "@aztec/aztec.js";
import { getDeployedTestAccountsWallets } from "@aztec/accounts/testing";
import { TokenAContract } from "../tests/integration/generated/TokenA.js";
import { TokenBContract } from "../tests/integration/generated/TokenB.js";

const PXE_URL = process.env.PXE_URL ?? "http://localhost:8080";

async function main() {
  const pxe = createPXEClient(PXE_URL);
  await waitForPXE(pxe);
  const [admin] = await getDeployedTestAccountsWallets(pxe);
  if (!admin) throw new Error("no test wallets available");

  const tokenA = await TokenAContract.deploy(admin, admin.getAddress()).send().deployed();
  const tokenB = await TokenBContract.deploy(admin, admin.getAddress()).send().deployed();

  console.log(JSON.stringify({
    tUSDC: tokenA.address.toString(),
    tETH: tokenB.address.toString(),
    admin: admin.getAddress().toString(),
  }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Add `tsx` as a dev dependency to the root**

Update root `package.json`'s `devDependencies` (creating the field if absent):

```json
"devDependencies": {
  "tsx": "^4.19.0"
}
```

Then run:

```bash
pnpm install
```

- [ ] **Step 3: Smoke-test the script (sandbox must be running)**

In one terminal:

```bash
scripts/dev.sh
```

In another:

```bash
pnpm compile
aztec codegen contracts/token-a/target -o tests/integration/generated
aztec codegen contracts/token-b/target -o tests/integration/generated
pnpm tsx scripts/deploy-tokens.ts
```

Expected: JSON output with `tUSDC`, `tETH`, `admin` addresses.

- [ ] **Step 4: Commit**

```bash
git add scripts/deploy-tokens.ts package.json pnpm-lock.yaml
git commit -m "feat: add deploy-tokens helper script"
```

---

## Task 11: Add CI pipeline (GitHub Actions)

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Create the CI workflow**

```yaml
name: CI

on:
  pull_request:
  push:
    branches: [main]

jobs:
  noir:
    name: Noir compile + TXE tests
    runs-on: ubuntu-latest
    container:
      image: aztecprotocol/aztec:4.2.1
    steps:
      - uses: actions/checkout@v4
      - name: Compile all contracts
        run: bash scripts/compile-all.sh
      - name: Run Noir TXE tests
        run: |
          for d in contracts/*/; do
            (cd "$d" && aztec test)
          done

  typescript:
    name: TypeScript typecheck + lint
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
      - uses: pnpm/action-setup@v4
        with:
          version: 9
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck

  integration:
    name: TypeScript integration tests
    runs-on: ubuntu-latest
    needs: [noir]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
      - uses: pnpm/action-setup@v4
        with:
          version: 9
      - name: Install Foundry (for anvil)
        uses: foundry-rs/foundry-toolchain@v1
      - run: pnpm install --frozen-lockfile
      - name: Pull Aztec image
        run: docker pull aztecprotocol/aztec:4.2.1
      - name: Compile contracts (for codegen artifacts)
        run: |
          docker run --rm -v $PWD:/work -w /work aztecprotocol/aztec:4.2.1 bash scripts/compile-all.sh
      - name: Codegen TypeScript bindings
        run: |
          docker run --rm -v $PWD:/work -w /work aztecprotocol/aztec:4.2.1 \
            bash -c "aztec codegen contracts/token-a/target -o tests/integration/generated && \
                     aztec codegen contracts/token-b/target -o tests/integration/generated"
      - name: Start dev stack (anvil + Aztec local-network) in background
        run: |
          nohup bash scripts/dev.sh > /tmp/dev.log 2>&1 &
          echo $! > /tmp/dev.pid
          # Wait for Aztec PXE to expose port 8080 (Aztec returns 405 to GET)
          for i in $(seq 1 120); do
            code=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:8080 || true)
            if [ "$code" = "405" ] || [ "$code" = "200" ]; then
              echo "Dev stack ready after ${i}s"
              exit 0
            fi
            sleep 2
          done
          echo "Dev stack failed to come up; tail of log:"
          tail -100 /tmp/dev.log
          exit 1
      - run: pnpm --filter @zswap/tests test
        env:
          PXE_URL: http://localhost:8080
      - name: Stop dev stack
        if: always()
        run: bash scripts/dev.sh --down || true
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add GitHub Actions workflow for Noir compile, TS typecheck, and integration tests"
```

---

## Task 12: Final integration smoke and milestone commit

- [ ] **Step 1: Clean rebuild**

Run from repo root:

```bash
rm -rf node_modules contracts/*/target tests/integration/generated
pnpm install
pnpm compile
aztec codegen contracts/token-a/target -o tests/integration/generated
aztec codegen contracts/token-b/target -o tests/integration/generated
pnpm test:noir
```

Expected: Compilation succeeds. All Noir TXE tests pass.

- [ ] **Step 2: Integration test smoke**

In a separate terminal:

```bash
scripts/dev.sh
```

Wait for readiness, then in the main terminal:

```bash
pnpm --filter @zswap/tests test
```

Expected: All TypeScript integration tests pass.

Stop the sandbox with `Ctrl+C` when done.

- [ ] **Step 3: Update README with current state**

Edit `README.md`, replace the "Status" line:

```markdown
**Status:** Week 1 complete. Repo scaffolded; tUSDC and tETH test tokens deploy and pass mint/transfer tests in Noir TXE and TypeScript integration suites. CI green on every PR. Week 2 begins the OrderbookContract.
```

- [ ] **Step 4: Milestone commit**

```bash
git add README.md
git commit -m "docs: mark Week 1 (foundation) complete"
git tag week-01-foundation
```

---

## Definition of Done for Week 1

All checkboxes above are checked, and:

1. `pnpm compile` succeeds with zero errors.
2. `pnpm test:noir` succeeds: all Noir TXE tests pass for both tokens.
3. `pnpm test` (with sandbox running) succeeds: all TypeScript integration tests pass for both tokens.
4. CI on a freshly-pushed branch is green.
5. A fresh clone of the repo can run through `Quickstart` in the README without manual intervention beyond what's documented.
6. The git tag `week-01-foundation` exists at HEAD.

## Hand-off to Week 2

Week 2 plan (`docs/superpowers/plans/2026-05-14-zswap-aztec-week-02-orderbook.md`) will be written after Week 1 is complete. It will cover the OrderbookContract: `OrderNote` storage, `submit_order` private function, `cancel_order`, and the `EpochState` public-storage skeleton. Week 1's token contracts are the dependencies it consumes via Aztec contract addresses.
