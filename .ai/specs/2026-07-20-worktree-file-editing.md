# Worktree File Editing from the Files Tab (#530)

## TLDR

The cockpit's **Files** tab can browse a run's worktree but not change it: `GET
/api/runs/:id/files` is the only file-content route and there is no write path
anywhere in the server. So changing one variable means spending a full agent
turn — slow, expensive, and absurd for a one-character edit (#515). This spec
adds an **additive `PUT /api/runs/:id/files`** that writes a single text file
back into the run's worktree, reusing `readWorktreePath()` for traversal safety,
an atomic tmp+rename write, and a **stale-base guard** so a manual edit cannot
be written on top of content the user never saw. Every saved edit is recorded as
a run event, so a human mutation of a live agent worktree is recoverable and
visible. Writing is a **local-machine capability**: every write refuses under
hosted mode (`CEZ_REMOTE`), enforced server-side. The editor is the `CodeEditor`
component from #404 / PR #418 — no new dependency, no Monaco.

## Open Questions — resolved autonomously

Written in autonomous mode (`om-spec-writing --autonomous`). These were **not**
answered by a human; each carries the conservative default applied. Override by
commenting on #530.

| # | Question | Applied default | Why conservative |
|---|---|---|---|
| Q1 | Depend on PR #418's `CodeEditor`, or vendor a copy? | **Depend on #418.** If #418 has not merged when this spec's implementation reaches the UI step, vendor `code-editor.tsx` at that commit and open a follow-up to de-duplicate. | Two overlay editors is the outcome nobody wants — but an unmerged PR must not be able to kill the only phase with user value. The fallback is stated so a stalled #418 triggers a decision instead of a silent block. |
| Q2 | Version token: content hash, or `mtime`+`size`? | **Content hash** (sha-256 of the bytes). | `mtime` granularity loses sub-second edits and is not portable across filesystems; a hash cannot produce a false "unchanged". |
| Q3 | Allow editing while the run is `running`? | **Yes**, with the stale-base guard plus the divergence watch and the edit event below. | Blocking breaks the main use case — watching an agent work and correcting one value. |
| Q4 | Auto-commit a manual edit? | **No.** But the saved content is recorded as a run event (§Audit & recovery), which is what actually makes it recoverable. | Auto-committing surprises users and pollutes the branch. Recoverability is achieved without taking over git. |
| Q5 | Gate behind a new `CEZ_*` flag? | **No new flag to enable it; one to disable it.** `CEZ_NO_FILE_EDIT=1` refuses all writes. | AGENTS.md § Zero config forbids knobs users must set to get working behavior — it does not forbid an operator kill switch for a write primitive. Off-by-default would be the knob; on-with-an-off-switch is not. |
| Q6 | Reuse the `localHandoff` capability, or add one? | **Add `fileEdit`**, sharing the same predicate. | Conflating two capabilities means a change to one silently changes the other. |
| Q7 | Extend to the repo-level `/api/repo/*` surfaces? | **No — out of scope.** | The repo checkout is the user's real working tree, with no worktree isolation to fall back on. Separate capability, separate spec. |

## Problem Statement

A run's Files tab (`web/app/src/routes/task-git/task-files.tsx`, route
`/tasks/:id/files`) renders a lazy directory tree (`files-tree.tsx`) and a
read-only preview (`file-preview.tsx`) with Shiki highlighting, image inlining,
and binary / too-large states. It is backed by exactly one route:

- `GET /api/runs/:id/files?path=[&raw=1]` — `src/server/server.ts:1107-1140`,
  delegating to `readWorktreePath()` (`src/server/git-changes.ts:504`).

There is **no** `POST`/`PUT`/`PATCH` for file content anywhere. The only
mutating file-adjacent routes are git-level (`POST /api/runs/:id/git/commit`,
`/git/push`) or hand off to an external editor (`POST /api/runs/:id/open-in`),
which needs a local desktop and is disabled in hosted mode anyway.

From #515: *"It would be great to edit the files inside cezar — sometimes it is
faster to do manually like changing one variable."* Today that one variable
costs a full agent turn: a prompt, a model round-trip, tokens, and tool-call
latency — to do what a two-second keystroke would, in a file the user already
has open at the right line.

## Current state (what exists today)

