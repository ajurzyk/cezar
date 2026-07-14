# Paseo (github.com/getpaseo/paseo) — UI/UX research for cezar

Researched 2026-07-14 from a shallow clone of `getpaseo/paseo` @ main (v0.1.107, AGPL-3.0). All file paths below are repo-relative. Local clone kept at `/tmp/claude-1000/-home-pkarw-Projects-cezar/4866af8d-803f-4946-a3fe-9a1201e47948/scratchpad/paseo-src` for follow-up reading.

---

## 1. What it is

Paseo is a **self-hosted, multi-provider coding-agent orchestrator**: "One interface for Claude Code, Codex, Copilot, OpenCode, and Pi agents" — run agents in parallel on your own machines, ship from your phone or desk. It is famous for **mobile + voice control** of local agents.

Architecture (docs/architecture.md):

- **Daemon** (`packages/server`, Node.js): spawns/manages agent processes (Claude Agent SDK, Codex app-server, Copilot ACP, OpenCode, Pi, custom ACP), streams a timeline model over **WebSocket**, persists agents as file-backed JSON under `$PASEO_HOME/agents/`. Also: cron **schedules**, **loop-service** (retry-until-done runs), chat rooms for agent-to-agent messaging, an MCP server exposing daemon control (create_agent, send_agent_prompt, worktrees, terminals) to other agents.
- **Protocol** (`packages/protocol`): single source of truth for wire schemas (zod), timeline types, binary frame codecs — shared by daemon and every client. **Presentation logic for tool calls lives here too** (`protocol/src/tool-call-display.ts`), so CLI/app/web render tool calls identically.
- **Client** (`packages/client`): daemon WebSocket driver + `PaseoClient` SDK facade.
- **App** (`packages/app`): ONE **Expo / React Native codebase for iOS, Android, and web** (react-native-web). This is the entire GUI.
- **Desktop** (`packages/desktop`): **Electron wrapper around the same web app** that bundles and auto-manages the daemon (electron-updater, tray-ish daemon lifecycle).
- **CLI** (`packages/cli`): `paseo run --provider claude/opus-4.6 --worktree feature-x "..."`, `paseo ls / attach / send`, remote `--host`.
- **Relay** (`packages/relay`): optional **E2E-encrypted relay** (Cloudflare Workers adapter) so the phone reaches the home daemon without port-forwarding. Pairing is via **QR code** (`app/pair-scan.tsx`, `expo-camera`).

Key product framing (docs/product.md): projects auto-detected from filesystem → each project has workspaces → extra workspaces are **git worktrees** ("isolated copies where agents work without affecting main") → a workspace is a "flexible canvas" of split panes: agents, terminals, browsers, files.

---

## 2. Tech stack

| Layer | Choice | Notes |
|---|---|---|
| Framework | **Expo 54 / React Native 0.81 / React 19** + react-native-web | one codebase → iOS, Android, web, Electron |
| Routing | **expo-router 6** (file-based) | URL scheme: `/h/[serverId]/workspace/[workspaceId]`, `/h/[serverId]/agent/[agentId]` — host-scoped, deep-linkable |
| Styling | **react-native-unistyles 3** with full token theme in `packages/app/src/styles/theme.ts` (colors incl. multiple named dark tints — zinc, blue, Anthropic-orange `#d97757`, catppuccin-ish — SPACING/FONT_SIZE/ICON_SIZE/RADIUS scales) | no Tailwind, no NativeWind |
| UI kit | **Homemade primitives** in `packages/app/src/components/ui/` (button, tooltip, dropdown-menu, context-menu, combobox, segmented-control, adaptive-modal-sheet, status-badge, shortcut, alert, floating panels) — shadcn-like discipline without shadcn | `@gorhom/bottom-sheet` for sheets, `@dnd-kit` for web drag/drop, `react-native-reanimated` worklets for gestures |
| Icons | lucide-react-native + material-icon-theme for file icons | |
| State | **Zustand (many small persisted stores)** + **TanStack React Query** (server data: git status, diffs, PR status, branches) + custom timeline reducers | stores: `session-store`, `panel-store`, `workspace-tabs-store`, `workspace-layout-store`, `sidebar-*-store`, `draft-store`, `review/store` … all in `packages/app/src/stores/` |
| Lists | `@tanstack/react-virtual` on web, FlatList on native (dual "stream strategy") | |
| Terminal | **xterm.js** (+webgl/fit/search addons) on web; on native, xterm inside a **WebView** built by `scripts/build-terminal-webview-html.mjs` | |
| Markdown | react-native-markdown-display + own `@getpaseo/highlight` package (syntax highlighting shared server/client) | |
| i18n | i18next, 8 locales, ALL strings in `src/i18n/resources/*.ts` | |
| Voice | own native module `packages/expo-two-way-audio`; server-side STT/TTS providers: **OpenAI** or **fully local sherpa-onnx** (Parakeet TDT 0.6b STT, Kokoro TTS) | |
| Testing | vitest + vitest browser mode, Playwright e2e, Maestro (mobile) | enormous colocated-test discipline: almost every `.ts` has a `.test.ts` |

