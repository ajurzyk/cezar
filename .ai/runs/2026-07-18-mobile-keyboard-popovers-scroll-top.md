# Mobile fixes: keyboard-safe skill menus + scroll-to-top on navigation

- **Date:** 2026-07-18
- **Branch:** `fix/mobile-keyboard-popovers-scroll-top`
- **Base:** `main`
- **Source:** user brief with mobile screenshot (iOS Safari, /new composer)

## Goal

On mobile, the `/` skills autocomplete and the skills/workflow selector must stay visible
while the virtual keyboard is open, and navigating to list pages (Tasks, GitHub, …) must
always land at the top of the list.

## Scope

- `web/app/src/lib/keyboard-inset.ts` — add visual-viewport inset math (top + bottom) and a
  React hook exposing it as state.
- `web/app/src/components/composer/composer.tsx` — keyboard-aware collision padding + a
  visible-height clamp for the `/` skills & `@` mention menu.
- `web/app/src/routes/new-task.tsx` — same treatment for the `SourcePill` skills/workflow
  picker (its `CommandInput` opens the keyboard itself).
- `web/app/src/components/app-shell.tsx` — reset the shared `main` scroller to the top on
  every pathname change.
- Unit tests beside each change.

### Non-goals

- No redesign of the popovers into bottom sheets; the Radix popover surfaces stay.
- No changes to the `PickerPill` dropdowns (model/variants/base) — they open no keyboard.
- No changes to the thread's stick-to-bottom machinery (`thread-scroller.tsx`); the thread
  route keeps owning its arrival scroll, which runs after the shell's reset.
- No server-side changes.

## Background

The cockpit's popover menus are portaled Radix popovers positioned against the **layout**
viewport. iOS Safari does not shrink the layout viewport when the keyboard opens — it pans
the **visual** viewport instead — so a menu can be laid out under the keyboard or above the
panned-away top edge. The repo's existing answer is the `--kb` visualViewport watcher
(`keyboard-inset.ts`, used by the thread's composer dock). This run extends that pattern:
publish the visual viewport's top/bottom overlap as React state and feed it to Radix as
`collisionPadding`, so collision avoidance works against the *visible* viewport.

The second bug: the app shell has one persistent scrolling region (`[data-slot="main"]`);
no route resets it on navigation, so a deep scroll on one page carries into the next.

## Implementation plan

### Phase 1: visual-viewport insets utility

- 1.1 Add `viewportInsets(win): { top, bottom }` to `keyboard-inset.ts` (top = the visual
  viewport's `offsetTop`, bottom = the existing `keyboardInset` math), plus a
  `useViewportInsets()` hook that subscribes via `watchKeyboardInset`-style listeners and
  returns the insets as state (0/0 when `visualViewport` is absent — jsdom, desktop).
  Unit tests in `keyboard-inset.test.ts`.

### Phase 2: keyboard-safe menus

- 2.1 Composer: pass `collisionPadding` derived from `useViewportInsets()` to the
  autocomplete `PopoverContent`, and clamp the menu list height to the popper's
  `--radix-popover-content-available-height` so it shrinks instead of sliding under the
  keyboard. Test in `composer.test.tsx`.
- 2.2 `SourcePill` (new-task): same `collisionPadding` + available-height clamp for the
  skills/workflow picker popover. Test in `new-task.test.tsx`.

### Phase 3: scroll-to-top on navigation

- 3.1 App shell: `useLayoutEffect` on `pathname` scrolls `[data-slot="main"]` to the top,
  so every route change (Tasks, GitHub tabs, Skills, …) starts at the top. The task-thread
  route re-positions itself afterwards (its arrival effect runs on a later commit, after
  its content ref lands), so thread scroll restore keeps working. Test in
  `app-shell.test.tsx`.

### Phase 4: validation + PR

- 4.1 Full validation gate (`npm run typecheck`, `npm test`, `npm run test:unit`,
  `npm run build`, `npm run test:package`), self-review, open the draft PR with labels.
- 4.2 QA the change through `om-auto-verify-pr-ui` (mobile viewport: skills selector,
  `/` autocomplete with keyboard emulation, list-page scroll reset) and post evidence;
  then `om-auto-review-pr` autofix loop until clean.

## Risks

- iOS keyboard behavior cannot be reproduced exactly in desktop Chrome QA; the insets math
  is unit-tested against stubbed `visualViewport` values instead, and QA verifies the
  popovers reposition and clamp on a small mobile viewport.
- Scroll-to-top runs for every route: the thread route's own arrival scroll must win on
  revisits — covered by the effect-ordering note in 3.1 and existing thread tests.

## Progress

PR: #504

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: visual-viewport insets utility

- [x] 1.1 viewportInsets + useViewportInsets hook with tests — bde09e9

### Phase 2: keyboard-safe menus

- [x] 2.1 Composer autocomplete collision padding + height clamp — 17537ad
- [x] 2.2 SourcePill skills picker collision padding + height clamp — 17537ad

### Phase 3: scroll-to-top on navigation

- [x] 3.1 App shell scrolls main to top on pathname change — 933272d

### Phase 4: validation + PR

- [x] 4.1 Full validation gate, self-review, draft PR + labels — PR #504
- [x] 4.2 om-auto-verify-pr-ui QA (PASS 8/8, evidence on PR) + om-auto-review-pr (APPROVED, 0 autofix iterations)
