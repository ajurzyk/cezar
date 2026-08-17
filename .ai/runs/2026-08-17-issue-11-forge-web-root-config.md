# Execution plan — `forgeWebRoot` honours the repo's own `webUrl`

Source doc: `.ai/specs/2026-08-14-forge-seam-closure.md` (Stage B)
Issue: #11
Engine: om-auto-create-pr (steps: 6, --loop: no)

## Goal

Let `forgeWebRoot` answer for a repo whose forge is known only from its own `.ai/cezar/config.json`
`forge` block, so a Forgejo project reports `repoUrl` and the cross-project surfaces that link a
reference by number stop degrading to plain text for it.

## Scope

- `packages/cezar/src/server/forge/index.ts` — `forgeWebRoot` gains the optional second parameter
  `forgeKindOfRemote` already takes; its doc comment currently asserts the opposite and becomes
  false with this change.
- `packages/cezar/src/workspace/projects.ts` — `computeProbe` already holds `forgeSettings` from the
  `Promise.all` above the call; pass it through and rewrite the comment that explains the old gap.
- `packages/contract/src/projects.ts` — `projectListEntrySchema.repoUrl`'s doc comment says a
  config-known forge has no `repoUrl`.
- `BACKWARD_COMPATIBILITY.md` §2 — the projects-GET paragraph repeats the same claim about
  `repoUrl?` verbatim; the spec names it as a statement this stage changes.
- Tests extended in place: `packages/cezar/src/server/forge/index.test.ts` and
  `packages/cezar/src/workspace/projects.test.ts`.

## Non-goals

- Stage A (`createPR` through the driver) and Stage C (reference status) — the issue states Stage B
  is independent with no ordering constraint.
- Verifying that the declared `webUrl` and the remote's host describe the same instance. The spec
  names this explicitly as accepted: `resolveForge` already extends the same trust to the same
  config value, and the only new consequence is that a mistake becomes a visibly wrong link rather
  than a failing API call.
- Any change to the `github.com` path. Its value must stay byte-identical, which is why the
  `encodeURIComponent` the spec asks for lands on the config branch only.

## Implementation notes

Two properties shape the code and must survive:

1. **`owner`/`repo` come from the PARSED remote, never the raw one.** That is why the function
   rebuilds instead of passing through — a remote may carry credentials
   (`https://user:token@host/o/r.git`) and this value is rendered and linked in the cockpit.
   `forgeSettingsSchema` pins `webUrl` to `http`/`https`, so the composed root cannot carry a scheme
   no consumer expected.
2. **Precedence is unchanged.** The host table answers first; the config only fills the gap it
   leaves. A `github.com` remote paired with `kind: 'forgejo'` still yields the github.com root.

Two details the `${forge.webUrl}/${owner}/${repo}` formula is shorthand for, both matching what
`forgejoViewUrl` already does with the same value: segments are `encodeURIComponent`'d, and
`webUrl`'s trailing slashes are trimmed before concatenation (`apiUrl` is trimmed on its way into
`ForgejoHttp`; `webUrl` is trimmed nowhere today, so a config ending in `/` would otherwise render
`https://host//owner/repo`).

A `kind: 'github'` config on a self-hosted remote must stay `null` here for the same reason
`classifyForgeKind` refuses it — reusing that helper rather than reading `forge.kind` directly is
what keeps probe, resolver and web root on one precedence rule.

## Risks

- **Low.** The only wire-shape change is a field that used to be omitted now being present for
  Forgejo projects; `repoUrl` is already `optional()` in the contract, so no consumer's parse
  narrows.
- A repo declaring a `forge` block whose `webUrl` points at a different instance than its remote now
  renders a link into the configured instance instead of plain text. Accepted per the spec, and
  recorded here so a future "why does this row link to the wrong server" starts at this note.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: `forgeWebRoot` reads the config

- [x] 1.1 Red — extend `forge/index.test.ts` with the `forgeWebRoot` cases (config fills the gap; host table still wins; trailing-slash `webUrl`; odd owner/repo segments; unparseable remote with a block present; no block) — 37ab0f2b
- [x] 1.2 Green — add the optional `forge` parameter to `forgeWebRoot` and rewrite its doc comment — 37ab0f2b

### Phase 2: Call site and the contract's own account of `repoUrl`

- [x] 2.1 Red — extend `workspace/projects.test.ts` with a Forgejo project row asserting `repoUrl` — ec5aef37
- [x] 2.2 Green — pass `forgeSettings` through in `computeProbe` and rewrite its comment — ec5aef37
- [x] 2.3 Update `projectListEntrySchema.repoUrl`'s doc comment and `BACKWARD_COMPATIBILITY.md` §2 — ec5aef37

### Phase 3: Validation

- [x] 3.1 Full validation gate green (typecheck, test, test:unit, build, test:package) — ec5aef37