---

## 3. Layout & navigation model

### Desktop / web (wide)
- **Left sidebar** (`components/left-sidebar.tsx`, ~1000 LOC; pinned on desktop, overlay on compact): **Projects → Workspaces → Agents** tree (`sidebar-workspace-list.tsx`, `agent-list.tsx`), with pinning (`workspace-pins/`), drag-reorder, collapsed-sections store, host switcher combobox in the footer, and **sidebar callouts** (cross-cutting alerts like "Set up worktree scripts", app-update available — `components/sidebar-callout.tsx`, registered via `useSidebarCallouts()`).
- **Workspace screen** (`screens/workspace/workspace-screen.tsx`): a **tab row** (`workspace-desktop-tabs-row.tsx`) + **split panes** (`components/split-container.tsx`, 1156 LOC, with drag-to-split drop zones `split-drop-zone.tsx`). Tab targets are a typed union (`stores/workspace-tabs-store/state.ts`):
  `draft | agent | provider_subagent | terminal | browser | file | setup`
  Panels are registered in a **panel registry** (`panels/panel-registry.ts`, `panels/register-panels.ts`) mapping tab-kind → component: `agent-panel.tsx`, `terminal-panel.tsx`, `browser-panel.tsx`, `file-panel.tsx`, `draft-panel.tsx`, `setup-panel.tsx`, `provider-subagent-panel.tsx`. This is the cleanest part of their architecture: adding a pane type = registering a descriptor.
- **Right explorer sidebar**: file explorer / git diff / (compact variant `compact-explorer-sidebar-host.tsx`), resizable via `resize-handle.tsx`, widths clamped in `stores/panel-store/state.ts`.
- Workspace header: branch switcher combobox (`components/branch-switcher.tsx`), **git actions split button**, scripts button, "open in editor" button (`workspace-open-in-editor-button.tsx`).
- **Command center** (`components/command-center.tsx`) and a full **customizable keybindings system** (`keyboard/`, `stores/keyboard-shortcuts-store.ts`, `components/keyboard-shortcuts-dialog.tsx`) with chords rendered by a `<Shortcut>` primitive in every tooltip.

### Mobile / compact
- Documented state machine in **docs/mobile-panels.md** — worth copying conceptually. Three mutually exclusive destinations: `agent-list` (left) / `agent` (center) / `file-explorer` (right). ONE normalized position value (-1/0/1) drives both drawer transforms and backdrop opacities in a Reanimated worklet; React/Zustand owns the durable intent `{target, revision}`; gestures capture a revision and lose ownership when a newer command arrives. This makes "both drawers open", "backdrop disagrees with panel" etc. **unrepresentable states**. Implementation: `mobile-panels/{model.ts,gestures.ts,presentation.tsx,provider.tsx}`.
- Compact-first responsive rule (docs/design.md §8): one `useIsCompactFormFactor()` branch at the top of a screen; list+detail = full-screen push on compact, 320px sidebar + detail pane on desktop; **same components in both layouts, only the framing changes**. "Tabs collapse on compact, panes split on desktop."
- `@gorhom/bottom-sheet` sheets replace centered modals on compact via one primitive `<AdaptiveModalSheet>`.

