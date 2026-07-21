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

interface MdastNode {
  type: string
  value?: string
  children?: MdastNode[]
}

/**
 * Turn every newline inside a text node into a hard `break` — CommonMark's "a single newline is
 * just a space" rule, disabled.
 *
 * Needed only for text a HUMAN typed (#524). An LLM writes real markdown and means the CommonMark
 * reading; a person hitting Enter in a textarea means a line break, and collapsing those would
 * reflow their message into one paragraph. `remark-breaks` does exactly this, but it is not a
 * dependency here and `unist-util-visit` is only a transitive one — an mdast tree is plain
 * objects, so the walk is cheaper to inline than either import is to take on.
 *
 * Only `text` nodes are split, which is what keeps it safe: `code` and `inlineCode` carry their
 * content in `value` with no children, so fences and spans are never touched.
 */
function remarkHardBreaks() {
  const walk = (node: MdastNode): void => {
    if (!node.children) return
    const out: MdastNode[] = []
    for (const child of node.children) {
      if (child.type === 'text' && child.value?.includes('\n')) {
        child.value.split(/\r?\n/).forEach((part, index) => {
          if (index > 0) out.push({ type: 'break' })
          if (part) out.push({ type: 'text', value: part })
        })
      } else {
        walk(child)
        out.push(child)
      }
    }
    node.children = out
  }
  return walk
}

const HARD_BREAKS = [remarkHardBreaks]

/**
 * Memoized per message (Streamdown additionally memoizes per block): during streaming only the
 * message whose `children` string actually grew re-renders — the research doc's one hard rule
 * for markdown in chat threads.
 *
 * `breaks` opts into hard line breaks — set it for user-authored text, leave it off for the
 * assistant's (see `remarkHardBreaks`).
 */
export const Markdown = memo(function Markdown({
  children,
  breaks = false,
}: {
  children: string
  breaks?: boolean
}) {
  return (
    <Streamdown
      className="thread-markdown"
      plugins={{ code: shikiPlugin }}
      shikiTheme={[SYN_THEME, SYN_THEME]}
      remarkPlugins={breaks ? HARD_BREAKS : undefined}
      // Copy + language chip on every fence (the deliverable); download is file-manager noise
      // in a chat, and table export dropdowns are R5-territory chrome.
      controls={{ code: { copy: true, download: false }, table: false, mermaid: false }}
      lineNumbers={false}
    >
      {children}
    </Streamdown>
  )
})
