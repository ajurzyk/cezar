'use client';

import { useEffect } from 'react';

/**
 * Lock background scroll while an overlay (drawer / sheet / modal) is open and
 * restore it on close (spec §3.6).
 *
 * Uses the iOS-safe `position: fixed` body technique rather than plain
 * `overflow: hidden` — on iOS Safari `overflow: hidden` does NOT stop the
 * rubber-band scroll of the page behind a fixed overlay. We pin the body at the
 * negative of the current scroll offset, then restore the offset on cleanup.
 *
 * SSR-guarded: no-ops when `document` is unavailable.
 */
export function useScrollLock(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    if (typeof document === 'undefined') return;

    const { body } = document;
    const scrollY = window.scrollY;

    // Snapshot the styles we touch so we restore exactly, not to "".
    const prev = {
      position: body.style.position,
      top: body.style.top,
      left: body.style.left,
      right: body.style.right,
      width: body.style.width,
      overflow: body.style.overflow,
    };

    body.style.position = 'fixed';
    body.style.top = `-${scrollY}px`;
    body.style.left = '0';
    body.style.right = '0';
    body.style.width = '100%';
    body.style.overflow = 'hidden';

    return () => {
      body.style.position = prev.position;
      body.style.top = prev.top;
      body.style.left = prev.left;
      body.style.right = prev.right;
      body.style.width = prev.width;
      body.style.overflow = prev.overflow;
      // Restore the scroll position the body pin discarded.
      window.scrollTo(0, scrollY);
    };
  }, [active]);
}