| Piece | Location | Status |
|---|---|---|
| Directory listing + file read | `readWorktreePath()`, `src/server/git-changes.ts:504` | Traversal-safe, reusable as-is |
| Read route | `src/server/server.ts:1107` | Read-only |
| API client | `getRunFile()`, `web/app/src/api/client.ts:294-301`; `useRunFile()`, `api/queries.ts:155` | Read-only |
| Tree + preview UI | `task-files.tsx`, `files-tree.tsx`, `file-preview.tsx`, `worktree-files.ts` | View-only |
| Language for highlighting | `langForPath()`, `web/app/src/lib/highlighter.ts:150` | Exists — no new mapping needed |
| Highlighted **editable** control | `CodeEditor`, `web/app/src/components/code-editor.tsx` | **Only on PR #418's branch** |
| Hosted-mode predicate | `resolveCapabilities()`, `src/server/capabilities.ts:44` | Exists (`localHandoff`) |
| Atomic write precedent | `src/runs/store.ts` (tmp+rename) | Exists |
| Autosave commit | `autosaveCommit()`, called at turn end (`src/workflows/run.ts:943`) and at finish (`:1166`) | Exists — see §Audit & recovery |

`readWorktreePath()` is the load-bearing asset: it rejects NUL bytes,
dot-segment escapes and absolute paths, refuses `.git` internals, refuses
symlinks **and symlinked intermediate directories** (a full `realpath`
re-containment check), applies a content cap, and sniffs binary by NUL byte in
the first 8 KB. **The write must go through it, not around it.**

## Proposed Solution

One additive route, one shared resolver, one reused editor.

- **`PUT /api/runs/:id/files?path=…`** with body `{ content, baseHash }`,
  resolving through `readWorktreePath()` — the same call the `GET` makes — so
  the write inherits the read's entire safety envelope by construction rather
  than by a second, drifting implementation.
- **Stale-base guard.** The `GET` gains an additive `hash` field (sha-256 of the
  bytes). The `PUT` must echo it as `baseHash`; a mismatch is a `409`. Read
  §Concurrency for what this does and does **not** guarantee — the honest
  scope of the guard matters more than the mechanism.
- **Atomic write.** tmp file in the target's directory + `rename`, preserving
  mode — the `src/runs/store.ts` precedent. A crashed write cannot truncate a
  source file.
- **Every saved edit emits a run event** carrying the path, both hashes, and the
  content. This is the audit trail *and* the recovery path (§Audit & recovery).
- **Hosted-mode refusal.** `409` whenever hosted mode is active, re-derived
  server-side per request.
- **Editor.** `CodeEditor` from PR #418 — a transparent-text `<textarea>` over a
  `<pre>` of Shiki tokens, sharing the highlighter singleton. Language from the
  existing `langForPath(path)`. Zero new deps.

Alternatives considered:

- **Monaco / CodeMirror.** Rejected: a multi-MB dependency in a codebase that
  carries none, for a feature whose premise is "change one variable quickly".
- **Last-write-wins, no guard.** Rejected: the concurrent writer is an
  autonomous agent, not a human who will notice.
- **Write through git (`git apply`).** Rejected: needs the file tracked and
  clean, fails on new/ignored files, buys nothing.
- **A generic `PUT /api/files` keyed on absolute path.** Rejected: keying on
  `:id` makes the worktree boundary structural.

## Concurrency — what the guard does and does not promise

The agent writes the same worktree concurrently. Being precise about the
residual races is the point of this section; a vaguer promise would be worse
than none.

**What `baseHash` guarantees.** A save is refused if the file changed between
the read that seeded the editor and the write. It prevents the user from
overwriting an agent edit they never saw. That is a *stale-base* guard, not
mutual exclusion.

**Residual race 1 — TOCTOU.** Between the hash comparison and the `rename`
there is a window in which the agent can write; the `rename` then destroys that
write with no conflict raised. The window is milliseconds and there is no
portable file lock that an external agent process would honor. **Accepted and
documented** rather than papered over. Narrow it by hashing from an open
descriptor immediately before the rename, and re-check; do not claim it is
closed.

**Residual race 2 — the reverse direction, which the guard does not cover at
all.** The agent sends no `baseHash`. After the user saves, the agent's next
write silently destroys the user's edit. The guard is asymmetric by
construction, and this is the direction that loses user work.

Mitigation is §Audit & recovery, not a stronger lock — locking an external
agent process is not achievable, and pretending otherwise would be the actual
design error here. Additionally, while a file is open in the editor the client
**watches for divergence**: on the existing per-run SSE stream and on window
focus, it refetches the hash and warns when the file changed underneath —
including after a successful save. The user learns their edit was overwritten
instead of discovering it later in a diff.

