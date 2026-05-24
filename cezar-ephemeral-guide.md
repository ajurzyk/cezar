# Open-Mercato Ephemeral Environments — Integration Guide for Cezar

Open-mercato ships two flavors of ephemeral runtime that fit cezar's "spin up an isolated instance per agent run, apply a fix, verify, tear down" loop. Pick by where you want the stack to live.

## TL;DR — Which to pick

| Use case | Runtime | How |
|---|---|---|
| Run a fix branch *inside* the open-mercato repo checkout, fast, with HMR, isolated DB | **Local dev ephemeral** | `yarn dev:ephemeral` |
| Test the agent's fix as an end-user against a built production-like image, throwaway, no host coupling | **Docker preview stack** | `yarn docker:ephemeral` |
| Verify the fix automatically with Playwright (recommended for cezar's autoverify step) | **Integration ephemeral** (built on top of the local dev flavor) | `yarn test:integration:ephemeral` |
| Want a Node-level API rather than CLI orchestration | **Programmatic** | Import from `@open-mercato/cli` → `packages/cli/src/lib/testing/integration.ts` |

All three keep their state in well-known JSON files that cezar can read to discover `baseUrl`, port, and DB URL — so you do not need to parse stdout.

---

## 1. Local dev ephemeral — `yarn dev:ephemeral`

Implementation: `scripts/dev-ephemeral.ts` (~1200 lines).

What it does, per invocation:
1. Provisions a throwaway Postgres via `docker run` (image `postgres:16`, container `open-mercato-dev-ephemeral-<ts>-<rand>`, database `om_dev_ephemeral_<ts>_<rand>`, random host port, `--rm`).
2. Runs `yarn initialize -- --reinstall` against that DB (migrations, generated artifacts, seed defaults).
3. Boots a Next.js dev server on a free port (default search range starts at 5000).
4. Waits for `GET /backend/login` to respond (180 s startup budget, 1 s poll, 1.5 s probe timeout).
5. Registers the running instance into `.ai/dev-ephemeral-envs.json`.

### CLI flags

- `--classic` — disable the splash UI, plain Next.js dev output
- `--verbose` — raw passthrough of all child-process logs

### State file (always check this first)

`.ai/dev-ephemeral-envs.json`:

```json
{
  "version": 1,
  "instances": [
    {
      "id": "<pid>:<ISO8601>",
      "pid": 12345,
      "port": 5000,
      "baseUrl": "http://127.0.0.1:5000",
      "backendUrl": "http://127.0.0.1:5000/backend",
      "cwd": "/path/to/open-mercato",
      "startedAt": "2026-05-23T10:00:00.000Z",
      "postgresContainerId": "abc123…",
      "postgresPort": 54321,
      "databaseUrlRedacted": "postgres://***@127.0.0.1:54321/om_dev_ephemeral_..."
    }
  ]
}
```

Multiple instances are supported concurrently — each gets a unique port, container, and DB name.

On startup the script also prunes stale entries (dead PIDs or unresponsive endpoints), so leaked rows from a previous SIGKILL self-heal on the next launch.

### Environment variables

| Var | Default | Effect |
|---|---|---|
| `DEV_EPHEMERAL_PREFERRED_PORT` | — | Try this app port first; fall back to free port |
| `DEV_EPHEMERAL_POSTGRES_IMAGE` | `postgres:16` | Override Postgres image |
| `DEV_EPHEMERAL_POSTGRES_USER` | `postgres` | DB user |
| `DEV_EPHEMERAL_POSTGRES_PASSWORD` | `postgres` | DB password |
| `OM_DEV_SPLASH_PORT` | `auto` | Splash UI port; `disabled`/`false`/`off` to skip |
| `OM_DEV_AUTO_OPEN` | unset | Set to `0` to suppress browser auto-open |
| `CI` | unset | When `true`, suppresses splash auto-open |
| `OM_DEV_CLASSIC` | unset | Same as `--classic` |
| `MERCATO_DEV_OUTPUT` | unset | Set `verbose` for verbose output |

### Readiness signaling

No dedicated `/api/health` endpoint exists. Two equivalent ready signals:

1. **HTTP probe (recommended for cezar):** `GET http://127.0.0.1:<port>/backend/login` returns any 2xx/3xx → ready.
2. **Splash status:** `GET http://127.0.0.1:<splash-port>/status` returns `{ ready, readyUrl, loginUrl, failed }`.

### Lifecycle

- **Start:** `yarn dev:ephemeral` (foreground, attaches stdio).
- **Stop:** send `SIGINT` or `SIGTERM` to the script PID. Both signals are forwarded; the Postgres container is removed in the shutdown handler.
- **No `yarn dev:ephemeral:down`** — there's nothing to call out-of-band. Cleanup is process-scoped.
- **Crash safety:** the Postgres container is started with `--rm`, so Docker auto-deletes it when the container exits even if the parent process is `SIGKILL`'d. The orphan row in the state file is cleaned by the next ephemeral startup's pruner.

### Auth bootstrap (already done for you)

`yarn initialize -- --reinstall` (called automatically inside the ephemeral flow) seeds default users:

| Role | Email | Password |
|---|---|---|
| Superadmin | `superadmin@acme.com` (override via `OM_INIT_SUPERADMIN_EMAIL`) | `secret` |
| Admin | `admin@acme.com` | `secret` |
| Employee | `employee@acme.com` | `secret` |

These come from `packages/core/src/helpers/integration/auth.ts:DEFAULT_CREDENTIALS`. No manual `auth:create-user` step required.

---

## 2. Integration ephemeral — `yarn test:integration:ephemeral`

This is the same dev-ephemeral runtime, wrapped by a richer harness that adds build caching, environment reuse, locking, and Playwright orchestration. **For cezar's auto-verify step this is usually the right entry point — it gives you the same instance the integration tests run against.**

Implementation: `packages/cli/src/lib/testing/integration.ts` (~3200 lines).

### CLI flavors

| Command | Use |
|---|---|
| `yarn test:integration:ephemeral` | Spins up ephemeral env, runs the full Playwright suite, tears down |
| `yarn test:integration:ephemeral:start` | **Spins up ephemeral env and leaves it running** — what cezar should call when it wants a long-lived target to throw verification at |
| `yarn test:integration:ephemeral:interactive` | Same as `:start` but with a menu (human use) |
| `yarn test:integration:ephemeral:start:verbose` | Verbose variant of `:start` |

### State file

`.ai/qa/ephemeral-env.json` (different path from the dev flow above):

```json
{
  "status": "running",
  "baseUrl": "http://127.0.0.1:5001",
  "port": 5001,
  "databaseUrl": "postgresql://...",
  "queueBaseDir": "/path/to/apps/mercato/.mercato/queue",
  "source": "<source fingerprint>",
  "captureScreenshots": false,
  "startedAt": "2026-05-23T10:00:00.000Z"
}
```

- Default port: **5001** (falls back to a free port if busy).
- File is **cleared automatically** when the env stops, so its presence is a reliable "is one running?" check.
- Lock file: `.ai/qa/ephemeral-env.lock` (5 min timeout, 500 ms poll) — prevents race when two callers try to spawn at once.

### Environment variables (integration flavor)

| Var | Default | Effect |
|---|---|---|
| `OM_INTEGRATION_APP_READY_TIMEOUT_SECONDS` | `90` | App-ready probe timeout |
| `OM_INTEGRATION_BUILD_CACHE_TTL_SECONDS` | `600` | Reuse build artifacts within this window |
| `ENABLE_CRUD_API_CACHE` | unset | The npm scripts set this to `true` |
| `OM_INTEGRATION_TEST` | set by harness | Signals integration mode to the app |

### Programmatic API (recommended for cezar's runner)

`packages/cli/src/lib/testing/integration.ts` exports a Node-callable surface. **You can import this from `@open-mercato/cli` and orchestrate ephemerals without shelling out.** The relevant exports:

```typescript
export type EphemeralEnvironmentHandle = {
  baseUrl: string                       // e.g. "http://127.0.0.1:5001"
  port: number
  databaseUrl: string
  commandEnvironment: NodeJS.ProcessEnv // env to inherit into your verification subprocess
  ownedByCurrentProcess: boolean        // true if you can call stop()
  stop: () => Promise<void>
}

// Primary entry points
export async function startEphemeralEnvironment(opts: EphemeralRuntimeOptions): Promise<EphemeralEnvironmentHandle>
export async function tryReuseExistingEnvironment(opts: EphemeralRuntimeOptions): Promise<EphemeralEnvironmentHandle | null>

// State helpers
export async function readEphemeralEnvironmentState(): Promise<EphemeralEnvironmentState | null>
export async function writeEphemeralEnvironmentState(input): Promise<void>
export async function clearEphemeralEnvironmentState(): Promise<void>

// Coordination
export async function acquireEphemeralRuntimeLock(opts): Promise<Release>
export async function shouldReuseBuildArtifacts(ttlSeconds: number): Promise<boolean>
```

`EphemeralRuntimeOptions`:

```typescript
type EphemeralRuntimeOptions = {
  verbose: boolean
  captureScreenshots: boolean
  logPrefix: string
  forceRebuild?: boolean
  reuseExisting?: boolean
  requiredExistingSource?: string         // pin to a specific source fingerprint
  environmentOverrides?: NodeJS.ProcessEnv
}
```

### Reusable test helpers (for cezar's verify step)

Published from `@open-mercato/core/helpers/integration/*` — usable from any Node process, including from cezar's own repo (it does not need to live inside open-mercato):

| Import | What it gives you |
|---|---|
| `…/auth` | `login`, `DEFAULT_CREDENTIALS` |
| `…/api` | `getAuthToken`, `apiRequest` (token-authenticated API calls) |
| `…/crmFixtures` | `createCompanyFixture`, `createPersonFixture`, `deleteEntityIfExists`, `readJsonSafe` |
| `…/catalogFixtures`, `…/salesFixtures`, `…/authFixtures`, `…/dictionariesFixtures` | Domain-specific fixture lifecycle |
| `…/queue` | `drainIntegrationQueue(queueName)` — runs pending jobs deterministically |

Barrel: `@open-mercato/core/testing/integration` re-exports the common subset.

---

## 3. Docker preview stack — `yarn docker:ephemeral`

For verifying a fix against a **built production-like image** without involving the host Node toolchain at all.

Implementation: `docker/preview/Dockerfile` + `docker/preview/preview-entrypoint.sh` + `docker-compose.preview.yaml`.

- Base image: `node:24-alpine`, multi-stage build.
- Entrypoint internally calls `yarn test:integration:ephemeral:start` — so what runs inside the container is the same integration ephemeral as flavor 2.
- Port mapping: host **5000** → container 5001.
- Fresh DB on **every** `up` (no persistent volume).
- Mounts `/var/run/docker.sock` so the in-container ephemeral can spawn its Postgres on the host's Docker.

Commands:

```bash
yarn docker:ephemeral         # build + start, blocks attached to logs
yarn docker:ephemeral:down    # full teardown
```

Discovery from the host: the app is unconditionally at `http://localhost:5000`. There is no state file written to the host filesystem for this flavor — port is fixed in the compose file.

---

## Recommended integration shape for cezar

Per agent run:

1. **Reserve the runtime.** Call `tryReuseExistingEnvironment({ reuseExisting: true, requiredExistingSource: <commit-sha>, … })`. If it returns a handle, you've got a warm env matching your source — use it. If null, fall through.
2. **Start fresh.** `startEphemeralEnvironment({ … })`. Acquire `acquireEphemeralRuntimeLock` first so two concurrent agents don't race on the same checkout.
3. **Apply the fix** in a worktree on the same checkout the ephemeral env was built from (the env auto-reloads via Turbopack on edits).
4. **Verify** by:
   - Hitting `${handle.baseUrl}/backend/login` to confirm reachable.
   - Logging in via `@open-mercato/core/helpers/integration/auth` → `login('admin')` or `getAuthToken('admin')`.
   - Running module-scoped Playwright specs or your own targeted API calls.
5. **Stop** with `await handle.stop()` *if `handle.ownedByCurrentProcess === true`*. Otherwise leave the env running for the next agent run.

For parallel agent runs on the **same host**, use flavor 1 (`yarn dev:ephemeral`) — every invocation gets its own port, DB, container, and entry in `.ai/dev-ephemeral-envs.json`. For agent runs on **separate hosts/CI runners**, flavor 3 (`yarn docker:ephemeral`) is cleaner because it has zero host coupling.

---

## Gotchas to surface to the cezar team

- **Node 24 required** by both flavors. The CLI bin asserts this and exits non-zero on older runtimes.
- **Docker daemon required** by all three flavors (yes, even local dev-ephemeral — Postgres runs in a container).
- **First-run cost.** Cold start is ~1–3 minutes (install + build + generate + DB init + dev boot). The integration flavor caches build artifacts for `OM_INTEGRATION_BUILD_CACHE_TTL_SECONDS` (default 600 s) so subsequent starts in the same checkout are much faster — set this higher for an agent fleet.
- **There is no `/api/health`.** Probe `/backend/login` or the splash `/status`.
- **No SIGKILL safety story for the state file** — the orphan row will sit in `.ai/dev-ephemeral-envs.json` until the next launch, which prunes it. Cezar workers that SIGKILL their own ephemeral should call `clearEphemeralEnvironmentState()` (integration flavor) or accept the next-launch self-heal (dev flavor).
- **Default seed users are static across runs.** If a fix depends on auth edge cases, cezar's verify step can create scoped users via `createUserFixture` from `@open-mercato/core/helpers/integration/authFixtures`.

---

## Authoritative source files

If the cezar team wants to read the implementations directly:

- `scripts/dev-ephemeral.ts` — dev flavor entrypoint
- `packages/cli/src/lib/testing/integration.ts` — integration flavor, programmatic API, exported types
- `packages/cli/src/lib/testing/runtime-utils.ts` — port/host/probe helpers
- `docker/preview/Dockerfile`, `docker/preview/preview-entrypoint.sh`, `docker-compose.preview.yaml` — preview container
- `.ai/qa/AGENTS.md` — internal QA workflow doc (the closest existing prose to this guide)
- `packages/core/src/helpers/integration/*` — npm-published test helpers
