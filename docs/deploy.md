# Quetzal — deploy

## Live

- **Production:** [aztec-project.vercel.app](https://aztec-project.vercel.app) (public alias)
- **Repo:** [github.com/Kubudak90/quetzal](https://github.com/Kubudak90/quetzal) (public)
- **Vercel project:** `kubudak90s-projects/aztec-project` (id `prj_GpQRnDgJn9AX5jrsuqK5Jz20tyzG`)

## CI/CD

Vercel ↔ GitHub git integration auto-deploy:

- **Push to `main`** → production deploy → `aztec-project.vercel.app`
- **PR open** → preview deploy → unique `aztec-project-<sha>-kubudak90s-projects.vercel.app`
- **PR close (merge / abandon)** → preview cleaned up

No manual `vercel deploy` needed anymore.

## Build settings

From `vercel.json` (monorepo root):

| Setting | Value |
|---|---|
| Framework | Vite |
| Install command | `pnpm install --frozen-lockfile=false` |
| Build command | `pnpm -F @quetzal/frontend build` |
| Output directory | `frontend/dist` |
| SPA rewrite | `/*` → `/index.html` |
| Asset cache | `/assets/*` 1y immutable |

`.vercelignore` excludes monorepo bloat: `contracts/`, `contracts-l1/`, `circuits/`, `tools/`, `aggregator/`, `tests/`, `docs/`, `frontend/_design-source/`, local state, secrets. Vercel only sees: `frontend/` + `sdk/` + `cli/` (workspace deps).

## Local dev

```bash
pnpm install
pnpm -F @quetzal/frontend dev        # http://localhost:5173
pnpm -F @quetzal/frontend build      # production build into frontend/dist/
pnpm -F @quetzal/frontend preview    # serve frontend/dist on http://localhost:4173
```

## Manual deploy (bypass git)

```bash
vercel deploy --prod         # production
vercel deploy                # preview
vercel inspect <url>         # check build logs + status
vercel git disconnect        # break the git integration if needed
```

## Custom domain

Set up in Vercel dashboard → Project → Settings → Domains. Then point DNS:

```
quetzal.fi.        IN  A     76.76.21.21
www.quetzal.fi.    IN  CNAME cname.vercel-dns.com.
```

Or pick a `*.vercel.app` subdomain (free). Currently using auto-aliased `aztec-project.vercel.app`.

## Secrets

The frontend has **no build-time env vars**. All user-side configuration (wallet master secret, network choice, RPC overrides) lives in browser `localStorage` after first-launch wizard.

If you ever need build-time secrets (analytics keys, etc.), add via:

```bash
vercel env add VARIABLE_NAME production    # interactive prompt
vercel env ls                              # list all
vercel env pull .env.local                 # sync down for local dev
```

## CI gate

GitHub Actions runs on every `main` push + PR (`.github/workflows/ci.yml`, ~1m20s):

| Step | What it gates |
|---|---|
| `pnpm -F @quetzal/sdk typecheck` | SDK type drift |
| `pnpm -F @quetzal/frontend typecheck` | Frontend type drift |
| `pnpm -F @quetzal/sdk test` | SDK unit suite (~98 tests, node:test) |
| `pnpm -F @quetzal/cli test` | CLI unit suite (~74 tests, node:test) |
| `pnpm -F @quetzal/frontend build` | Same build Vercel runs |

**Not gated on CI** (intentional — would push CI from <2min to >15min):
- CLI typecheck — depends on `contracts/*/target/*.json` (gitignored Noir artifacts); typecheck still runs locally pre-commit
- L1 Foundry tests — needs `forge install` + Solidity toolchain
- L2 Noir TXE tests — needs Docker + `nargo` via aztec-up
- Integration tests under `tests/` — needs deployed contracts on Aztec sandbox

For periodic full-stack gating, add a separate cron-triggered workflow.

## Production deploys log

- `2026-05-27` — initial deploy `dpl_Bb9hcxxud84qrMEQHar6igbUuu1U` (44.8 MB upload, ~3min build, Washington East)
