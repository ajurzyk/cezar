'use client';

import { createContext, useContext } from 'react';

export type ToastTone = 'default' | 'success' | 'error';

export interface ToastOptions {
  tone?: ToastTone;
  /** Auto-dismiss delay in ms. Default 4000. */
  durationMs?: number;
}

export interface ToastRecord {
  id: number;
  message: string;
  tone: ToastTone;
  durationMs: number;
}

export interface ToastContextValue {
  toast: (message: string, opts?: ToastOptions) => number;
  dismiss: (id: number) => void;
}

export const ToastContext = createContext<ToastContextValue | null>(null);

/**
 * Single toast system (spec §3.6 / P10). `useToast().toast(message, opts?)`
 * enqueues a transient toast; the `<Toaster/>` container (mounted once in the
 * app shell) renders them safe-area-aware above the BottomTabBar on phone and
 * bottom-right on desktop.
 *
 * No-ops gracefully (returns -1) if called outside a `<Toaster/>` provider, so
 * a screen can call it before the provider is wired without crashing.
 */
export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (ctx) return ctx;
  return {
    toast: () => -1,
    dismiss: () => undefined,
  };
}
