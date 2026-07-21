import { useEffect } from 'react'

export interface DocumentTitleParts {
  projectName: string | null
  pageLabel: string | null
}

const present = (value: string | null): string | null => value?.trim() || null

/** Pure browser-title grammar: context first, stable product name last. */
export function documentTitleOf({ projectName, pageLabel }: DocumentTitleParts): string {
  const project = present(projectName)
  const page = present(pageLabel)

  if (project && page) return `${project} — ${page} · cezar`
  if (project) return `${project} · cezar`
  if (page) return `${page} · cezar`
  return 'cezar'
}

/** The cockpit's single hydrated `document.title` writer. */
export function useDocumentTitle(parts: DocumentTitleParts): void {
  const title = documentTitleOf(parts)

  useEffect(() => {
    document.title = title
  }, [title])
}
