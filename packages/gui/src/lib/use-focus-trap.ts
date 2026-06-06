'use client';

import { useEffect, type RefObject } from 'react';

interface FocusTrapOptions {
  /** Called when Escape is pressed while the trap is active. */
  onEscape?: () => void;
}

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * Trap Tab focus within `containerRef` while `active`, fire `onEscape` on
 * Escape, and restore focus to the previously-focused element when the trap
 * deactivates (spec §3.6).
 *
 * SSR-guarded: no-ops when `document` is unavailable.
 */
export function useFocusTrap(
  active: boolean,
  containerRef: RefObject<HTMLElement | null>,
  { onEscape }: FocusTrapOptions = {},
): void {
  useEffect(() => {
    if (!active) return;
    if (typeof document === 'undefined') return;

    const container: HTMLElement | null = containerRef.current;
    if (!container) return;
    const el = container;

    // Remember the trigger so we can hand focus back on close.
    const previouslyFocused = document.activeElement as HTMLElement | null;

    const getFocusable = (): HTMLElement[] =>
      Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (node) => node.offsetParent !== null || node === document.activeElement,
      );

    // Move focus into the overlay on open (first focusable, else the container).
    const initial = getFocusable();
    if (initial.length > 0) {
      initial[0].focus();
    } else if (el.tabIndex >= 0) {
      el.focus();
    }

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        onEscape?.();
        return;
      }
      if (e.key !== 'Tab') return;

      const focusable = getFocusable();
      if (focusable.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const activeEl = document.activeElement as HTMLElement | null;
      const inside = activeEl != null && el.contains(activeEl);

      if (e.shiftKey) {
        if (activeEl === first || !inside) {
          e.preventDefault();
          last.focus();
        }
      } else if (activeEl === last || !inside) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      // Restore focus to the trigger if it's still in the DOM.
      if (previouslyFocused && document.contains(previouslyFocused)) {
        previouslyFocused.focus();
      }
    };
  }, [active, containerRef, onEscape]);
}
