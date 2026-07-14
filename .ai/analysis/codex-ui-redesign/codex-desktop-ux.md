# OpenAI Codex Desktop App — UI/UX Research (for cezar parity spec)

Research date: 2026-07-14. Sources: OpenAI/ChatGPT Learn docs (learn.chatgpt.com), the official Codex changelog, openai/codex GitHub issues, hands-on reviews (Medium, Substack, Codex Knowledge Base, Unlock AI guide), reverse-engineering write-ups, and Claude Code desktop material as a secondary reference. Codex ships across four surfaces — CLI, IDE extension, cloud/web (chatgpt.com/codex), and the desktop app (macOS first, then Windows/Microsoft Store) — with shared sessions in `~/.codex/sessions/` and shared config in `~/.codex/config.toml`.

---

## 1. Overall layout

**Three-region layout: left sidebar → center thread → right "workbench" side panel.**

- **Left sidebar** (navigation): New chat/task, Search (⌘G), Plugins, Automations, **Pinned items**, **Projects** (top-level, each containing nested threads), **Chats/Tasks**, Settings pinned at the bottom. Tasks can be filtered by state and re-sorted (filter icon next to Tasks → "Chronological").
- **Projects contain threads.** Each thread = one agent instance with its own persistent context; sessions survive app restarts. The sidebar visually distinguishes the thread's execution mode at a glance:
  - **Local** — runs directly in the project checkout (foreground),
  - **Worktree** — isolated git worktree for parallel agents on the same repo (background),
  - **Cloud** — delegated to OpenAI-hosted environment (requires GitHub connection).
  Worktrees appear as their own entries in the sidebar; you can create threads inside each worktree and manage them visually. Permanent worktrees are created via the project sidebar's **three-dot menu**.
- **Right side panel: five-tab workbench** (toggle ~⌘⌥B):
  1. **Files** — folder structure + file changes in real time; rich previews for PDFs, spreadsheets, slides, docs.
  2. **Side chat** — secondary conversation "above the composer" that pulls context from the main thread but doesn't feed back into it.
  3. **Review** — the diff/review pane (see §4).
  4. **Terminal** — live-streaming integrated terminal, scoped per thread/worktree; multiple terminal tabs supported.
  5. **Browser** — in-app browser for previewing local dev servers/HTML, with an **element annotation system**: click an element, type a note; Codex receives the note pinned to a screenshot of that exact element; ⌘Enter batches multiple annotations.
- **Top-right control bar** is the operational hub: git operations (commit, push, worktrees), terminal toggle, IDE toggle, and configurable **Actions** — user-defined recurring commands (Test, Dev Server, Lint) surfaced as shortcut buttons in the top toolbar, each with bundled environment settings.
- A **summary pane** tracks agent plans, sources, and artifacts for long-running work.
- **Floating window** mode: "always on top" mini window for side-by-side supervision.
- Claude Code desktop contrast: Claude went **drag-and-drop pane grid** (terminal, preview, diff viewer, chat arrangeable freely) + sidebar of parallel sessions filterable/groupable by status/project/environment, sessions auto-archive when their PR merges. Codex uses fixed regions with a tabbed side panel instead.

Tech stack (reverse-engineered, v26.x): Electron 40 + React 18, ProseMirror composer, Radix UI primitives, **Shiki** for syntax highlighting, **cmdk** command palette, **Framer Motion** for animation; node-pty terminal; Rust CLI backend; a git-native workspace model and built-in cron/automation system.

## 2. Chat / turn thread design

