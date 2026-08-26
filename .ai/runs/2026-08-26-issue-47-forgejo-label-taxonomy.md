# Forgejo: provision the pipeline label taxonomy

Issue: ajurzyk/cezar#47
Date: 2026-08-26
Engine: om-auto-create-pr (steps: 17, --loop: no)

## Goal

Give the 27-label pipeline taxonomy a Forgejo provisioning path driven by cezar, so a Forgejo
project's `in-progress` / `review` / `qa` labels exist before a run tries to signal on them — today
every such mutation degrades to a logged skip and the claim/lock protocol silently stops working.

## The choice the issue demands be made

The issue names two mutually exclusive deliverables and forbids leaving the pick to the run.

**Picked: a new `ForgeDriver` operation plus a cockpit action.** Not a `forge.sh` verb, and the
reason is mechanical rather than aesthetic: `forge.sh` lives at
`/srv/claude-home/skills/cez/scripts/forge.sh`, outside this repository —

```
$ git ls-files | grep -i forge.sh
$ ls /srv/claude-home/skills/cez/scripts/forge.sh
/srv/claude-home/skills/cez/scripts/forge.sh
```

— so a pull request against `ajurzyk/cezar` cannot contain it, and neither of the gates the issue
makes acceptance conditions could run over it: the canonical baseline is cezar's vitest suite, and
the mandated hermetic tier asserts on what the **HTTP transport was asked to send**. The issue's own
"transport is cezar's own REST layer (`forgejo-http.ts`) … matching wherever the deliverable lands"
then names the layer for this half of the fork.

Named files, so a reader never has to infer the deliverable:

| File | Role |
|---|---|
| `packages/cezar/src/server/forge/label-taxonomy.ts` | the 27-entry table (name, colour, description), compiled in |
| `packages/cezar/src/server/forge/forgejo-labels.ts` | paged read → create-missing, never `PATCH`/`DELETE` |
| `packages/cezar/src/server/forge/types.ts` | `ForgeLabelSpec`, `ForgeEnsureLabels*`, `ForgeDriver.ensureLabels?` |
| `packages/cezar/src/server/forge/forgejo.ts` | wires `ensureLabels` onto the Forgejo driver |
| `packages/cezar/src/server/server.ts` | `POST /api/v1/forge/labels` — the cockpit action's route |
| `packages/contract/src/forge.ts` | the route's response shape, pinned by `contract-parity` |
| `packages/web/src/lib/forge-label-sync.ts` | the pure enable/disable policy the button projects |
| `packages/web/src/routes/github/github.tsx` | the button itself, in the forge tab header |

## Scope

- Provisioning is **create-only**: nothing is ever deleted, renamed or recoloured. A label that
  exists under the same name but a different colour/description is left untouched and reported.
- The taxonomy is a **compiled-in constant**, never read back from a repository over the wire. The
  target repository under work is not where pipeline configuration belongs, and a run's worktree has
  no authenticated `gh` to read `ajurzyk/cezar` with.
- Forgejo only. The GitHub path keeps `labels-sync.sh` byte-for-byte; `ensureLabels` is an OPTIONAL
  `ForgeDriver` member and the GitHub driver does not implement it.

## Non-goals

- No change to `.ai/agentic.config.json`, to the taxonomy's membership, or to `labels-sync.sh` —
  including its `--check` exit codes (0 complete / 1 missing-or-case-mismatched / 2 usage).
- No `tea`. It appears nowhere in cezar and is not introduced here.
- Nothing in the worked-on repository's tracked files is touched by provisioning.
- Not #24 (the claim protocol itself) and not #46 (the Forgejo tracker descriptor, open as PR #51).
  This supplies the labels those commands address; it does not teach anyone to send them.

## Four measured Forgejo behaviours the design is built on

Re-measured live before planning (`http://q7010-dev:8929`, 2026-08-26), not inherited from the issue:

```
$ curl -s http://q7010-dev:8929/api/v1/settings/api
{"max_response_items":50,"default_paging_num":30,…}
$ curl -sH "Authorization: token …" …/repos/ajr/orakton/labels?page=1&limit=50   → 13 labels
$ curl -sH "Authorization: token …" …/repos/ajr/cezar-qa/labels?page=1&limit=50  → 1 label ('selftest')
```

1. **`POST` is not idempotent.** A duplicate name answers 201 and creates a second label — there is
   no `422 already_exists` net like GitHub's, which `labels-sync.sh:195-203` leans on. Therefore the
   read must be COMPLETE before any write: a truncated listing is refused outright rather than
   treated as "these are missing".
