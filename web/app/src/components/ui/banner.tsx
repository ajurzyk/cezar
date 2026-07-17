import { XIcon } from 'lucide-react'
import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'

/**
 * A reusable, dismissible chrome banner — the cockpit's first (#391 is its first caller).
 * Presentational only: it renders whatever `children` says and calls `onDismiss` on click;
 * whether the dismissal persists (and how) is entirely the caller's job — see
 * `skills-banner.tsx` for the ui-state-backed "shown once" pattern.
 */
export interface BannerProps {
  /** The message. Plain text or a small mix of inline elements (a link, a `<code>` snippet). */
  children: ReactNode
  /** Fires on the close button. The caller decides what "dismissed" means and where it lives. */
  onDismiss: () => void
  /** Accessible name for the close button — say what is being dismissed, not just "Dismiss". */
  dismissLabel: string
  className?: string
}

export function Banner({ children, onDismiss, dismissLabel, className }: BannerProps) {
  return (
    <div
      role="note"
      data-slot="banner"
      className={cn(
        'flex items-start gap-3 border-b border-border bg-muted px-4 py-2.5 text-[13px] leading-snug text-foreground',
        className,
      )}
    >
      <div className="min-w-0 flex-1">{children}</div>
      <button
        type="button"
        data-slot="banner-dismiss"
        aria-label={dismissLabel}
        onClick={onDismiss}
        className="-m-1 shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-card hover:text-foreground"
      >
        <XIcon className="size-3.5" aria-hidden="true" />
      </button>
    </div>
  )
}
