# Forgejo dry-run fixtures — a reachable Forgejo surface offline (issue #26)

**Issue:** ajurzyk/cezar#26 — *Forgejo: the dry-run branch serves empty lists, so no e2e or QA can
reach any Forgejo surface*
**Engine:** om-auto-create-pr (steps: 11, --loop: no)

## Goal

Under `CEZ_DRY_RUN=1`, a Forgejo project must present a populated GitHub tab — issues, PRs, a
clickable detail pane and therefore a reachable *Hand this to the agent* panel — with every item URL
on the configured `webUrl` host, so e2e and QA can exercise Forgejo behaviour offline with no token
and no network.

## Scope

- `packages/cezar/src/server/forge/forgejo.ts` — the dry-run branches of `listForgejo`,
  `forgejoPrStatus` and `forgejoListChecks` get one shared fixture catalog (the Forgejo twin of
  `github.ts`'s `mockGithub()`), deliberately disjoint from the GitHub catalog.
- `.ai/scripts/test-env-up.sh` — a scratch, Forgejo-classified project registered alongside the repo
  project, so the shared test env has a project whose `forge.kind` is `forgejo`.
- `packages/web/e2e/forgejo.e2e.ts` — the browser-level case #25's QA could not run.
- Unit tests for every behaviour above, plus a cross-driver test pinning fixture disjointness.

### Non-goals

- Any live (non-dry-run) code path. No request, no cache, no mapper changes.
- Contacting a real Forgejo instance from anywhere in the test suite or the test env.
- The pluggable-adapter generalization (upstream open-mercato/cezar#847) — out of scope here.
- Fixtures for `forgejoListComments`: an available *empty* thread is already honest and nothing in
  the acceptance criteria needs a seeded conversation.

## Implementation Plan

### Phase 1 — the fixture catalog in the Forgejo driver

One catalog, three consumers. Values are chosen so no number, title, label, author or URL can
collide with `mockGithub()` — a Forgejo assertion must be unsatisfiable by GitHub fixtures.
`prStatus` answers a status only for the branch a catalog PR actually heads, so the
Create-PR → View-PR flip stays honest for every other branch.

### Phase 2 — a Forgejo project in the shared test env

`test-env-up.sh` materializes a scratch git repo (a remote on a host the forge table cannot name,
plus a `forge` block in its `.ai/cezar/config.json`) and registers it in the pinned `CEZ_HOME`
registry. Idempotent, so the reuse path costs nothing. Under dry-run those URLs are only read for
classification and link composition — never contacted.

### Phase 3 — the browser-level case

A spec-owned server over its own scratch Forgejo repo (the `fixtureServeEnv` pattern the e2e suite
already uses for "a second project"), so starting a run adds no side effect to the shared env's run
list. It asserts the composed task carries the reference block for a prompt holding ONLY the item's
Forgejo URL, and that `extractTaskRefs` recovered the number into the run's `#N` title prefix.

### Phase 4 — validation gate and PR

## Risks

- ~~The e2e specs cannot be executed here.~~ **Resolved:** `agent-browser` ships its own Chrome and
  installed cleanly, so `packages/web/e2e/forgejo.e2e.ts` was actually RUN — 4/4 passing, with
  `forgejo-detail.png` / `forgejo-handoff.png` captured from a real browser. The wider e2e suite is
  red on this machine independently of this change (see the PR); `npm run test:e2e` is not part of
  `validation.commands`.
- The e2e `globalSetup` (`packages/web/e2e/workspace-registry.ts`) pins the shared registry to the
  boot project alone for the duration of a vitest run, so the Phase-2 project is visible to manual
  QA and to any non-vitest consumer of the env, and deliberately invisible to the flat-shell specs.
  That is why Phase 3 boots its own server rather than leaning on the shared env.
- Seeding PR rows makes the pre-existing dry-run merge-state fixture (always PR 777) reachable by
  click for the first time. Mitigated by making the catalog's open PR *be* 777.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: the fixture catalog in the Forgejo driver

- [x] 1.1 Add the dry-run Forgejo catalog and serve it from `listForgejo` — 987c8259
- [x] 1.2 Answer `prStatus` from the catalog for a branch a catalog PR heads — 987c8259
- [x] 1.3 Answer `listChecks` glyphs from the catalog — 987c8259
- [x] 1.4 Pin fixture disjointness from `mockGithub()` in a cross-driver test — 987c8259

### Phase 2: a Forgejo project in the shared test env

- [x] 2.1 Materialize and register a scratch Forgejo project in `test-env-up.sh` — 118908aa

### Phase 3: the browser-level case

- [x] 3.1 Add `packages/web/e2e/forgejo.e2e.ts` — list, detail, URL-only hand-off, run attribution — 7c442297

### Phase 4: validation gate and PR

- [ ] 4.1 Run the full validation gate
- [ ] 4.2 Open the PR, apply labels, run the review pass