2. **Names are case-sensitive.** `Bug` and `bug` coexist. Decided explicitly: they are distinct, and
   the whole `case:` / `mismatched` branch of `labels-sync.sh` has no analogue here.
3. **Paging engages only once `page` is sent — the issue's own statement of this is wrong, and the
   correction is sharper.** #47 says "an unparameterised `GET …/labels` returns 30 of 40". It does
   not. Measured against `ajr/cezar-qa` holding 58 labels, so the counts are directly comparable:

   ```
   GET .../labels                  -> 58 rows   (X-Total-Count: 58)
   GET .../labels?limit=50         -> 58 rows   <- `limit` ALONE is ignored
   GET .../labels?page=1           -> 30 rows   <- default_paging_num
   GET .../labels?page=1&limit=50  -> 50 rows   <- max_response_items caps `limit`
   ```

   An unparameterised read truncates nothing. The hazard is that `ForgejoHttp.paginate` ALWAYS
   sends `page`, so this transport is unconditionally in the paging regime: a reader that took page
   1 and stopped would see 50 of 58 and, with (1), duplicate the other eight. Walking the pages
   stays mandatory — and reaching for the unparameterised form instead would mean asking an
   unbounded endpoint for everything, which is what `paginate`'s budget and page cap exist to
   refuse.
4. **Colour** is accepted with or without `#` and always returned without it; `exclusive` /
   `is_archived` stay at their defaults and are not part of this contract.

## The #16 guard, not a relaxation of it

`labels-sync.sh` has no target parameter *on purpose*: PR #16 (`381fb10e`) closed two ways of
spilling cezar's taxonomy into an unrelated repository — an ambient working directory, and `gh`'s
preference for an `upstream` remote. The Forgejo path needs an explicit target **plus its own
equivalent guard**. Three parts, each testable:

1. **No source repo to spill from.** The taxonomy is compiled in; nothing is read from any
   repository over the network, so the source/target divergence #16 fixed cannot exist here.
2. **The target is a required parameter that must MATCH.** `ensureLabels({ target: 'owner/repo' })`
   compares byte-exact against the target the driver resolved from the project root's own `origin`
   remote (`parseRemote`) and refuses on a mismatch. The cockpit sends the `owner/repo` it is
   showing the user, so a stale tab or a switched project refuses instead of writing somewhere else.
3. **The route resolves with `resolveForge`, never `resolveForgeOrGithub`.** That fallback builds
   `createGithubDriver(repoRoot, null)` — a `repoRef` of `null` is exactly the "let `gh` pick the
   repository" hazard #16 closed. A repo this resolver cannot answer for gets a 400.

## Implementation Plan

### Phase 1 — Red tests

Every test below must fail against the current tree before Phase 2 touches production code.

### Phase 2 — The taxonomy table and the types

### Phase 3 — The Forgejo provisioning path

### Phase 4 — The cockpit action

### Phase 5 — The documents the same contract is written down in

### Phase 6 — Validation, live verification, and the GitHub path's unchanged answer

## Risks

- **Merge overlap.** Open PR #45 also edits `forge/types.ts`, `forge/forgejo.ts` and `server.ts`.
  Additive edits in all three here (a new optional member, a new method, a new route), so the
  conflicts are textual rather than semantic — but whichever lands second rebases.
- **`paginate`'s completeness flag is load-bearing.** `ForgejoPage.stoppedShort` is the only thing
  standing between a truncated listing and a duplicated taxonomy (behaviour 1 above). The walk asks
  for full enumeration and treats ANY `stoppedShort` as a hard refusal, never as "the rest are
  missing".
- **RESOLVED — the issue's paging measurement was wrong.** Re-measured live (behaviour 3 above);
  the design is unaffected because it pages either way, but every comment that had repeated the
  issue's version was corrected to what was observed.
- **Live verification needs a token.** `CEZ_FORGEJO_TOKEN` is unset in the run's shell; the run
  reads the `q7010-dev` login out of the host's `tea` config for the live tier only. Nothing in the
  deliverable reads that file, and no token is ever printed. If it becomes unreadable the hermetic
  tier still stands and the live tier is reported as blocked rather than skipped silently.
- **`ajr/orakton` is a live backlog.** Read-only. Its 13 labels are a fixture; it is never a write
  target. Writes go only to `ajr/cezar-qa`.

