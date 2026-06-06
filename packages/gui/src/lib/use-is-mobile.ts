'use client';

import { useEffect, useState } from 'react';

// Below Tailwind's `lg` (1024px) we treat the viewport as mobile/tablet and
// prefer sheets over anchored popovers. Width — not pointer type — is the right
// signal: touch-capable laptops and DevTools touch-emulation report a coarse
// pointer at desktop widths, where a bottom sheet is the wrong affordance.
const MOBILE_QUERY = '(max-width: 1023.98px)';

/**
 * `true` when the viewport is narrower than the `lg` breakpoint. SSR-safe
 * (defaults to `false` → desktop), then corrects on mount.
 */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_QUERY);
    const update = () => setIsMobile(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);
  return isMobile;
}
