import { memo } from 'react'
import { Streamdown, type CodeHighlighterPlugin } from 'streamdown'

import { SYN_THEME, highlight, highlightSync, supportedLanguages } from '@/lib/highlighter'

/**
 * Assistant markdown for the thread — Streamdown (spec tech pick: stable-block memoization,
 * unterminated-block repair while streaming) with code fences highlighted by the ONE Shiki
 * singleton in `lib/highlighter.ts`.
 *
 * The seam is Streamdown's `CodeHighlighterPlugin`: without a plugin its code blocks render
 * plaintext, so the singleton is the only Shiki in the app — Streamdown 2.x core carries no
 * highlighter of its own (`@streamdown/code` is deliberately NOT installed; it would ship a
 * second Shiki). The plugin protocol is sync-when-resident / callback-when-loading, which maps
 * exactly onto `highlightSync`/`highlight`.
 *
 * Both theme slots get the one CSS-variable theme: light/dark is the `--syn-*` variables
 * flipping with the `.light` class, not two token sets.
 */
const shikiPlugin: CodeHighlighterPlugin = {
  name: 'shiki',
  type: 'code-highlighter',
  getThemes: () => [SYN_THEME, SYN_THEME],
  // The truthful list — Streamdown falls back to its plaintext body for anything else, which
  // is the required behavior for the fence infos LLMs invent (```wat, ```output, …).
  getSupportedLanguages: () => supportedLanguages() as never[],
  supportsLanguage: (language) => supportedLanguages().includes(String(language).toLowerCase()),
  highlight: ({ code, language }, callback) => {
    const resident = highlightSync(code, String(language))
    if (resident) return resident
    void highlight(code, String(language)).then((result) => callback?.(result))
    return null
  },
}

/**
 * Memoized per message (Streamdown additionally memoizes per block): during streaming only the
 * message whose `children` string actually grew re-renders — the research doc's one hard rule
 * for markdown in chat threads.
 */
export const Markdown = memo(function Markdown({ children }: { children: string }) {
  return (
    <Streamdown
      className="thread-markdown"
      plugins={{ code: shikiPlugin }}
      shikiTheme={[SYN_THEME, SYN_THEME]}
      // Copy + language chip on every fence (the deliverable); download is file-manager noise
      // in a chat, and table export dropdowns are R5-territory chrome.
      controls={{ code: { copy: true, download: false }, table: false, mermaid: false }}
      lineNumbers={false}
    >
      {children}
    </Streamdown>
  )
})
