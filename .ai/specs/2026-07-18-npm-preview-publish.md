# npm preview publishing — snapshot releases from CI (`cezar-cli@<snapshot>`)

Status: proposed · Date: 2026-07-18 · Issue: #482 · Relates: spec 001 (packaging/npx — decided the scoped-package + unscoped-alias split this spec finishes), spec 2026-07-16-server-installer (the `server-deploy` flow that consumes published versions)

## TLDR

Every green CI run publishes an installable npm snapshot of the CLI, so any PR, the
`develop` head, and the `main` head can be exercised with one copy-pasteable command:

| Event | Published version (example) | dist-tag | How users run it |
|---|---|---|---|
| PR #482 synced (same-repo, CI green) | `0.1.5-pr482.123` | `pr-482` | `npx cezar-cli@0.1.5-pr482.123` |
| push to `develop` | `0.1.5-develop.124` | `develop` | `npx cezar-cli@develop` |
| push to `main` | `0.1.5-main.125` | `main` | `npx cezar-cli@main` |
| stable release (owner-driven, unchanged) | `0.1.5` | `latest` | `npx cezar-cli` |

Publishing is gated on the full existing CI `verify` job (typecheck, unit suites, build,
packaged-CLI E2E, pack check) — nothing publishes unless everything is green. Each PR
snapshot posts a sticky PR comment with the **exact version numbers** ready to copy-paste;
the comment is generated from the published manifests, so if the package or bin name ever
changes, the comment stays correct automatically. Alongside, the real package moves to the
open-mercato npm org: `@pat-lewczuk/cezar` → `@open-mercato/cezar`, with the unscoped
`cezar-cli` alias (the name users actually type) unchanged. An admin runbook lists exactly
what to configure on npmjs.com and GitHub (one secret: `NPM_TOKEN`).

Precedent: `open-mercato/open-mercato`'s `npm-snapshot-preview.yml` — this spec adopts its
same-repo guard, explicit dist-tag channels, npm provenance, and PR-comment pattern, but
triggers automatically after CI instead of `workflow_dispatch`-only.

## Resolved defaults (Open Questions closed autonomously per issue #482 + brief, 2026-07-18)

- **Q1 — does the npx command name change?** No. `npx cezar-cli` stays the user-facing
  entrypoint; only the scoped implementation package renames (`@pat-lewczuk/cezar` →
  `@open-mercato/cezar`). All `npx cezar-cli …` docs stay valid. The brief's "if the npx
  command name changes…" contingency is covered structurally: the PR comment renders the
  install line from the actually-published package name + version, never from a hardcoded string.
- **Q2 — what does `main` publish?** A `main`-channel snapshot under the **`main` dist-tag**
  (`npx cezar-cli@main` = current main head). `latest` is **never** moved by CI snapshot
  jobs — auto-moving `latest` on every merge would make each merge a de-facto stable release
  and requires version-bump automation this spec does not introduce. Stable `latest`
  releases remain owner-driven (`npm publish` from a tagged checkout), unchanged. A tag-driven
  `release.yml` is listed as an optional follow-up, not part of this spec.
- **Q3 — snapshot version scheme?** `<base>-<channel>.<run_number>` where `<base>` is the
  version in `package.json` (`0.1.5` today), `<channel>` ∈ `pr<N>` | `develop` | `main`,
  and `<run_number>` is `github.run_number` (monotonic per workflow). Re-runs of the same
  run append `.<run_attempt>` when `run_attempt > 1`, so no publish ever collides. Valid
  semver prerelease → npm never treats it as `latest` implicitly.