### Routes (expo-router, `src/app/`)
```
/                     → host picker / redirect
/h/[serverId]/        → host home
/h/[serverId]/workspace/[workspaceId]
/h/[serverId]/agent/[agentId]
/h/[serverId]/sessions   (history)
/new                  → new workspace flow
/schedules, /sessions, /settings/[section], /settings/projects/[projectKey], /pair-scan, /welcome
```
Multi-host is first-class: every resource URL is prefixed by the daemon (`serverId`); `HostRuntimeController` manages saved hosts + reconnection.

---

## 4. Rendering agent sessions, tool calls, diffs

### Timeline / stream
- Server streams a **timeline model**; client reducers in `timeline/session-stream-reducers.ts` handle compaction, gap detection, **sequence-number dedup**; `docs/timeline-sync.md` doctrine: *"live streams are for immediacy, `fetch_agent_timeline_request` is authoritative, catch-up is paged but complete."* (Great pattern for reconnect-heavy mobile.)
- Rendering is a **platform strategy pair** (`agent-stream/strategy-web.tsx` = @tanstack/react-virtual with height estimation `web-virtualization.ts`; `strategy-native.tsx` = FlatList) behind one interface (`agent-stream/strategy.ts`), plus a `bottom-anchor-controller.ts` for stick-to-bottom with 64px threshold and user-scroll detection, and `turn-boundary.ts`/`turn-footer.tsx` for per-turn grouping and turn duration.
- `components/message.tsx` (3228 LOC — their biggest UI file) renders markdown messages, tool-call chips, plan cards (`plan-card.tsx`), question/permission forms (`question-form-card.tsx`), compaction labels, fork menu (`assistant-fork-menu.tsx`), rewind (`components/rewind/`).
- Composer extras: **context-window meter** (`context-window-meter.tsx`) inline in the composer footer; queued-message semantics (send vs queue vs send-and-interrupt — see `composer/input/labels.ts`).

### Tool calls
- **Display model is computed in the protocol package** (`protocol/src/tool-call-display.ts`): maps detail type → `{displayName, summary}` — e.g. read/edit/write → file path with cwd prefix stripped, bash → command, search → query, fetch → url, task → subagent type + description. Client wraps it in `tool-calls/presentation.ts` adding icon resolution, pending state, `canOpenDetails`, `openFilePath` (tap a Read/Edit tool call → opens that file in the file panel), `isPlan`.
- Collapsed **chip row** in the stream; tapping opens `components/tool-call-sheet.tsx` (bottom sheet on mobile) / `tool-call-details.tsx` (987 LOC) with full input/output, diffs for edits, errors.
- Status union: `executing | running | completed | failed | canceled`; loading-details state is explicit (`isPendingToolCallDetail`).

### Diffs
- `components/diff-viewer.tsx` (282 LOC): line-based rows (`add/remove/context/header`) with syntax-token coloring (`styles/syntax-token-styles.ts`), horizontal ScrollView per block, monospace enforced by a `CODE_SURFACE_DATASET` marker (`styles/code-surface.ts`) that excludes code surfaces from the user-selected UI font.
- **Git diff pane** (`components/git-diff-pane.tsx`, ~2300+ LOC) + `git/diff-pane.tsx`, `git/diff-tree.ts` (file tree with folders), `git/diff-flat-items.ts`, per-file ordering, scroll-position logic (`git/diff-scroll.ts`), whitespace toggle, base-ref selection.
- **Review comments on diffs → agent input**: `review/store.ts` + `review/surface.tsx` — the user writes inline draft comments on diff lines (persisted per `{serverId, workspaceId, cwd, mode, baseRef}` key in AsyncStorage), and they become a typed **`review` attachment** on the composer message (`attachments/types.ts` → `AgentAttachment {type:"review"}` with per-comment context lines). i.e. *code-review the agent's diff, then send all comments as one structured prompt.* This is a standout feature to copy.

---

## 5. Mobile / PWA / voice story

### PWA
- Web build is `expo export --platform web` deployed to Cloudflare Pages; `packages/app/public/manifest.json`: `display: standalone`, portrait, theme `#181B1A`, maskable 192/512 icons, description "Monitor and control local AI coding agents from anywhere." **No service worker found** — it's an installable PWA shell, not offline-capable; connectivity is live WebSocket anyway.
- Native apps are real (App Store / Play / F-Droid dir present), with `expo-notifications` **push notifications for agent attention** (`protocol/src/agent-attention-notification.ts`), haptics, keep-awake, camera QR pairing.

