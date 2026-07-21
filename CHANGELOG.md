# 0.9.0 (2026-07-21)

## Highlights
<!-- TODO: Highlights — auto-update-changelog leaves this blank for the human author to fill in. -->

## ✨ Features
- ✨ Edit the coding agents' own config files (global vs local, raw + highlighted). (#418) *(@pkarw)*
- ✨ Canonical provider/model identity shared across runners (fixes #405). (#466) *(@pat-lewczuk)*
- ✨ Runner + model selection for the Continue flow (fixes #401). (#468) *(@pat-lewczuk)*
- ✨ AskUser structured questions across claude, codex & opencode (fixes #473). (#502) *(@pkarw)*
- ✨ Multi-project workspace — per-user registry, project-scoped cockpit, config migrations (fixes #520). (#521) *(@pkarw)*
- ✨ Discover PR/issue refs from skill report lines and GitHub links. (#534) *(@pkarw)*
- ✨ Grouped sub-agent display — Agents dock + drill-down sheet (fixes #474). (#550) *(@pkarw)*
- ✨ Render full timeline (commits, labels, merges) with per-commit CI markers (fixes #525). (#552) *(@pkarw)*
- ✨ Stack, edit and remove prompt messages on a queued run (fixes #472). (#553) *(@pkarw)*
- ✨ Link clone root to project settings (fixes #561). (#571) *(@pkarw)*
- ✨ Separate browse and checkout roots. (#572) *(@pkarw)*

## 🔒 Security
- 🔒 Guard the localhost API against CSRF and DNS rebinding (fixes #426). (#467) *(@pat-lewczuk)*

## 🐛 Fixes
- 📦 Never push a release commit to protected main. (#514) *(@pat-lewczuk)*
- 🔄 Stop GitHub nav item flickering — stale-while-revalidate forge probe. (#516) *(@pat-lewczuk)*
- 🔄 Resolve a stale local base ref to `origin/<base>` to stop phantom diffs. (#518) *(@pat-lewczuk)*
- 🐛 Skill pickers order most-used → project → global (fixes #519). (#523) *(@pkarw)*
- 🐛 Label Skill and Agent tool rows in the Session tab (fixes #529). (#532) *(@pkarw)*
- 🐛 Name the autosave trigger in the commit subject + refuse conflicted trees (#471). (#533) *(@pkarw)*
- 🐛 Keep reasoning text alive across replay and drop empty "Thinking" rows (fixes #528). (#536) *(@pkarw)*
- 🐛 A custom hand-off prompt extends the item context instead of replacing it (fixes #524). (#541) *(@pkarw)*
- 🐛 Preserve thinking across resumed steps (fixes #556). (#564) *(@pkarw)*
- 🐛 Isolate cross-backend continuation sessions (fixes #562). (#566) *(@pkarw)*
- 🔐 Default to full permissions (fixes #563). (#568) *(@pkarw)*
- 🔄 Refresh checkout root after save (fixes #567). (#569) *(@pkarw)*
- 🐛 Make picker tiers deterministic (fixes #555). (#570) *(@pkarw)*
- 🐛 Render reasoning snapshot arrays. (#573) *(@pkarw)*
- 🐛 Show queued task references immediately (fixes #554). (#578) *(@pkarw)*
- 🐛 Bridge subagents and native questions (fixes #565). (#579) *(@pkarw)*
- 🐛 Scope subtasks by session id (fixes #551). (#587) *(@pkarw)*

## 📝 Specs & Documentation
- 📝 Multi-project workspace — per-user `~/.cezar` registry, project-scoped cockpit, config migrations. (#517) *(@pkarw)*
- 📝 Grouped sub-agent display within a single session. (#522) *(@pkarw)*
- 📝 GitHub tab timeline events (commits, labels, merges) + per-commit CI markers. (#527) *(@pkarw)*
- 📝 Worktree file editing from the Files tab (#530). (#531) *(@pkarw)*
- 📝 Stack, edit and remove prompt messages on a queued run. (#537) *(@pkarw)*
- 📝 Correct the linting constraint — oxlint, not typescript-eslint. (#560) *(@patzick)*
- 📝 Discover latest Codex models. (#585) *(@pkarw)*

## 🚀 CI/CD & Infrastructure
- 🚀 Migrate to TypeScript 7 (native compiler). (#559) *(@patzick)*

## 👥 Contributors

- @pkarw
- @pat-lewczuk
- @patzick