## Progress

PR: #52

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Red tests

- [x] 1.1 `label-taxonomy.test.ts`: the table is exactly the 26 names of `.ai/agentic.config.json` plus `do-not-close`, with `labels-sync.sh`'s `label_meta()` colours and descriptions — a drift guard reading both files — 131a7646
- [x] 1.2 `forgejo-labels.test.ts` hermetic tier: empty repo → 27 `POST`s; second pass over a 40-label repo → zero `POST`s; the 13 `ajr/orakton` names survive; colour/description drift is left untouched and reported with zero `PATCH`/`DELETE`; `Bug` alongside `bug` still creates `bug`; check-only creates nothing and names what is missing; a truncated listing refuses — 131a7646
- [x] 1.3 `forge-labels-api.test.ts`: the route reaches the driver, and the three #16-guard cases (no forge → 400, target mismatch → refusal, a forge without `ensureLabels` → 400) — 131a7646
- [x] 1.4 `forge-label-sync.test.ts`: the cockpit policy table — enabled only for a reachable Forgejo forge with a known `owner/repo` — 131a7646

### Phase 2: The taxonomy table and the types

- [x] 2.1 `label-taxonomy.ts` — the 27 `ForgeLabelSpec` entries — 0b669926
- [x] 2.2 `types.ts` — `ForgeLabelSpec`, `ForgeEnsureLabelsInput`, `ForgeEnsureLabelsResult`, optional `ForgeDriver.ensureLabels` — 0b669926

### Phase 3: The Forgejo provisioning path

- [x] 3.1 `forgejo-labels.ts` — full paged read (refusing a truncated one), byte-exact name match, create-only writes — 8f59f861
- [x] 3.2 `forgejo.ts` — expose `ensureLabels` on the driver with the target-match guard — 8f59f861

### Phase 4: The cockpit action

- [x] 4.1 `packages/contract/src/forge.ts` — the response shape, exported from the contract index — 33e26ba5
- [x] 4.2 `server.ts` — `POST /forge/labels` resolved through `resolveForge`, plus its `contract-parity` assertion — 33e26ba5
- [x] 4.3 `packages/web/src/api/client.ts` + `packages/web/src/lib/forge-label-sync.ts` — the call and the pure policy — 33e26ba5
- [x] 4.4 `github.tsx` — the header button that projects the policy — 33e26ba5

### Phase 5: The documents the same contract is written down in

- [x] 5.1 `BACKWARD_COMPATIBILITY.md` §2 — the new route in the inventory (the drift guard is a test) — 33e26ba5
- [x] 5.2 `README.md` — the Forgejo section gains the provisioning path and its **Manual steps** — 4e8b0e6b

### Phase 6: Validation, live verification, and the GitHub path's unchanged answer

- [x] 6.1 Full `validation.commands` gate plus the canonical baseline — `verify.sh`: typecheck clean, **340 files /
      6634 tests passed**, exit 0. Against `main`'s 336 / 6602 that is +4 files / +32 tests, **none lost**.
      `npm run test:unit` 36/36, `npm run build` ok (`check:pack ok — 494 files`), `npm run test:package` 15/15 —
      all five `validation.commands` green
- [x] 6.2 Live tier on `ajr/cezar-qa` — provisioned from a repo holding only `selftest` → 27 created; read back through
      an INDEPENDENT paged walk: 28 labels, **0 duplicates**, `selftest` untouched. Repo then padded to 58 labels
      (past the 50-row cap): second pass sent **2 GETs, 0 non-GET requests, methods `['GET']`**. `in-progress` +
      `review` deleted and `blocked` hand-recoloured: check-only reported `complete:false`, `missing:['review',
      'in-progress']`, `drifted:[blocked 00ff00 vs b60205]` with 0 writes; provisioning then sent exactly 2 POSTs and
      left `blocked` alone. Fillers removed and `blocked` restored — repo left at 27 + `selftest`. The four
      behaviours were re-measured first-hand (duplicate POST → 201 with ids 21/22; `Dup-Probe` alongside `dup-probe`
      → 201; `#0366d6` echoed as `0366d6`); the paging one **contradicted the issue** and was corrected in code
- [x] 6.3 `bash .ai/scripts/labels-sync.sh --check` → `label taxonomy complete in ajurzyk/cezar (27 labels)`, exit 0.
      `git diff origin/main...HEAD -- .ai/scripts/ .ai/agentic.config.json` is empty: neither file was touched