### Voice & dictation UX (the flagship) — two distinct modes, carefully labeled
All labels in `src/i18n/resources/en.ts`; label logic in `composer/input/labels.ts`.

**Mode A — Dictation (STT-only, push-to-talk into the text box):**
- A **mic button sits inside the composer footer, immediately left of the send button**. Idle tooltip (desktop, with shortcut chord): **"Dictation"**; accessibility label "Start dictation" / "Stop dictation".
- Press → mic streams PCM16 to the daemon (`dictation/dictation-stream-sender.ts` → server `dictation/dictation-stream-manager.ts`, resampling, silence-peak detection, seq-numbered segments, auto-commit every 15s, generous final-timeout accounting for pending segments).
- While recording, the whole composer footer is replaced by a **full-width accent-blue `DictationOverlay`** (`components/dictation-controls.tsx`): live **horizontal volume meter** (`volume-meter.tsx`), mm:ss timer, growing **partial transcript** text, and three actions: **X = cancel**, **✓ = "Insert transcription"** (put text in input for editing), **↑ = "Insert transcription and send"** (one-tap dictate-and-go). Failure state swaps in a retry (⟳) with "Dictation failed. Tap retry."
- Mic icon becomes a filled **Square (stop)** while dictating. Keyboard chords exist for `dictation-toggle`, `dictation-confirm`, `dictation-cancel` (see `keyboard/`, settings list "Start/stop dictation").
- STT backends resolved server-side (`server/speech/speech-config-resolver.ts`): **OpenAI** or **local sherpa-onnx Parakeet** — daemon does the transcription, so phone clients need no keys.

**Mode B — Voice mode (realtime conversational agent):**
- A separate **audio-lines icon button** on the right side of the composer (shown only when an agent exists and is not running), tooltip **"Voice mode"** with its own shortcut; label "Enable Voice mode". Guard copy: "Interrupt the agent before starting voice mode".
- Activating replaces the footer with `components/realtime-voice-overlay.tsx`: volume meter with speaking indicator, **mute/unmute** button, **stop** button ("Stop realtime voice and interrupt turn").
- Server side (`server/voice-config.ts`) is clever: voice mode **injects a `<paseo_voice_mode>` system-prompt block** telling the agent "user cannot see chat; always use the `speak` tool; acknowledge before non-speak tools; give spoken progress updates", wraps user turns as `<spoken-input>` with an instruction to reply via speak-tool only, and exposes `speak` via an MCP stdio socket. Turn control in `server/session/voice/voice-turn-controller.ts`; TTS via OpenAI or local Kokoro.
- Voice availability messaging is centralized (`resolveVoiceUnavailableMessage`, toast on tap when STT is unconfigured).

**Labeling takeaway for cezar:** they never mix the two concepts — mic icon = "Dictation" (text ends up in the prompt box, user confirms), audio-lines icon = "Voice mode" (hands-free conversation). Both live in the prompt composer footer, tooltips carry the shortcut chord, and every state (idle/recording/processing/failed/muted) has explicit accessible labels.

---

## 6. Git / worktree UX

- **Isolation choice at workspace creation** (`screens/new-workspace-screen.tsx`, 2420 LOC): a segmented "Isolation" control — **"Local"** (work in the checkout) vs **"New worktree"**; worktree implies a **ref picker** ("Start from", searches **branches AND GitHub PRs** — "Check out PR #123 into main"), and a base label. Worktree only offered when the project is git and the host `canCreateWorktree` (`use-worktree-isolation` logic at line ~740).
- Server (`server/worktree-core.ts`, `paseo-worktree-service.ts`): slugified branch names via `mnemonic-id` when unnamed, `attemptFirstAgentBranchAutoName` **renames the branch automatically from the first agent prompt**, per-project **worktree setup scripts** (install deps on worktree creation — surfaced as a sidebar callout "Set up worktree scripts" when missing, `worktree-setup-callout-source.tsx`), archive service + auto-archive after merge.
- **Git actions split button** in workspace header (`git/actions-split-button.tsx` + `git/policy.ts`): a policy function computes `{primary, secondary, menu}` from full git/PR state. Action union: `commit, pull, push, pull-and-push, pr, merge-pr-{squash,merge,rebase}, enable-pr-auto-merge-{…}, disable-pr-auto-merge, merge-branch, merge-from-base, archive-workspace`. Each action carries `label/pendingLabel/successLabel/disabled/unavailableMessage` — disabled entries explain themselves ("Push isn't available yet because there are newer changes to bring in first"). After merge, **archive-workspace is promoted to the primary slot** (`shouldPromoteArchive`) — a tight loop: create worktree → agent works → commit → PR → merge → archive.
- **PR panel** (`git/pull-request-panel/`): PR status, checks, timeline (protocol has `pull-request-timeline` messages); GitHub attachments (`github.pull_request_review` etc.) can be pulled into the composer.
- Branch switcher in header (`components/branch-switcher.tsx`, combobox), copy path / copy branch actions, worktree-archive warning when uncommitted changes exist.