- **Q4 — fork PRs?** Not published. With the `pull_request` trigger, fork PRs get no
  secrets; the job additionally guards on
  `github.event.pull_request.head.repo.full_name == github.repository` (defense in depth,
  mirroring open-mercato's `resolve-pr` check). Fork-PR previews are out of scope.
- **Q5 — both packages or just the alias?** Both, in lockstep. `cezar-cli` is a bin-shim
  that depends on the scoped package, so a snapshot of only the alias would run *old* code.
  Order: publish `@open-mercato/cezar@<v>` first, then `cezar-cli@<v>` with its dependency
  **pinned exact** (`"@open-mercato/cezar": "0.1.5-pr482.123"`). Stable releases keep the
  `^` range in the alias.
- **Q6 — where does the publish job live?** In the existing `.github/workflows/ci.yml` as a
  `publish-snapshot` job with `needs: verify` — one workflow, one `run_number` sequence, and
  the "tests gate publishing" invariant is enforced by the DAG itself, not by cross-workflow
  plumbing. `on.push.branches` gains `develop` (CI today only builds `main`).

## Problem statement

1. **No way to try a PR build.** Today the only installable artifact is whatever the owner
   last `npm publish`ed by hand (`@pat-lewczuk/cezar@0.1.5` + `cezar-cli@0.1.5`). Reviewers
   and QA cannot `npx` a PR's build; issue #482 asks for the open-mercato-style per-PR
   snapshot so "we can test it on the PR".
2. **No preview channels.** `origin/develop` exists but CI doesn't even build it, and there
   is no `@develop` / `@main` alias to hand to early testers or to a VPS running
   `server-deploy`.
3. **Publishing is personal.** The scoped package lives under the personal
   `@pat-lewczuk` scope, while the project and its GitHub org are open-mercato. Spec 001
   already resolved the intended end-state as an org-scoped package + unscoped alias; this
   spec executes the org half.
4. **Manual publish has no gate.** `prepublishOnly: build` runs the build, but nothing forces
   the unit/E2E suites before a human publish. CI-driven publishing makes the green gate
   structural.

## Proposed solution

### Package naming and ownership

- `package.json` `name`: `@pat-lewczuk/cezar` → **`@open-mercato/cezar`** (version, bins
  `cezar`/`cez`, `files`, `publishConfig.access: public` unchanged).
- `alias-cezar/package.json`: dependency → `@open-mercato/cezar`; `alias-cezar/bin.js`
  import → `@open-mercato/cezar/dist/index.js`. Bins `cezar-cli`/`cezar`/`cez` unchanged.
- **Migration path** (required by `BACKWARD_COMPATIBILITY.md` §6, which protects the
  package name): after the first successful `@open-mercato/cezar` stable publish, the admin
  (a) publishes one final `@pat-lewczuk/cezar` patch whose `dist/index.js` re-exports from a
  new dependency on `@open-mercato/cezar` (so pinned users keep working), and (b) runs
  `npm deprecate @pat-lewczuk/cezar "moved to @open-mercato/cezar — npx cezar-cli still works"`.
  Existing `npx cezar-cli` users are untouched: the alias's next release simply depends on
  the new scoped name. `BACKWARD_COMPATIBILITY.md` §6 is updated in the same PR to name
  `@open-mercato/cezar` as the protected package name and record this migration.
- `src/server-install/platforms/ubuntu-vps.ts:521` (`OFFICIAL_CLI_PKG = 'cezar-cli'`) and
  `src/server/capabilities.ts` are **unchanged** — the user-facing name doesn't move.

### Snapshot channels and versions

Pure decision logic lives in **`src/release/snapshot.ts`** (unit-tested, mirroring the
`src/pack-check.ts` + `scripts/check-pack.mjs` pattern):

```ts
computeSnapshot({ event, ref, prNumber, baseVersion, runNumber, runAttempt })
// → { channel: 'pr482'|'develop'|'main', version: '0.1.5-pr482.123',
//     distTag: 'pr-482'|'develop'|'main', npxLines: string[] }  or  null (don't publish)
```

Rules: PR event + same-repo → `pr<N>` channel, dist-tag `pr-<N>`; push `develop` →
`develop`/`develop`; push `main` → `main`/`main`; anything else → `null`. The dist-tag is
**always explicit** on `npm publish --tag …` — a snapshot can never move `latest`.

**`scripts/release-snapshot.mjs`** (the orchestrator CI calls) does, from a clean checkout
with `dist/` + `web/dist` already built by `verify`'s recipe:

1. `npm version --no-git-tag-version <version>` in the root package.
2. `npm publish --tag <distTag> --provenance --access public` (prepublishOnly re-runs
   build + `check:pack`, keeping the tarball-integrity gate in the publish path).
3. Stamp `alias-cezar/package.json` to the same `<version>` and pin the dependency to the
   exact scoped version; `npm publish` the alias with the same `--tag`.
4. Emit a JSON result (`{ name, aliasName, version, distTag, npxLines }`) to
   `$GITHUB_OUTPUT` for the comment step. Supports `--dry-run` (used on PRs that edit the
   publish pipeline itself, and locally).

### Workflow design (`.github/workflows/ci.yml` additions)

```yaml
on:
  push: { branches: [main, develop] }   # develop added
  pull_request: { branches: [main, develop] }

jobs:
  verify: …                              # unchanged, still the sole quality gate

  publish-snapshot:
    needs: verify
    if: >-
      github.event_name == 'push' ||
      (github.event_name == 'pull_request' &&
       github.event.pull_request.head.repo.full_name == github.repository)
    permissions:
      contents: read
      pull-requests: write               # sticky PR comment
      id-token: write                    # npm provenance attestation
    concurrency:                         # serialize per channel; never cancel mid-publish
      group: npm-snapshot-${{ github.event.pull_request.number || github.ref }}
      cancel-in-progress: false
    steps:
      - checkout / setup-node (registry-url: https://registry.npmjs.org)
      - npm ci && npm run build
      - node scripts/release-snapshot.mjs   # NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
      - sticky PR comment (pull_request only)
      - $GITHUB_STEP_SUMMARY with the same copy-paste block (all events)
```

Guards, in order: `needs: verify` (nothing publishes on red), same-repo check (no
secret exposure to forks — `pull_request` already withholds secrets from forks; the `if`
is defense in depth), explicit `--tag` (never `latest`), unique version per run/attempt
(no collision failures), `NPM_TOKEN` referenced only in this job, `cancel-in-progress:
false` (a cancelled half-publish would leave the scoped package without its alias).
If `NPM_TOKEN` is absent (e.g. a fresh fork of the whole repo), the job runs
`--dry-run` and says so, instead of failing CI.

**Sticky PR comment** (marker `<!-- cezar-npm-preview -->`, updated in place on every
push so a PR accumulates one comment, not thirty), rendered entirely from the publish
step's JSON output:

```markdown
### 📦 npm preview published — `0.1.5-pr482.123`

Try this PR build (exact pinned version — copy-paste as-is):

    npx cezar-cli@0.1.5-pr482.123              # cockpit at http://localhost:4321
    npx cezar-cli@0.1.5-pr482.123 run "…"      # headless run
    npx cezar-cli@0.1.5-pr482.123 server-deploy --platform ubuntu-vps   # roll a server to this build

Also tagged: `npm install -g cezar-cli@pr-482` (moving tag for this PR).
Packages: `cezar-cli@0.1.5-pr482.123` → `@open-mercato/cezar@0.1.5-pr482.123` (provenance attested).
```

**Dist-tag cleanup**: a small separate workflow on `pull_request: [closed]` best-effort
runs `npm dist-tag rm {cezar-cli,@open-mercato/cezar} pr-<N>`. Snapshot *versions* stay
on the registry (npm allows unpublish only within 72 h and forbids it with dependents —
we don't try); untagged prerelease versions are inert and never resolved by `npx cezar-cli`.

### Docs and installer touchpoints (updated in the implementing PR)

| File | Change |
|---|---|
| `package.json`, `package-lock.json` | `name` → `@open-mercato/cezar` |
| `alias-cezar/package.json`, `alias-cezar/bin.js` | dependency + import → `@open-mercato/cezar` |
| `README.md:149` | `npx @pat-lewczuk/cezar` → `npx @open-mercato/cezar` |
| `README.md` (Quick start area) | new **Preview builds** subsection: `npx cezar-cli@develop`, `npx cezar-cli@main`, per-PR `pr-<N>` tags + where the PR comment appears |
| `docs/server-install/README.md`, `ubuntu-vps.md`, `macosx-ngrok.md` | note that `server-deploy` accepts a pinned preview (`npx cezar-cli@<snapshot> server-deploy …`) for testing a PR build on a VPS |
| `docs/publishing.md` (new) | the admin runbook below + how the snapshot pipeline works, for maintainers |
| `BACKWARD_COMPATIBILITY.md` §1, §6 | new scoped name, alias unchanged, migration recorded |
| `.ai/specs/001-packaging-npx.md` | untouched (historical); this spec supersedes its naming clause |

All other `cezar-cli` references (`src/server-install/*`, `src/server/capabilities.ts`,
`web/app/e2e/empty-states.e2e.ts`, README `npx cezar-cli` lines) are already correct.

### Admin runbook — what the owner configures (one-time)

**On npmjs.com** (as an owner of the `open-mercato` org and of `cezar-cli`):

1. Verify the `open-mercato` org exists and your user is an **Owner**.
2. Give the org control of the unscoped alias (unscoped packages attach to orgs via
   teams): `npm access grant read-write open-mercato:developers cezar-cli` — run by the
   current `cezar-cli` owner.
3. Create a **granular access token**: *Read and write*; **Packages and scopes** →
   select the `@open-mercato` scope (with "new packages" allowed — the first
   `@open-mercato/cezar` publish comes from CI) **and** the `cezar-cli` package;
   expiry per your policy (set a calendar reminder; CI fails loudly with `E401/E404`
   when it lapses).
4. For both packages, Settings → *Publishing access* → **"Require two-factor
   authentication or an automation or granular access token"** (so CI can publish while
   humans still need 2FA).

**On GitHub** (`open-mercato/cezar`):

5. Settings → Secrets and variables → Actions → **New repository secret** `NPM_TOKEN`
   with the token from step 3. (Optional hardening: put it in an *environment* named
   `npm` restricted to `main`/`develop`, and reference the environment from the
   publish job — but PR snapshots then need the secret at repo level anyway, so the
   simple repo secret is the default.)
6. Nothing else: the workflow declares its own `permissions:` block
   (`pull-requests: write`, `id-token: write`), so repo-level Actions defaults can stay
   read-only, and `develop` already exists.

**After the first stable `@open-mercato/cezar` publish** (post-merge, manual):

7. Publish the final `@pat-lewczuk/cezar` forwarding patch and run
   `npm deprecate @pat-lewczuk/cezar "moved to @open-mercato/cezar — npx cezar-cli still works"`.

The implementing PR's summary comment must repeat steps 1–6 so the admin can configure
everything before merging (the first post-merge push to `main` is the pipeline's live test).

## Test plan

- **Unit (`test/unit/` or colocated, `node --test` via `npm run test:unit`):**
  `computeSnapshot` matrix — PR/develop/main/other events, fork vs same-repo, run_attempt
  suffix only when > 1, dist-tag never `latest`, npx lines contain the exact version and
  the *actual* alias bin name (rename-proof per Q1).
- **Orchestrator:** `scripts/release-snapshot.mjs --dry-run` exercised in `verify` (or a
  dedicated test) against the real tree: asserts both manifests get the same stamped
  version, the alias dependency is pinned exact, and no git-visible side effects leak
  (runs on a throwaway copy / restores manifests).
- **Existing gates unchanged:** `npm run test:package` still packs and exercises the real
  tarball; `check:pack` still runs inside `prepublishOnly`, now also on every snapshot.
- **Workflow:** `actionlint` locally on the edited `ci.yml`; first live validation is the
  implementing PR itself — with `NPM_TOKEN` absent-or-present it must go green (dry-run
  fallback), and after the admin adds the secret, the PR's own snapshot comment appearing
  is the end-to-end proof.

## Implementation plan

The Phase/Step numbering is the execution order for `om-auto-create-pr`
(`Source doc:` = this file). Each phase leaves CI green.

**Phase 1 — Rename and rewire (no publishing yet).**
1. Rename `package.json` `name` to `@open-mercato/cezar`; regenerate `package-lock.json`;
   update `alias-cezar/package.json` dependency and `alias-cezar/bin.js` import;
   `README.md:149`. Tests: full suite (`test:package` proves the tarball still works).
2. Update `BACKWARD_COMPATIBILITY.md` §1/§6 with the new name + migration record.

**Phase 2 — Snapshot logic.**
3. Add `src/release/snapshot.ts` (`computeSnapshot`) + unit tests (the matrix above).
4. Add `scripts/release-snapshot.mjs` with `--dry-run`; wire a dry-run assertion into the
   test suite.

**Phase 3 — CI.**
5. Extend `ci.yml`: `develop` in triggers; `publish-snapshot` job (`needs: verify`, guards,
   provenance, explicit `--tag`, dry-run fallback when `NPM_TOKEN` is missing, step summary).
6. Sticky PR comment step (marker-based upsert via `actions/github-script`) rendered from
   the publish JSON; `pr-close` dist-tag cleanup workflow.

**Phase 4 — Docs.**
7. README **Preview builds** section; `docs/server-install/*` pinned-preview note;
   `docs/publishing.md` runbook (steps 1–7 above).

## Out of scope

- Auto-moving `latest` / auto-version-bump releases from `main` (Q2) and a tag-driven
  `release.yml` — optional follow-up.
- Fork-PR previews (Q4) and any `workflow_dispatch` republish path — add later if needed.
- Renaming the `cezar-cli` command or bins (explicitly not happening, Q1).
- Unpublishing/purging old snapshot versions (npm policy makes this a non-goal; dist-tag
  cleanup is the hygiene mechanism).
- Monorepo/multi-package publishing (open-mercato's lockstep machinery) — cezar is two
  manifests, handled directly.
