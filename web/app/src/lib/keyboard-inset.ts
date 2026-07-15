import { useEffect, useRef } from 'react'

/**
 * The iOS virtual-keyboard adapter (spec iOS checklist; tech research §7): Safari does NOT
 * resize the layout viewport when the keyboard opens, so a bottom-docked composer gets
 * covered. The fix is the `--kb` custom-property pattern — watch `visualViewport`, publish
 * the keyboard's overlap height as `--kb` on `:root`, and let the dock lift itself with
 * `bottom: var(--kb, 0px)`. `interactive-widget=resizes-content` in the viewport meta is the
 * progressive-enhancement layer above this; on engines that honor it the inset stays 0 and
 * this adapter is a no-op.
 *
 * Everything is written against structural stubs (`KeyboardWindow`), so tests drive keyboard
 * open/close without a real Safari.
 */

/** The subset of `VisualViewport` the math needs — stubbable. */
export interface KeyboardViewport {
  height: number
  offsetTop: number
  addEventListener(type: 'resize' | 'scroll', listener: () => void): void
  removeEventListener(type: 'resize' | 'scroll', listener: () => void): void
}

/** The subset of `window` the adapter reads. `visualViewport` is nullable per spec. */
export interface KeyboardWindow {
  innerHeight: number
  visualViewport: KeyboardViewport | null
}

/**
 * How many px of layout viewport the keyboard covers right now. The layout viewport keeps
 * `innerHeight`; the visual viewport shrinks to `height` and may pan down by `offsetTop` —
 * whatever remains below it is keyboard. Clamped at 0: URL-bar collapse can make the visual
 * viewport momentarily TALLER than `innerHeight`, which is not a keyboard.
 */
export function keyboardInset(win: KeyboardWindow): number {
  const viewport = win.visualViewport
  if (!viewport) return 0
  return Math.max(0, Math.round(win.innerHeight - viewport.height - viewport.offsetTop))
}

/**
 * Watch the visual viewport and publish the inset. `apply` fires on every viewport event
 * (Safari streams them through the keyboard animation — the composer tracks it); `onSettle`
 * fires once, `settleMs` after the events stop — the re-stick-to-bottom moment (research:
 * "re-run scrollToEnd() after the viewport settles"). Returns the cleanup; it resets the
 * inset to 0 so a stale `--kb` never outlives the watcher.
 */
export function watchKeyboardInset(
  win: KeyboardWindow,
  apply: (px: number) => void,
  onSettle?: (px: number) => void,
  settleMs = 250,
): () => void {
  const viewport = win.visualViewport
  if (!viewport) {
    apply(0)
    return () => {}
  }
  let settleTimer: ReturnType<typeof setTimeout> | undefined
  const onChange = () => {
    const inset = keyboardInset(win)
    apply(inset)
    if (onSettle) {
      clearTimeout(settleTimer)
      settleTimer = setTimeout(() => onSettle(inset), settleMs)
    }
  }
  apply(keyboardInset(win))
  viewport.addEventListener('resize', onChange)
  viewport.addEventListener('scroll', onChange)
  return () => {
    clearTimeout(settleTimer)
    viewport.removeEventListener('resize', onChange)
    viewport.removeEventListener('scroll', onChange)
    apply(0)
  }
}

/**
 * The React binding: keeps `--kb` on `:root` while mounted. `onSettle` is read through a ref,
 * so callers can hand a fresh closure every render without re-subscribing to the viewport.
 */
export function useKeyboardInsetVar(onSettle?: (px: number) => void): void {
  const onSettleRef = useRef(onSettle)
  onSettleRef.current = onSettle
  useEffect(() => {
    const root = document.documentElement
    return watchKeyboardInset(
      window as unknown as KeyboardWindow,
      (px) => root.style.setProperty('--kb', `${px}px`),
      (px) => onSettleRef.current?.(px),
    )
  }, [])
}