---

## 7. Design system doctrine (docs/design.md — read it in full, it's exceptional)

Highlights worth adopting verbatim:
- "The app is calm so the user's work is not. Every visual decision serves either *act on this* or *understand this* — never *look at this*."
- **Hierarchy by weight and color, not size** (nearly everything is `fontSize.base`/`xs`; foreground vs foregroundMuted carries meaning; 3 weight tiers by role).
- **One accent-filled CTA per surface, most surfaces have zero.** Destructive red only appears inside the confirm dialog, never on the page.
- 5 picker primitives with a decision rule: "Three themes is DropdownMenu. Thirty hosts is Combobox. A label and a value is AdaptiveModalSheet. 'Are you sure?' is confirmDialog."
- Copy rules: sentence case, imperative buttons, "Saving..." with literal three dots, errors "describe state; they do not editorialize". Fixed terminology table (Workspace never "checkout"; Project not "repo").
- State rules: loading inline next to the thing; empty states = short noun phrase, max one ghost button; disabled = opacity 50, never a color change.
- "A semantic element used in three or more places is a primitive. One of a kind is a screen."

---

## 8. What cezar should copy

1. **Panel registry + typed tab-target union** (`panels/panel-registry.ts`, `workspace-tabs-store/state.ts`). Workspace = tabs of `agent | terminal | browser | file | draft | setup` panels, splittable on desktop, single-pane swipe deck on mobile. Cheapest path to "flexible canvas".
2. **Tool-call display model computed in a shared protocol layer**, not in components — one `{displayName, summary, icon, openFilePath}` mapping reused by every client; collapsed chip → details sheet; tap a file-touching tool call to open the file.
3. **Timeline sync doctrine**: streams for immediacy, fetch is authoritative, seq-dedup + paged catch-up reducers (`timeline/session-stream-reducers.ts`). Essential for phones that sleep.
4. **Review-comments-on-diff → structured attachment on the next prompt** (`review/store.ts`). The single best "human steers agent" interaction found here.
5. **Dictation UX exactly as they do it**: mic next to send, tooltip "Dictation" + shortcut, full-width overlay with meter/timer/partial transcript, and the three-way finish (cancel / insert / insert-and-send). Keep dictation and conversational voice mode as *separately labeled* features.
6. **Voice-mode prompt contract**: system-prompt block + `speak` tool + "acknowledge before acting" is a portable pattern (no realtime-model lock-in; works with any agent CLI).
7. **Git action policy object** (`git/policy.ts`): pure function state → `{primary, secondary, menu}` with self-explaining disabled reasons; promote "Archive workspace" post-merge.
8. **Worktree-first workspace creation** with PR checkout in the ref picker, setup scripts, and branch auto-naming from the first prompt.
9. **Attention model**: `deriveAgentStateBucket` (`protocol/src/agent-state-bucket.ts`) — permission > error > running > attention(finished) priority, driving sidebar status dots and push notifications. One canonical function, used everywhere.
10. **Mobile-panels one-position state machine** (docs/mobile-panels.md) if cezar builds gesture drawers.
11. **docs/design.md as a genre**: an enforced, file-referenced design constitution; and per-feature architecture docs (mobile-panels, timeline-sync, floating-panels, hover).
12. **QR-code pairing + E2EE relay** for remote/mobile access without port forwarding; multi-host URLs (`/h/[serverId]/…`).
13. **Daemon-side STT with a local (sherpa-onnx Parakeet) fallback** — clients stay keyless and thin.