## Audit & recovery

A human hand-edit into a live agent worktree today would leave no trace: no run
event, no log line. The agent's next turn sees code it did not write; a user
debugging the run has no way to know an edit happened. That is unacceptable in a
product whose premise is autonomous agents — and it is the same gap that makes
residual race 2 unrecoverable.

Both are closed by one mechanism: **a successful `PUT` appends a run event**
(`file-edited`) to `runs/<id>.ndjson` with `{ path, baseHash, hash, size,
content }`, content subject to the existing cap and the standard secret
redaction (`src/core/secret-redaction.ts`).

- **Audit** — the edit appears in the run's event stream and can be surfaced in
  the Session tab as a note, so the timeline shows the human intervention
  alongside the agent's tool calls.
- **Recovery** — the user's exact saved bytes live in an append-only file even
  if the agent overwrites the working copy seconds later.

This is additive per `BACKWARD_COMPATIBILITY.md` §3 (free extra keys on NDJSON
lines; readers skip what they don't know) and §7 is untouched — `file-edited` is
a run-level event, not an `AgentEvent`/`UiEvent` protocol member, so backend
parity does not apply.

**Interaction with autosave.** `autosaveCommit()` runs at turn end
(`run.ts:943`) and at finish (`:1166`), so during a running task a manual edit
usually reaches the branch as a commit within one turn — genuinely recoverable
via git. But it is *not* a guarantee: the periodic timer is opt-in, a finished
run has no further turn ends, and an agent write landing before the next
autosave leaves no git object of the user's version. The event log is what makes
recovery unconditional; autosave is a helpful overlap, not the mechanism.

## Security model

The first browser-reachable write into a checkout an agent subsequently
executes. That deserves stating plainly.

1. **Local-only by default.** The server binds `127.0.0.1` (AGENTS.md § HTTP
   server). Hosted deployments set `CEZ_REMOTE=1` or bind a non-loopback host.
2. **Hosted mode refuses every write**, from the same predicate as
   `localHandoff` (`CEZ_REMOTE !== '1' && isLoopbackHost(bindHost)`,
   `src/server/capabilities.ts:44`). Rationale, inherited from PR #418: a
   network-reachable write primitive into a checkout the agent then executes is
   an RCE, not a convenience. Reads stay open; writes do not.
3. **The path boundary is `readWorktreePath()`**, not a new check.
4. **Text files only, within the content cap**, and **valid UTF-8 both ways**
   (§Encoding). Binary and over-cap targets are refused.
5. **CSRF and DNS rebinding — #467 is a hard blocker for this route.** #426 /
   PR #467 hardens the localhost API against exactly these. A content-type gate
   is *not* an acceptable fallback: it stops form POSTs and forces a preflight
   for cross-origin fetch, but **does nothing against DNS rebinding**, which
   makes the attacker's page same-origin so the preflight passes. Naming
   rebinding as the threat and then shipping a control that does not address it
   would be the worst outcome here. Therefore: this route ships **after** #467,
   or it ships with an explicit `Host`/`Origin` allowlist check implemented in
   this work and tested against a rebinding-shaped request. No third option.
6. **Kill switch.** `CEZ_NO_FILE_EDIT=1` refuses all writes with `409`, so an
   operator can disable the primitive without a release (Q5). Update
   `.env.example` in the same commit — AGENTS.md makes an undocumented `CEZ_*`
   var a bug.

Background: #430 (agent tool access is not default-deny).

## Encoding

`readWorktreePath` sniffs binary by NUL byte in the first 8 KB. A latin-1 /
cp1252 file contains no NULs, so it passes as text, decodes with U+FFFD
replacement characters, and would be written back **as those replacements** —
silently corrupting a file the user only meant to glance at. That is precisely
the failure the CRLF rule below promises to avoid.

So: on read, a file is editable only if its bytes are **valid UTF-8** (decode
with `fatal: true`; on failure mark it `editable: false` with a reason, and the
UI shows it read-only). On write, the content is encoded UTF-8 and the bytes are
written verbatim — no line-ending normalization, no trailing-newline insertion.
Silent reformatting of someone's file is a bug.

## API Contracts

### `GET /api/runs/:id/files?path=…` — additive change

Unchanged behavior; the `type: 'file'` response gains:

```jsonc
{
  "type": "file", "path": "src/index.ts", "size": 4213,
  "binary": false, "truncated": false, "content": "…",
  "hash": "sha256:9f2b…",   // NEW — omitted when binary or truncated
  "editable": true,         // NEW — false for binary, truncated, or non-UTF-8
  "editableReason": null    // NEW — why not, when editable is false
}
```

### `PUT /api/runs/:id/files?path=…` — new

Request (`application/json`), zod-validated per the AGENTS.md rule that every
mutating route `safeParse`s its body. The **body is capped** before parsing
(reject over the content cap + a small envelope allowance with `413`) — an
unbounded JSON body would otherwise be parsed into memory ahead of every check.

```jsonc
{ "content": "…", "baseHash": "sha256:9f2b…" }
```

Both required. `baseHash` is required from day one deliberately: §2 flags
"making a previously optional body field required" as breaking, so a new route
must not ship it optional.

| Status | Body | When |
|---|---|---|
| `200` | `{ path, size, hash }` | Written. `hash` is the **new** token, so the client keeps editing without a refetch. |
| `400` | `{ error }` | Body fails `safeParse`. |
| `404` | `{ error: 'not found' }` | No such run. |
| `409` | `{ error: NO_WORKTREE }` | Run has no worktree — matches the `GET`. |
| `409` | `{ error: 'file editing is disabled — this cockpit runs in hosted mode (CEZ_REMOTE)' }` | Hosted mode. Wording follows `server.ts:898`/`:928`. |
| `409` | `{ error: 'file editing is disabled (CEZ_NO_FILE_EDIT)' }` | Kill switch. |
| `409` | `{ error }` from `readWorktreePath`, or the directory / binary / non-UTF-8 / over-cap refusals | Target cannot be edited. |
| `409` | `{ error: 'file changed on disk since it was opened — reload to see the current content' }` | `baseHash` mismatch. |
| `413` | `{ error }` | Body over the cap. |

`409` (not `403`/`412`) keeps the route consistent with every other refusal in
this server, which uses `{ error }` + `400/404/409` uniformly.

### `/api/health` — additive capability

`Capabilities` gains `fileEdit: boolean`, derived from the same predicate as
`localHandoff` (and false under the kill switch). Single-sourced in
`resolveCapabilities()` so the two cannot disagree about what "local" means.

## Architecture

`writeWorktreeFile(root, relPath, content, baseHash)` lives in a new
`src/server/worktree-write.ts`. It **calls** `readWorktreePath()` for resolution
so the boundary stays single-sourced, and is unit-testable against a temp
directory without booting Hono. `src/server/git-changes.ts` is about reading
diffs and worktree content; a write primitive does not belong under that name.

The route in `server.ts` sits beside the `GET` at `:1107` and owns only
run lookup, the capability/kill-switch refusals, body validation, the run event,
and status mapping.

Client: `putRunFile()` in `api/client.ts`, `useSaveRunFile()` in `api/queries.ts`
invalidating the file query; `file-preview.tsx` owns the view⇄edit toggle.

## Data Model

No persistent state, no new file under `.ai/cezar/`, no `runs.json` field, no
config key — the edit lands in the worktree and is thereafter git's business.
The one new record is the `file-edited` NDJSON event (§Audit & recovery). The
content hash is computed on demand over the **bytes**, never the decoded string,
so it cannot be fooled by an encoding round-trip.

## UI/UX

Only what is unique; the tree and preview chrome already exist.

- **View by default.** `file-preview.tsx` gains an **Edit** button, shown only
  when the `GET` reports `editable: true` — the server decides editability, the
  UI does not re-derive it. When `editable` is false the existing preview states
  why (binary / too large / not valid UTF-8).
- **Edit mode** swaps the read-only `<pre>` for `CodeEditor` seeded with the
  content and `language={langForPath(path) ?? 'plaintext'}`. Header shows
  **Save** (disabled while clean or in-flight) and **Cancel**.
- **Dirty state** blocks navigation — tree selection, route change, tab switch —
  with a confirm. The Files tab is a place users click around in; losing an edit
  to a stray click is the obvious failure to design out.
- **Divergence warning** (§Concurrency): while the file is open, a banner
  appears when the on-disk hash stops matching — including after a save, which
  is how the user learns the agent overwrote their edit.
- **Uncommitted honesty.** While dirty and after saving, the header states the
  edit lives in the worktree and is not committed, linking the existing commit
  affordance.
- **Conflict** is non-destructive: the user's text stays in the editor, with
  **Reload** (discard mine, refetch) and **Copy my version**. Never auto-resolve.
- **Hosted mode / kill switch** hide the Edit button via `fileEdit`. The server
  still refuses — the hidden button is UX, the `409` is the control.
- **Accessibility**: `CodeEditor` deliberately does not trap Tab, so keyboard
  navigation out keeps working. Preserve light/dark/system theming per AGENTS.md.

## Edge Cases & Failure Scenarios

| Case | Behavior |
|---|---|
| Agent rewrites the file while the editor is open | `baseHash` mismatch → `409` → conflict banner; the user's text is preserved. |
| Agent rewrites the file **after** the user saves | Not preventable (§Concurrency race 2). Divergence banner warns; the `file-edited` event holds the user's bytes. |
| Agent **deletes** the file while the editor is open | `readWorktreePath` → `missing` → `409`. Banner offers "Copy my version"; no accidental resurrection. |
| Symlink, symlinked parent, `.git`, path escape | `readWorktreePath` → `invalid` → `409`. Inherited, already tested. |
| Non-UTF-8 bytes that pass the NUL sniff | `editable: false`; `PUT` refuses. §Encoding. |
| Worktree reclaimed mid-edit (retention, #483) | `worktreeOf(run)` empty → `409 NO_WORKTREE`. |
| Content grows past the cap in the editor | Refused (`409`); the editor warns as the cap is approached, not only on save. |
| Request body over the cap | `413` before parsing. |
| Disk full / EACCES during write | tmp write fails → tmp removed → `500` with the OS message; the original is untouched. |
| Process dies between tmp write and rename | Original intact; a stray `.<file>.cez-tmp-<rand>` remains. No sweeper — zero-config forbids *required* new state, and a recognizable tmp name is enough. |
| CRLF / trailing newline | Bytes written verbatim. No normalization. |
| Empty content | Allowed — truncating a file is a legitimate edit. |
| Two cockpit tabs editing one file | Second save conflicts on `baseHash`. Same mechanism, no special case. |
| File is untracked or gitignored | Editable, but `git checkout --` will not restore it (§Risks). The `file-edited` event is the only recovery path — which is why it is not optional. |

## Risks & Impact Review

**Blast radius.** One new route, one new server module, three additive response
fields, one additive capability, one new NDJSON event type, one changed
component. `readWorktreePath()` gains a second caller but no modification.

**Backward compatibility** (`BACKWARD_COMPATIBILITY.md`):

- §2 — new `PUT` method on an existing path: **additive**. No route removed or
  renamed, no response field removed, `GET` behavior unchanged. New `hash` /
  `editable` / `editableReason` fields and `fileEdit` on `/api/health`:
  additive. §2 flags `/api/health` as the most externally-depended-on JSON in
  the app — adding a field is safe; existing fields are untouched.
- §3 — the `file-edited` NDJSON event is a new `type` on an append-only log
  whose readers skip unknown lines: additive.
- §7 — untouched. `file-edited` is a run event, not an `AgentEvent`/`UiEvent`,
  so the backend-parity requirement does not apply.
- Document the route, the fields and the event in `BACKWARD_COMPATIBILITY.md`
  and `AGENTS.md`, and `CEZ_NO_FILE_EDIT` in `.env.example`, in the same PR.

**Rollback story.** Tracked files: `git checkout -- <path>`, and the run's diff
view already shows the change. Untracked/ignored files: git has nothing to
restore, so the `file-edited` event is the recovery path. Stating both is the
point — the earlier framing that rollback is "free via git" is true only for
tracked, committed state.

**Dependencies.** #467 (CSRF / DNS rebinding) is a **hard blocker** unless an
`Origin`/`Host` allowlist ships in this work (§Security 5). PR #418 supplies the
editor, with the vendoring fallback in Q1 so a stall does not block delivery.

**Residual risk.** A user with local cockpit access can write any non-`.git`,
non-symlinked, UTF-8 file in a worktree. That user already has a shell on the
machine and an agent with unrestricted `Bash` (#430), so the route widens no
real boundary locally. Hosted mode is where it would, and hosted mode refuses.

## Phasing

The split is **vertical**, not server-then-client. A server-only phase would put
the entire risk of a browser-reachable write primitive on `main` while
delivering zero user value — nobody curls a `PUT` to fix one variable — for
however long the UI takes. Phase 1 is therefore the smallest end-to-end slice
that a user can actually use.

- **Phase 1 — edit and save, end to end.** Route + `worktree-write.ts` +
  hash/editable on the `GET` + `fileEdit` + kill switch + the `file-edited`
  event + the editor UI with dirty state and conflict handling. Shippable and
  useful on its own.
- **Phase 2 — divergence awareness.** The open-file hash watch and the
  post-save "agent overwrote your edit" banner, plus surfacing `file-edited` in
  the Session timeline. Phase 1 is safe without it (the edit is already
  recorded); Phase 2 makes the loss *visible* rather than merely recoverable.

Both leave the app working. Neither changes existing behavior.

## Implementation Plan

Every step ends with the AGENTS.md gate: `npm run typecheck`, `npm test`, `npm
run test:unit`, `npm run build`, `npm run test:package`; `npm run test:e2e` at
phase completion.

### Phase 1 — edit and save

1. **Hash, UTF-8 check, and the `GET` fields.** `fileHash(bytes)` (sha-256,
   `sha256:` prefix) and a strict UTF-8 decode; return `hash`, `editable`,
   `editableReason` from the `type: 'file'` branch (`server.ts:1131-1140`).
2. **`fileEdit` capability + kill switch.** Extend `Capabilities` and
   `resolveCapabilities()` (`src/server/capabilities.ts`); add
   `CEZ_NO_FILE_EDIT` and update `.env.example`. *Tests:* true by default; false
   under `CEZ_REMOTE=1`, a non-loopback bind, and the kill switch.
3. **`src/server/worktree-write.ts`.** `writeWorktreeFile()`: resolve via
   `readWorktreePath()`; reject directory / binary / non-UTF-8 / over-cap /
   missing; compare `baseHash`; re-hash from the open descriptor immediately
   before the rename; atomic tmp+rename preserving mode; return `{ path, size,
   hash }`. *Tests (temp dir, no server):* success; traversal; `.git`; symlink;
   symlinked parent; directory target; binary; non-UTF-8; over-cap; hash
   mismatch; empty content; mode preserved; original intact when the write
   throws.
4. **The route.** `PUT /api/runs/:id/files` beside the `GET`: run lookup →
   404, `worktreeOf` → 409, hosted-mode and kill-switch → 409, body cap → 413,
   zod `safeParse` → 400, delegate, map to the status table. *Tests:* every row.
5. **Security guards, in the same commit as step 4.** (a) A `409` under
   `CEZ_REMOTE=1` for an *otherwise perfectly valid* request — written so it
   cannot pass for the wrong reason. (b) The `Origin`/`Host` allowlist, tested
   against a rebinding-shaped request (a valid `Origin` with a foreign `Host`),
   unless #467 has landed and supplies it — in which case assert this route is
   covered by it.
6. **The `file-edited` run event.** Append on success with `{ path, baseHash,
   hash, size, content }` through the existing redaction path. *Tests:* event
   appended with the redacted content; no event on any refusal.
7. **Client + edit mode.** `putRunFile()`, `useSaveRunFile()`, and
   `file-preview.tsx`'s Edit/Save/Cancel with `CodeEditor` and `langForPath`.
   Per Q1, vendor `code-editor.tsx` if #418 has not merged, with a
   de-duplication follow-up. *Tests:* Edit button absent when `editable` is
   false and when `fileEdit` is false; present for editable text.
8. **Dirty-state guard and conflict UX.** Confirm on navigation while dirty;
   `409` conflict leaves typed text in the editor with Reload / Copy my version.
   *Tests:* navigation blocked dirty and allowed clean; conflict preserves text.
9. **Docs.** `BACKWARD_COMPATIBILITY.md` (§2 route + fields, §3 event),
   `AGENTS.md` route table, `README` env table for `CEZ_NO_FILE_EDIT`.
10. **E2E.** `web/app/e2e/`: browse → edit → save → the change appears in `GET
    /api/runs/:id/changes`, under `CEZ_DRY_RUN=1`.

### Phase 2 — divergence awareness

11. **Open-file hash watch.** Refetch the hash on the per-run SSE stream and on
    window focus while a file is open. *Test:* banner appears when the on-disk
    hash diverges.
12. **Post-save overwrite warning.** Distinguish "changed before your save"
    (conflict) from "changed after your save" (overwritten), with the recovery
    pointer to the recorded edit. *Test:* the post-save case renders the
    overwrite wording, not the conflict wording.
13. **Session-timeline note.** Surface `file-edited` as a note in the thread so
    a human intervention is visible beside the agent's tool calls. *Test:* the
    event renders as a note.
