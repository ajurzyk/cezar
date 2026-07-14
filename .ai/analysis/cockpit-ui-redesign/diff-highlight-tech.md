# Tech research: syntax highlighting, diffs, and mobile-first chat patterns for a React + Vite + shadcn cockpit

Researched 2026-07-14. Target: a chat-centric "cockpit" UI (streaming agent output, code blocks, file diffs) built with React 18/19 + Vite + Tailwind + shadcn/ui, mobile-first (iPhone Safari is a first-class citizen).

---

## 1. Syntax highlighting: Shiki, done right

**Verdict: Shiki is the 2025/2026 default for read-only code rendering.** TextMate-grammar quality (identical to VS Code), themeable, and the whole ecosystem (Streamdown, AI Elements, @pierre/diffs, opencode's share pages) has standardized on it. Prism/highlight.js are legacy; CodeMirror is only for *editing* (see §2).

### 1.1 Bundle-size strategy (the thing most teams get wrong)

- The full `shiki` bundle is **~6.4 MB minified / ~1.2 MB gzip** with all langs + themes (as async chunks). Never ship the full bundle in a Vite SPA — even "lazy" dynamic imports of the main entry still land every grammar in your `dist/`.
- Use the **fine-grained core** instead:

```ts
import { createHighlighterCore } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'

const highlighter = await createHighlighterCore({
  themes: [
    import('@shikijs/themes/github-light-default'),
    import('@shikijs/themes/github-dark-default'),
  ],
  langs: [import('@shikijs/langs/typescript')], // seed set only
  engine: createJavaScriptRegexEngine({ forgiving: true }),
})
```

- **Use the JavaScript regex engine, not Oniguruma WASM.** `shiki/engine/javascript` avoids the ~600 KB Oniguruma WASM blob entirely, starts faster, and as of Shiki v1.16+ covers essentially all grammars (pass `forgiving: true` so an unsupported regex degrades to plaintext instead of throwing). This is the single biggest win for a Vite SPA.
- With JS engine + 2 themes + ~10 common grammars you land around **100–250 KB gzip total**, loaded lazily off the critical path.

### 1.2 Lazy language loading at runtime

- Keep a small seed set (ts/tsx, json, bash, python, md, css, html, diff) and load the rest on demand:

```ts
async function ensureLang(lang: string) {
  if (highlighter.getLoadedLanguages().includes(lang)) return lang
  try {
    await highlighter.loadLanguage(import(`@shikijs/langs/${lang}`)) // Vite glob-imports these as chunks
    return lang
  } catch { return 'plaintext' }
}
```

- Vite note: a fully dynamic `import(\`@shikijs/langs/${lang}\`)` makes Vite pre-split *every* grammar into its own chunk (fine — they're lazy) but bloats the manifest. If that bothers you, whitelist via `import.meta.glob('/node_modules/@shikijs/langs/{ts,tsx,python,...}.mjs')` or a switch map.
- **Always fall back to `plaintext` for unknown langs** — LLMs emit fence infos like ```jsonc, ```console, ```text, ```mermaid and unknown tags crash naive integrations (this is a real, filed bug class — e.g. vercel/streamdown#137).
- Create the highlighter **once** (module-level singleton or context); per-component `createHighlighter` calls leak memory and re-fetch grammars.

### 1.3 Dual light/dark themes

Shiki has first-class dual-theme output — don't run it twice:

```ts
codeToHtml(code, {
  lang, themes: { light: 'github-light-default', dark: 'github-dark-default' },
  defaultColor: 'light-dark()', // emits CSS light-dark() — no JS theme switching at all
})
```

- Option A (modern, recommended): `defaultColor: 'light-dark()'` — every token gets `color: light-dark(#x, #y)`. Requires `:root { color-scheme: light dark }` and Safari 17.5+/Chrome 123+ (fine for a 2026 product). Zero flash, zero JS.
- Option B (classic, works everywhere incl. shadcn's `.dark` class toggle): `defaultColor: false`, tokens get `--shiki-light`/`--shiki-dark` CSS variables, and you flip with:

```css
.shiki, .shiki span { color: var(--shiki-light); background-color: var(--shiki-light-bg); }
.dark .shiki, .dark .shiki span { color: var(--shiki-dark); background-color: var(--shiki-dark-bg); }
```

Since shadcn toggles a `.dark` class rather than relying purely on `prefers-color-scheme`, **Option B is the safer default for a shadcn app** (light-dark() follows `color-scheme`, which you *can* also toggle per-root, but the CSS-var route has no browser floor).

### 1.4 Streaming / partial highlighting (LLM output)

Three viable patterns, in order of preference for a chat cockpit:

1. **Block-memoized re-highlight (what Streamdown does).** Parse the streaming markdown into blocks (marked lexer), memoize completed blocks, and only re-highlight the *currently growing* code block on each chunk. Shiki's JS engine highlights a few-hundred-line block in single-digit ms, so re-running `codeToTokens` on the tail block per animation frame is fine in practice. Cheap, simple, and you get it for free by adopting Streamdown (§4).
2. **`shiki-stream` (antfu).** True token-stream highlighting: `CodeToTokenTransformStream` turns a text stream into a token stream with a "recall" mechanism (later context can retroactively invalidate the last N tokens). Ships a React `ShikiStreamRenderer`. Use if you pipe raw code streams (not markdown) and want minimal re-work per chunk.
3. **Deferred/progressive enhancement (what Pierre does):** render plaintext immediately, highlight async (optionally in a Web Worker), swap in. Best perceived performance for *huge* files; combine with pattern 1 for chat.

Also worth knowing: **`react-shiki`** (`npm i react-shiki`) — a solid hook/component wrapper with throttled streaming support, `react-shiki/core` entry for fine-grained bundles, and graceful unknown-language fallback. Good if you want Shiki in React without writing the plumbing; there's an open proposal to make Streamdown use it internally.

### 1.5 Performance hygiene

- `codeToTokens` → render your own React elements (or Pierre-style raw HTML strings) beats `codeToHtml` + `dangerouslySetInnerHTML` when you need line-level interactivity; use `codeToHtml` for plain display (fastest, fewest nodes).
- Cap highlighting: for code blocks > ~3–5k lines, highlight the visible window only or fall back to plaintext + virtualization.
- Offload to a Web Worker if you see main-thread jank (>8 ms highlights); Pierre and @git-diff-view both do worker highlighting. For chat-sized blocks it's usually unnecessary with the JS engine.

---

## 2. CodeMirror 6 (read-only) vs Shiki

| | Shiki | CodeMirror 6 read-only |
|---|---|---|
| Nature | Pure highlighter → static HTML | Full editor runtime (its own scroller, DOM lifecycle) |
| Grammar quality | TextMate = VS Code exact | Lezer grammars, good but fewer langs (~15 official) |
| Bundle | 100–250 KB gz (fine-grained) | ~120–300 KB gz core+langs, per-language packages |
| Long files | You add virtualization | **Built-in viewport virtualization** for free |
| Selection/copy | Native DOM text | Editor-managed |
| Mobile | Just text — perfect | Editor touch handling is a liability in read-only mode |
| Streaming | Cheap re-render / shiki-stream | Doc updates are cheap, but overkill |

**Verdict:** use **Shiki for all read-only rendering** (chat code blocks, file previews, diffs). Reach for **CodeMirror 6 only if the cockpit later needs in-place *editing*** (e.g. editing a file before sending back to an agent) — and even then, keep display-Shiki/edit-CM6 as two modes rather than CM6 everywhere; accept the slight theme mismatch or use a `codemirror-shiki` bridge (exists, niche, don't depend on it for v1). Do **not** adopt Monaco just to display code: ~5 MB, worker infrastructure, and officially poor/unsupported mobile touch behavior.

---

## 3. Diff rendering — pick a winner

### Contenders

1. **`@pierre/diffs`** (Pierre Computer Co., diffs.com) — **exists and is real**, npm `@pierre/diffs` (React entry: `@pierre/diffs/react`; an earlier alias `@pierre/precision-diffs` also exists on npm). Open-source, built *on Shiki*. Components: `FileDiff`, `PatchDiff`, `MultiFileDiff`, plus **`CodeView`, a virtualization-first component** for reviewing large code/diffs. Split ("split") and unified ("stacked") layouts via CSS Grid; Shadow-DOM-wrapped file containers with DOM pooling; Shiki in web workers with deferred highlighting; "Inverse Sticky" native-scroll virtualization; annotation framework (inline comments!), line selection, wrapping, line numbers; auto light/dark from Shiki themes. Their engineering write-up ("On Rendering Diffs", pierre.computer) shows serious perf work: height estimation (`lineHeight × lines`), binary-search line checkpoints, scroll anchoring, pooled containers. New (2026) but from a funded team (YC) whose whole product is code review; launched publicly Jan 2026.
2. **`@git-diff-view/react`** (MrWangJustToDo) — GitHub-style diff for React/Vue/Solid/Svelte. Split + unified, line wrap, widgets (inline comment slots), light/dark themes, SSR, highlighting via `@git-diff-view/lowlight` (default) **or `@git-diff-view/shiki`**, Web-Worker highlighting, "template mode" perf path. ~723★, active (v0.1.x, 38 releases). Weak spot: **no true virtualization** — big diffs rely on worker highlighting + collapsed hunks.
3. **`react-diff-view`** (otakustay) — the venerable git-diff component; clean core, tokenizer system for intra-line/word diff, split+unified. Mature but stagnant styling, you assemble a lot yourself (parse with `gitdiff-parser`, tokenize, style); no virtualization; theming is DIY.
4. **Custom Shiki diff (the opencode approach)** — opencode's web/share UI hand-rolls diff rendering over Shiki tokens (and its ecosystem plugins do the same). Full control, minimal deps; but you re-implement hunk parsing, intra-line diff (need `diff` / `diff-match-patch`), alignment, virtualization, a11y. Only worth it if the design is extremely bespoke.
5. **Monaco diff editor** — best-in-class algorithm/UX on desktop, but ~5 MB + workers, poor mobile touch support, fights Vite unless you use `@monaco-editor/react` + worker config. **Rejected** for a mobile-first cockpit.
6. Also-rans: `react-diff-viewer-continued` (simple, but times out at 50k–100k lines; virtualization recently bolted on), `react-virtualized-diff` (niche).

### Scorecard against your four requirements

| Requirement | @pierre/diffs | @git-diff-view/react | react-diff-view | custom Shiki | Monaco |
|---|---|---|---|---|---|
| Side-by-side + unified | ✅ split/stacked | ✅ | ✅ | build it | ✅ |
| Intra-line word diff | ✅ ("diff highlight styles, in-line highlighting") | ✅ | ✅ (token system) | build it | ✅ |
| Large-file virtualization | ✅ **CodeView, virtualization-first** | ❌ (worker-only mitigation) | ❌ | build it | ✅ |
| Mobile | ✅ stacked mode + wrap; CSS-grid layout adapts | ⚠️ OK unified+wrap, split cramped | ⚠️ DIY | you own it | ❌ |
| Shiki theme parity with chat code blocks | ✅ native | ✅ via @git-diff-view/shiki | ❌ (prism-ish DIY) | ✅ | ❌ |

### Winner: **`@pierre/diffs`**

It is the only option that natively hits all four axes *and* shares the Shiki theme pipeline with the rest of the cockpit (chat code blocks and diffs look identical). The annotation framework is a bonus if the cockpit ever grows review comments. Adopt with eyes open:

- **Gotchas:** young library (public since ~Jan 2026) — pin versions and wrap it behind your own `<Diff>` component so you can swap; Shadow DOM means Tailwind utilities don't pierce into diff internals — theme via its Shiki-theme + CSS-custom-property surface, not classNames; check SSR story if you ever leave pure-SPA Vite (it's client-oriented); verify its bundle chunking (it pulls Shiki — share your existing highlighter config/themes with it so you don't ship Shiki twice: it accepts Shiki theme objects).
- **Fallback plan:** `@git-diff-view/react` + `@git-diff-view/shiki` is the pragmatic runner-up — more conventional DOM (Tailwind-styleable), SSR, widgets for inline comments — accept no virtualization and gate files >~2–3k changed lines behind "load full diff" collapse (GitHub does the same).
- For **mobile**, default to **unified/stacked view with line-wrap on** below `md:` breakpoint; offer split view only ≥768 px. Both winners support wrap + unified.

---

## 4. Markdown rendering in streaming chat

**Verdict: Streamdown (`npm i streamdown`, Vercel).** It's a drop-in replacement for `react-markdown` purpose-built for LLM streams and is what AI Elements' `<Response>` uses under the hood.

Why it beats the alternatives for this exact use case:

- **Unterminated-block repair**: gracefully renders half-finished `**bold`, unclosed fences, half-typed links/tables while tokens stream — react-markdown flickers/breaks on these.
- **Block-level memoization** (marked-lexer splitting): only the growing tail block re-renders per chunk — the key to 60 fps long threads.
- **Shiki code blocks built in** (v2 `@streamdown/code` plugin): 200+ langs **lazy-loaded on demand**, dual light/dark themes, token caching, plaintext-first paint for visual stability. Aligns perfectly with §1. (Watch: unknown-language crash was a real issue — ensure current version + plaintext fallback config.)
- Security hardening (`harden-react-markdown`): safe link/image origin allow-listing — matters when rendering model output.
- v2.2+ adds animated per-word streaming and better custom-HTML handling; plugins (math/KaTeX, mermaid, cursor) are tree-shakeable opt-ins.
- Tailwind note: add streamdown to Tailwind `content`/`@source` so its classes survive purge: `@source "../node_modules/streamdown/dist/*.js";`

Alternatives: `react-markdown` — fine for *static* markdown, no streaming affordances, you hand-roll memoization + Shiki integration; `marked` raw — fast lexer but you'd rebuild sanitization + React reconciliation (dangerouslySetInnerHTML re-parses whole message per chunk = jank). **`marked` is only interesting as the internal block-splitter, which Streamdown already does.**

Gotcha for all of them: **don't re-render the whole thread per token.** Keep each message its own memoized component keyed by message id; stream only mutates the last message's text prop.

---

## 5. Virtualized message lists for streaming chat

**Verdict: `virtua`** (`npm i virtua`), with TanStack Virtual as the close alternative if you're already using TanStack.

- **virtua**: ~**3 kB gzip**, zero-config dynamic heights (ResizeObserver), **built-in reverse-scroll/chat support** — `shift` prepend for history pagination keeps scroll position stable, imperative `scrollToIndex`, smooth scroll. Explicitly documents/handles the nasty **iOS Safari reverse-scroll cases** (known partial limitation: prepend during touch is deferred until finger release — acceptable). Active (v0.49.x, 3.6k★). Components: `<VList>` (drop-in) or `<Virtualizer>` (custom scroller).
- **@tanstack/virtual**: headless, excellent, and as of late-2025/2026 releases has **first-class chat support**: `anchorTo: 'end'`, `followOnAppend`, `scrollEndThreshold`, keyed prepend stability, plus an official Chat guide + streaming example. More code to write (fully headless), historically the reverse-scroll DIY was painful — the new chat mode largely fixes that.
- Skip `react-virtuoso` unless you want its batteries (it's heavier, and its chat-specific `VirtuosoMessageList` moved to a **paid** license tier).

Streaming-specific integration notes (apply to either):

- **Bottom-anchoring**: pin-to-bottom while streaming *only if* user is within ~80 px of the bottom; a "Jump to latest ↓" pill otherwise. (TanStack's `followOnAppend`+`scrollEndThreshold` model this exactly; with virtua you implement the same with `onScroll` offset math — a few lines.)
- Streaming messages **grow**, so dynamic-size measurement is mandatory (both handle it); avoid CSS `overflow-anchor` hacks inside virtualizers.
- **Don't virtualize prematurely**: if threads are capped at a few hundred messages, memoized non-virtual rendering + `content-visibility: auto` on message rows may be all you need, and it avoids all iOS scroll-restoration edge cases. Virtualize when threads exceed ~300–500 nodes or contain many heavy code/diff blocks.
- Code blocks/diffs inside virtualized rows: heights change when Shiki hydrates → causes scroll jumps. Mitigate with plaintext-first render at *final* line-height (Pierre's trick: height = lineHeight × lines is exact before highlight).

---

## 6. Chat/AI component kits (shadcn-adjacent): adopt vs hand-roll

Landscape (all shadcn-registry style — code is copied into your repo, so no lock-in):

1. **Vercel AI Elements** (`npx ai-elements@latest`, elements.ai-sdk.dev) — official, built on shadcn/ui + your CSS variables. Components: `Conversation`, `Message`, `Response` (Streamdown), `PromptInput`, `Reasoning`, `Tool`, `CodeBlock`, `Sources`, `Suggestions`, `Actions`, plus newer voice/workflow pieces. Designed around AI SDK `useChat` message *parts* (text/tool/reasoning). **Best fit if the cockpit uses Vercel AI SDK or a parts-shaped message model.**
2. **assistant-ui** (assistant-ui.com, ~10k★, YC) — a full runtime + primitives (Radix-style) rather than copy-paste components: threads, branching, generative UI/tool UIs, human-in-the-loop, adapters for AI SDK/LangGraph/Mastra. Heavier abstraction; adopt only if you want its runtime to own chat state.
3. **shadcn/ui official chat components (June 2026 changelog)** — new first-party `Message`, `Bubble`, `Attachment`, `Marker` etc. in the shadcn registry, Radix+Base-UI compatible. Fresh, minimal, unopinionated about AI semantics.
4. **shadcn.io/ai** (50+ community AI components) — grab-bag quality; treat as copy-paste inspiration only.

**Verdict for a cockpit that talks to coding agents:** the cockpit's message model (tool calls, diffs, reasoning, files) is bespoke — **adopt AI Elements as scaffolding** (Conversation/Message/PromptInput/Reasoning/Tool/Response give you ~80% of chat chrome in your own repo, themed by your shadcn tokens), **replace** its `CodeBlock`/diff surfaces with your Shiki singleton + `@pierre/diffs`, and **skip assistant-ui** unless you want to outsource chat state management. Because AI Elements is registry-copied source, swapping internals is a local edit, not a fork. Hand-roll only the agent-specific parts (diff cards, run timelines, tool-status chips).

Gotchas: AI Elements assumes AI-SDK-shaped `UIMessage` parts — if your transport is custom (e.g., your own agent protocol), write a thin adapter to that shape rather than rewriting components; check that its bundled `Response` (Streamdown) version matches the standalone streamdown you configure; its `Conversation` uses `use-stick-to-bottom`, which conflicts with an outer virtualizer — pick one scroll owner (virtua) and strip the other.

---

## 7. iPhone Safari: making it actually good

### Viewport & keyboard (the big one)

- **`100dvh`, never `100vh`**: `height: 100dvh` (Tailwind `h-dvh`) tracks Safari's collapsing URL bar. Use `min-h-dvh` on the app shell; avoid `100vh` anywhere.
- **Virtual keyboard**: iOS Safari does *not* resize the layout viewport when the keyboard opens — `position: fixed; bottom: 0` inputs get covered. Fixes, layered:
  1. Meta: `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">` — `interactive-widget=resizes-content` makes the viewport shrink with the keyboard (Chrome 108+; iOS Safari support landed ~16+/26 era — treat as progressive enhancement, do not rely on it alone).
  2. **VisualViewport fallback (required for iOS)**: listen to `visualViewport.resize/scroll`, set `--kb: (window.innerHeight - vv.height - vv.offsetTop)px` on `:root`, and give the composer `padding-bottom: var(--kb)` (or translate the composer up). Debounce; Safari fires during the keyboard animation.
  3. Layout as `100dvh` grid: `grid-template-rows: auto 1fr auto` (header / scrollable thread / composer). Only the middle row scrolls (`overflow-y: auto; overscroll-behavior: contain`), body itself never scrolls — this kills Safari's rubber-band-the-whole-page and fixed-element drift.
  4. When the keyboard opens while pinned to bottom, re-run `scrollToEnd()` after the viewport settles (~250 ms) or on the first `visualViewport` resize event.
- **Safe areas** (`viewport-fit=cover` required): composer `padding-bottom: max(0.5rem, env(safe-area-inset-bottom))`; header `padding-top: env(safe-area-inset-top)`; horizontal insets for landscape notch. Tailwind: `pb-[max(0.5rem,env(safe-area-inset-bottom))]` or the tailwindcss-safe-area plugin.
- **Prevent input-focus zoom**: any input/textarea must be `font-size >= 16px`, or Safari auto-zooms the page. Do NOT use `user-scalable=no` (a11y).

### Scrolling & touch

- `overscroll-behavior: contain` on the thread scroller (stops pull-to-refresh/rubber-band leaking); `-webkit-overflow-scrolling: touch` is default-momentum now, no longer needed.
- **Touch targets ≥ 44×44 pt** (Apple HIG): message action buttons, code-block copy buttons, diff view toggles. With shadcn use `size="icon"` (40px) padded to 44px hit area via `after:absolute after:-inset-1` or min-h/w-11.
- Kill tap-highlight flash: `-webkit-tap-highlight-color: transparent;` and use `:active` states instead. Add `touch-action: manipulation` to buttons to remove the 350 ms double-tap delay heritage and accidental double-tap zoom.
- Horizontal scrolling code/diffs: give `pre`/diff containers `overflow-x: auto; touch-action: pan-x pan-y;` — never let a wide code block widen the page. On mobile prefer wrap-mode diffs (§3).
- Long-press: iOS text selection fights custom long-press menus in the thread; if you add long-press actions, set `-webkit-user-select: none` on chrome (not on code/message text — users must be able to copy!).
- 120 Hz ProMotion rewards transform/opacity-only animations; avoid animating heights of streaming bubbles (animate a max-height mask or nothing).
- Virtual list + iOS: virtua's documented caveat — prepends during an active touch are deferred until finger-up; design pagination spinners accordingly.

### PWA extras (if installed to home screen)

- `apple-mobile-web-app-status-bar-style`, standalone display mode changes safe-area behavior — retest keyboard math in standalone mode (`window.navigator.standalone`).

---

## 8. Recommended stack (summary table)

| Concern | Package(s) | Bundle note |
|---|---|---|
| Highlighting engine | `shiki` (fine-grained: `shiki/core` + `shiki/engine/javascript` + `@shikijs/langs/*` + `@shikijs/themes/*`) | ~100–250 KB gz lazy; no WASM |
| Streaming code highlight | via Streamdown's `@streamdown/code`; `shiki-stream` or `react-shiki` if outside markdown | tiny wrappers over the shared highlighter |
| Markdown in chat | `streamdown` (+ plugins as needed) | replaces react-markdown; Tailwind `@source` needed |
| Diff rendering | **`@pierre/diffs`** (`@pierre/diffs/react`: `FileDiff`/`PatchDiff`/`MultiFileDiff`/`CodeView`) | Shiki-based — share themes; virtualization built in (CodeView) |
| Diff fallback | `@git-diff-view/react` + `@git-diff-view/shiki` | no virtualization; SSR-friendly, Tailwind-styleable |
| Chat virtualization | `virtua` (`<VList>`/`<Virtualizer>`) | ~3 kB gz; built-in reverse scroll, iOS handling |
| Chat chrome | Vercel **AI Elements** registry components (Conversation, Message, PromptInput, Reasoning, Tool, Response) | copied into repo; themed by shadcn CSS vars |
| Editing (only if needed later) | CodeMirror 6 | keep out of v1 |
| Rejected | Monaco (5 MB, no mobile), react-diff-viewer-continued (perf), full `shiki` bundle, react-markdown for streaming | — |

### Integration gotchas checklist

1. **One Shiki highlighter singleton** shared by Streamdown code blocks and @pierre/diffs — otherwise you ship/instantiate Shiki twice.
2. `plaintext` fallback for every unknown fence language (LLMs invent them).
3. shadcn dark mode = `.dark` class → prefer Shiki CSS-variable dual themes over `light-dark()` unless you also toggle `color-scheme` on root.
4. One scroll owner: virtua's scroller *or* AI Elements' stick-to-bottom — not both.
5. Plaintext-first render at final line-height before highlight to avoid virtualized-row height jumps.
6. Mobile diffs: unified + wrap below `md:`; split view desktop-only.
7. `100dvh` grid shell + visualViewport keyboard var + safe-area padding + ≥16px inputs + 44pt touch targets = the entire iOS checklist in five CSS decisions.
8. Pin `@pierre/diffs` (young) and wrap it behind a local `<Diff>` facade for swapability.

### Sources

- Shiki bundles/perf/dual themes: https://shiki.style/guide/bundles, https://shiki.style/guide/best-performance, https://shiki.style/guide/dual-themes
- shiki-stream: https://github.com/antfu/shiki-stream ; react-shiki: https://github.com/avgvstvs96/react-shiki
- Pierre diffs: https://diffs.com , https://www.npmjs.com/package/@pierre/diffs , https://pierre.computer/writing/on-rendering-diffs , https://github.com/pierrecomputer/pierre/tree/main/packages/diffs
- git-diff-view: https://github.com/MrWangJustToDo/git-diff-view ; react-diff-view: https://github.com/otakustay/react-diff-view
- Streamdown: https://github.com/vercel/streamdown , https://streamdown.ai/docs/code-blocks , https://vercel.com/changelog/streamdown-2-2 , https://github.com/vercel/streamdown/issues/137
- virtua: https://github.com/inokawa/virtua ; TanStack Virtual chat: https://tanstack.com/virtual/latest/docs/chat , https://tanstack.com/blog/tanstack-virtual-chat
- AI Elements: https://elements.ai-sdk.dev , https://github.com/vercel/ai-elements , https://vercel.com/changelog/introducing-ai-elements ; assistant-ui: https://www.assistant-ui.com ; shadcn chat components: https://ui.shadcn.com/docs/changelog/2026-06-chat-components ; shadcn.io/ai: https://www.shadcn.io/ai
- iOS keyboard/viewport: https://www.bram.us/2021/09/13/prevent-items-from-being-hidden-underneath-the-virtual-keyboard-by-means-of-the-virtualkeyboard-api/ , https://github.com/bramus/viewport-resize-behavior/blob/main/explainer.md , https://www.franciscomoretti.com/blog/fix-mobile-keyboard-overlap-with-visualviewport