## 9. What cezar should deliberately avoid

1. **React Native everywhere for a web-first product.** Paseo pays constantly: dual stream strategies (FlatList vs react-virtual), xterm-in-a-WebView on native, `markdown-text.{android,ios,web}.tsx` triplets, `.native/.web` forks of audio/height-mirror/scrollbars, docs warning "Unistyles and Reanimated patching the same Fabric node has caused native crashes". If cezar is web/PWA-first, plain React + real DOM wins; only copy their *patterns*.
2. **Monster components**: `message.tsx` 3228 LOC, `composer/index.tsx` 2193, `input.tsx` 2099, `new-workspace-screen.tsx` 2420, `git-diff-pane.tsx` ~2300. They compensate with extracted pure-logic `.ts` + tests, but don't start here.
3. **No service worker / offline shell** — an orchestrator PWA should at least cache the shell and show cached last-known agent state; Paseo shows nothing without the socket.
4. **Custom-building every primitive** (combobox, tooltip, context menu, floating panels have hundreds of LOC + math tests each) — a cost forced by RN; on the web use Radix/shadcn and spend the effort on the agent surfaces instead.
5. **i18n of the entire surface from day one** (8 locales, locale-drift checks) — heavy process tax for an early product; do note their key-per-state labeling discipline though.
6. **Their store sprawl** (30+ zustand stores with cross-store patches) works but needs their test discipline; prefer fewer stores with selectors.
7. **Electron + Expo + relay + CLI + website in one monorepo** before product-market fit — Paseo is a solo maintainer straining under it (README: "I'm a solo maintainer and don't always keep up with GitHub Issues").

---

## Appendix: fast file map

| Concern | File(s) |
|---|---|
| Design constitution | `docs/design.md` |
| Mobile drawer state machine | `docs/mobile-panels.md`, `packages/app/src/mobile-panels/*` |
| Routes | `packages/app/src/app/**` (expo-router) |
| Sidebar | `packages/app/src/components/left-sidebar.tsx`, `sidebar-workspace-list.tsx`, `agent-list.tsx`, `sidebar-callout.tsx` |
| Workspace shell | `packages/app/src/screens/workspace/workspace-screen.tsx`, `workspace-desktop-tabs-row.tsx`, `components/split-container.tsx` |
| Panel registry | `packages/app/src/panels/panel-registry.ts`, `register-panels.ts`, `stores/workspace-tabs-store/state.ts` |
| Agent stream | `packages/app/src/agent-stream/*`, `timeline/session-stream-reducers.ts`, `components/message.tsx` |
| Tool calls | `packages/protocol/src/tool-call-display.ts`, `packages/app/src/tool-calls/presentation.ts`, `components/tool-call-sheet.tsx`, `tool-call-details.tsx` |
| Composer | `packages/app/src/composer/index.tsx`, `composer/input/input.tsx`, `composer/input/labels.ts` |
| Dictation | `components/dictation-controls.tsx`, `hooks/use-dictation.ts`, `dictation/dictation-stream-sender.ts`, server `server/dictation/dictation-stream-manager.ts`, `server/speech/**` |
| Voice mode | `components/realtime-voice-overlay.tsx`, `voice/voice-runtime.ts`, server `server/voice-config.ts`, `server/session/voice/*` |
| Diffs & review | `components/diff-viewer.tsx`, `components/git-diff-pane.tsx`, `git/diff-*`, `review/store.ts`, `review/surface.tsx` |
| Git actions | `git/policy.ts`, `git/actions-split-button.tsx`, `git/use-actions.tsx` |
| Worktrees | server `server/worktree-core.ts`, `paseo-worktree-service.ts`; UI `screens/new-workspace-screen.tsx` |
| Theme | `packages/app/src/styles/theme.ts` |
| Attention/status | `packages/protocol/src/agent-state-bucket.ts`, `components/agent-status-dot.tsx`, `protocol/src/agent-attention-notification.ts` |
| PWA | `packages/app/public/manifest.json` |