- **Agent turns are aggregate, collapsible activity groups, not a raw log.** The current "For coding" view collapses the action log into summary rows like **"Edited 3 files, explored 2 files, 2 searches"** and **"Ran 2 commands"**; clicking a summary expands the underlying items. (GitHub issue #19891 documents that earlier builds showed each item inline — "Edited `src/foo.ts`", "Ran `npm test`" — and users pushed back on over-collapsing; the consensus ideal: **edited file paths and command invocations visible by default; explored files, searches, command output, and diffs collapsed**.)
- **Reasoning/thinking**: shown as a transient "Thinking" status line with streamed reasoning summaries; collapsed by default in the thread. Progress statuses stream in-place ("Exploring files," "Running a command," "Thinking"). Changelog notes ongoing investment in "tool activity styling and progress indicators."
- **Commands/exec**: command invocations render in monospace chips/rows (`Ran npm test`); output is collapsed behind the row and expandable. Terminal output can also be watched live in the Terminal tab.
- **MCP tool calls** get dedicated rendering (changelog: "Improved rendering of MCP tool calls"), and Mermaid diagrams render inline.
- Final assistant message: markdown summary with syntax-highlighted code blocks (Shiki), file paths as clickable monospace links that open in the editor.
- **Follow-ups queue** while a turn is running; composer keeps focus (a regression where it lost focus after turn completion was bug-fixed — treat "focus returns to composer after each turn" as expected behavior).
- Long threads: `/compact` to summarize, `/fork` to branch a tangent into a new thread. Sub-agent/child threads exist for parallel work.
- View-density lesson from Claude Code desktop: **three view modes — Verbose / Normal / Summary** — dialing from full tool-call transparency to results-only. A good parity target: user-selectable verbosity of the activity log.

## 3. Plan / todo checklist rendering

- Codex has a dedicated **`update_plan` tool rendered as a checklist in the transcript**: checkbox list with three item states — **pending, in_progress, completed** — plus an optional explanation line. The plan re-renders/updates as steps complete (a known bug class is the checklist getting "stuck on the first step" — keep it live-synced).
- A **plan/checklist panel** also exists outside the transcript (summary pane) for tracking the active plan during long tasks.
- **Plan mode** is a distinct composer state (Shift+Tab toggle; also a "Plan mode" toggle in the ChatGPT-side composer): read-only iterative planning; Enter produces/refines a plan rather than executing; the composer stays in plan mode across submissions. Plan-mode **questions trigger notifications** so users notice when input is needed.
- "Proposed plan" output is distinct from the todo checklist (plan approval vs. progress tracking).

## 4. Diff & file-change presentation (Review pane)

- **Review pane tabs mirror git states**: **Unstaged** (default), **Staged**, **Commit** (a selected commit), **Branch** (diff vs base branch), **Last turn** (changes from the most recent assistant turn). This last-turn diff is the primary "what did the agent just do" affordance.
- **File tree** on the left of the pane (refreshed design, percentage-based resizing), per-file diffs on the right. "Clicking the file name background expands or collapses the diff." Expand-all / collapse-all controls exist. Collapsed files show a summary row.
- **Diff stats**: per-file and aggregate **+added/−removed counts**, with an **animated diff-stat** readout (changelog fixed its alignment — it's a real, polished element). Green added lines / red removed lines, standard unified diff.
- **Inline commenting**: hover a diff line → **+** button → attach a comment; comments become line-anchored feedback the agent iterates on. Comments are collapsible; review can run in **inline or detached** modes (Settings → General → Code review).
- **Stage / unstage / revert at three granularities**: whole diff, per file, per hunk. Selective staging + revert buttons per change.
- **Editor handoff from the diff**: clicking a file name opens it in your chosen editor; **Cmd+click a diff line opens that exact line** in the editor.
- `/review` in the composer starts an agent-driven code review with presets ("Review against a base branch", "Review uncommitted changes").
- Search within reviews/diffs; diff batching for performance; preserved diff & search state across navigation.
- **Codex web** task pages: **Diff** and **Logs** tabs — Logs shows step-by-step actions, commands, and thought process; Diff shows the changeset with expand/collapse-all.

## 5. Composer

Rich-text (ProseMirror) input, bottom-docked in threads, with a row of inline controls:

- **Model picker**: dropdown showing model + reasoning effort as one compact label (e.g. "gpt-5.3-codex Medium", "5.5 Extra High"); reasoning depth low/medium/high(/extra-high); also switchable via `/model`. `/fast` mode for speed-over-cost.
- **Approval/permission picker** built into the composer: desktop app wording **"Full access / Ask before edits / Read only"**; IDE extension wording **Chat (read-only) / Agent (default: edits + local commands) / Agent Full Access (adds network)**. Risky commands surface an approval prompt in-thread; an "automatic approval review" shows **review status and risk level** before a request executes.
- **Attachments**: paperclip for files/folders and images; paste screenshots; **image lightbox** with zoom + download. macOS **"Appshots"**: press both Command keys to attach the frontmost app window (screenshot + metadata) to the thread.
- **Dictation/voice**: mic button with dictation cleanup and a configurable **dictation dictionary** (names, file paths, code symbols); explicit error states for mic/connection/quota failures.
- **Slash commands**: typing `/` opens a command popup (works mid-draft): `/review`, `/model(s)`, `/theme`, `/compact`, `/fork`, `/pet`, permissions, personality, MCP actions, etc. Also a global **command palette** (cmdk) with MCP and personality actions.
- **Unified `@` mentions menu**: typing `@` offers **files, plugins, and skills in one keystroke** (fuzzy file search).
- **Skills** (prompt presets / reusable workflows) insertable from the composer; **"Done when" validation criteria** encouraged in prompts.
- Multiline: Enter submits; optional "Require Cmd+Enter for multiline prompts" setting. Queued messages while agent runs.
- **Pre-submit worktree selector**: local-project composer includes a "New worktree" selector so a task can start in an isolated worktree from the first message.

## 6. "New task" experience

- **Home screen = a centered, full-width composer** asking what you should work on — no empty chrome. Built directly into it: the **permission picker** (Full access / Ask before edits / Read only), the **model picker**, and a **project selector** (working directory) — so a task is fully parameterized before the first token. ⌘N = new task.
- Threads are **project-scoped at creation**; picking project + mode (Local / Worktree / Cloud) happens up front.
- Suggested prompts / context-aware follow-up suggestions appear (toggleable in Settings).

## 7. Git / PR integration

- Git is **first-class UI, not terminal-only**: auto-generated commit messages, staging, commit, push, and **Create PR** all in-app (top-right git controls + review pane buttons).
- **Codex web/cloud**: each task row shows title, repo (`acme/analytics-dashboard`), **branch name (`codex/csv-export`)**, date grouping (Today/Yesterday), status, and **diff stat "+31−1"**; per-task **Archive** action; tabs for **Tasks / Code reviews / Archive**. Completed tasks offer **"Create PR"**, which becomes **"View PR"** once opened; follow-up asks continue on the same branch ("Update PR").
- **PR review loop**: inspect GitHub PRs in the sidebar; the review pane shows reviewer comments alongside the diff; ask Codex to address feedback in the same task. `@codex review` / `@codex` mentions on GitHub PRs/issues trigger cloud tasks. Support for "addressing GitHub review comments" is built in.
- **Worktree lifecycle**: cloud/worktree → local **Handoff** ("hand it off to Local" applies the worktree's changes onto the main checkout for review/test/commit); automated worktree cleanup with a configurable limit in Settings.
- Branch filtering in review; base-branch selection for Branch diffs.

## 8. Handoff actions (terminal / IDE / OS)

- **Terminal toggle** in the top bar → integrated per-thread terminal (scoped to the project or the thread's worktree — an issue exists about it wrongly opening the base checkout, i.e. correct scoping is the expected UX).
- **IDE toggle / "Open in editor"**: opens the project or a specific file (or exact diff line via Cmd+click) in the user's chosen editor (VS Code, Cursor, etc.). Reviewers note "direct integration links to open generated files in external editors."
- Thread menu actions: **"Open in Finder" / "Open in Explorer" / "Open in File Manager."**
- Cross-surface continuity: same session resumable from CLI (`codex resume`), IDE extension, and app; IDE extension can send a task to cloud and pull the result back into the editor.

## 9. Settings UI

Sections (desktop app): **General** (Cmd+Enter requirement, prevent sleep while running, follow-up behavior, code-review inline/detached), **Profile** (activity insights, token metrics), **Keyboard Shortcuts** (fully customizable, searchable by command or keystroke), **Notifications**, **Appearance**, **Pets** (animated companion via `/pet`), **Browser** (allowlist/blocklist, Chrome extension), **Computer Use** (per-app access review), **Personalization** (personality: **Friendly / Pragmatic / None** — per-host — plus custom instructions / personal AGENTS.md), **Suggested Prompts**, **Memories**, **Archived Tasks**, **Floating Window**.

**Appearance panel** (live preview, applies immediately): base theme (light/dark/system + named themes: One, Catppuccin, Monokai, Solarized, Matrix… plus partner themes Linear/Notion), **accent color**, background/surface color, foreground/ink color, **contrast level**, opacity/translucent sidebars, **UI font and code font as separate settings**, pointer hover effects, and **semantic colors incl. `diffAdded` / `diffRemoved`**. Themes export/import as a compact `codex-theme-v1` JSON string for sharing. This is a deliberate differentiator: deep theming as a feature.

## 10. Notifications

- **Turn-completion notifications** (system notifications) with configurable timing; permission prompts surfaced in Settings.
- **Plan-mode questions and approval requests fire notifications** — the "agent needs input" signal is a core loop for parallel-agent supervision.
- iOS notifications deep-link to completed tasks (mobile surface).
- Approval requests show risk level before execution.

## 11. Visual design language, typography, spacing, animation

- **OpenAI's design language**: quiet, monochrome-leaning, typography-led. Product UI is **sans-only** — Söhne (Klim) / OpenAI Sans (ABC Dinamo, 2025 rebrand), Inter fallback — at restrained weights (400 body, 500 nav/labels, 600 emphasis). **The serif (Signifier) is editorial/marketing display only** (openai.com, launch pages, chatgpt.com/codex landing) — it is *not* used for in-app headings. If cezar wants the "OpenAI feel": a literary serif for marketing/empty-state display moments at most; sans throughout the product.
- Visual posture: near-empty palette; hierarchy carried by type scale/weight/spacing rather than color; minimal borders, no gradients or ornamental illustration; **soft pill-shaped interactive elements** (pickers, mode chips); accent color used sparingly for interactive highlights; monospace reserved for code, commands, file paths, branch names, and diff stats.
- **Density**: calm and roomy in the thread (chat-like), dense and information-rich in the review pane and task lists (repo, branch, diff stat, status per row). Sidebar is compact with small status glyphs per thread mode.
- **Dark/light**: full parity, system-following, plus user theming (§9) with semantic diff colors that adapt per theme.
- **Animations** (Framer Motion): branded **loading shimmer** on app start; streaming text; animated progress/status indicators during tool activity; **animated diff-stat counters**; smooth expand/collapse of activity groups and diffs; image lightbox transitions; optional pointer hover effects; the whimsical "Pets" overlay. Polish bugs OpenAI actively fixes (scroll jumpiness, sidebar jitter, diff scrolling) show 60fps-smooth long-thread scrolling is a stated quality bar.

## 12. Codex IDE extension (parity notes)

- Lives in the editor sidebar (Codex icon); composer at bottom with **mode selector below the input** (Chat / Agent / Agent Full Access) and model picker (e.g. "5.6-Sol" in current docs screenshots).
- Context: reference open files, selections, and recent threads from the composer; `@` mentions.
- Changes: **focused inline diffs** ("the changed lines without an extra navigation pane"), summary + diff + follow-up in the same thread, selective apply ("keep only the changes you want"), **Undo** after apply; uses the editor's native diff view for review.
- Cloud delegation: send a long task to Codex cloud and get a reviewable result back in the editor.

## 13. Claude Code desktop/web (secondary reference)

- **Sidebar of parallel sessions** with filters (status, project, environment) and group-by-project; sessions auto-archive on PR merge/close.
- **Drag-and-drop pane grid**: terminal, preview (HTML/PDF/local server), diff viewer, in-app file editor, chat arranged freely.
- **Verbose / Normal / Summary view modes** for tool-call transparency; **usage button** showing context-window and session usage at a glance.
- **Side chat** (⌘;) — one-way context branch, identical concept to Codex's side chat.
- Diff viewer rebuilt for large-changeset performance; red/green scannable in seconds.
- Routines (scheduled agents) ≈ Codex Automations.

## 14. Actionable parity checklist for cezar (condensed)

1. Sidebar: Projects → threads, with per-thread mode glyph (local/worktree/cloud) + status; pinned; filter/sort.
2. Home/new-task = centered composer with project selector + permission picker (Full access / Ask before edits / Read only) + model+reasoning picker; ⌘N.
3. Thread: collapsed activity groups ("Edited N files", "Ran N commands") with edited-file names + command invocations visible by default, output/diffs/searches collapsed; monospace for commands/paths; streamed "Thinking/Exploring/Running" status; MCP tool-call cards.
4. Live plan checklist (pending/in_progress/completed) rendered in-thread and mirrored in a summary pane; plan-mode with notification on questions.
5. Review pane with git-state tabs (Unstaged/Staged/Commit/Branch/Last turn), file tree, per-file collapse, +/− stats (animated), hover-+ inline comments, stage/revert at diff/file/hunk level, click-to-open-in-editor (Cmd+click = exact line).
6. Composer: `/` command popup, unified `@` menu (files/skills/plugins), image paste + lightbox, dictation with dictionary, queued follow-ups, focus retention.
7. Git: auto commit messages, commit/push/Create PR in-app; task rows show branch + diff stat; Create PR → View PR; address-PR-comments loop.
8. Handoff: Open in Terminal (thread-scoped), Open in IDE, Open in Finder; worktree→local handoff with auto-cleanup.
9. Settings: keyboard shortcut editor, notifications (turn completion + input needed), deep theming (base theme, accent/surface/ink, contrast, separate UI+code fonts, semantic diff colors, shareable theme string), personality presets.
10. Design language: sans-only product type (serif only for display/marketing moments), pill controls, sparse accent color, shimmer/streaming/expand-collapse motion, dark/light/system.

---

## Key sources

- https://learn.chatgpt.com/docs/changelog (Codex changelog — UI entries 2026-02→07)
- https://learn.chatgpt.com/docs/code-review?surface=app (review pane docs)
- https://learn.chatgpt.com/docs/reference/settings (settings sections)
- https://learn.chatgpt.com/docs/cloud (Codex cloud/web task UI)
- https://learn.chatgpt.com/docs/codex/ide (IDE extension)
- https://unlock-ai.natebjones.com/guides/codex (home composer, 5-tab side panel, annotation system)
- https://getpushtoprod.substack.com/p/complete-beginners-guide-to-openais (layout, worktrees, review panel, plan mode)
- https://medium.com/@ariaxhan/i-tested-openais-new-codex-desktop-app-the-ui-is-the-real-product-c2c59bdcb5f6 (top-right control bar, automations UX)
- https://github.com/openai/codex/issues/19891 (activity-log collapse behavior)
- https://github.com/openai/codex/issues/14390, /issues/16765, /issues/19749 (update_plan checklist rendering)
- https://codex.danielvaughan.com/2026/03/30/codex-app-theming-customisation/ (codex-theme-v1, appearance panel)
- https://codex.danielvaughan.com/2026/04/08/four-surface-architecture/ and /2026/04/11/codex-app-worktree-lifecycle-local-environments/ (surfaces, worktrees, actions toolbar)
- https://www.linkedin.com/posts/yangshun_tech-stack-openai-used-to-build-codex-desktop-activity-7424676759347822593-UiFy (Electron/React/Radix/Shiki/cmdk/Framer Motion stack)
- https://open-design.ai/plugins/design-system-openai/ and https://fontsinuse.com/uses/52248/openai-website (typography: Söhne/OpenAI Sans UI, Signifier serif editorial-only)
- https://claude.com/blog/claude-code-desktop-redesign (Claude Code desktop secondary reference)
- https://www.eesel.ai/blog/openai-codex-integrations-with-vs-code (IDE approval modes)
