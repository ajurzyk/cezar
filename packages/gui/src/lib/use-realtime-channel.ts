'use client';

import { useEffect, useRef } from 'react';
import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';
import { createSupabaseBrowserClient } from '@/lib/supabase/browser';
import type { Database } from '@/lib/supabase/types';

type BrowserClient = SupabaseClient<Database>;

export interface UseRealtimeChannelOptions {
  /**
   * Unique channel name (e.g. `cockpit-runs-${workspaceId}` or the runId). When
   * this changes the channel is torn down and re-created.
   */
  channelName: string;
  /**
   * Attach `.on(...)` handlers to the freshly-created channel. Return nothing.
   * Called once per (re)subscribe. Matches the existing pattern in
   * cockpit-list.tsx / run-drawer.tsx — you receive the raw channel and the
   * client and wire it up exactly as before.
   */
  setup: (channel: RealtimeChannel, supabase: BrowserClient) => void;
  /**
   * Invoked after the channel is re-subscribed on `visibilitychange → visible`
   * or `window online` — i.e. the socket may have dropped while backgrounded /
   * offline. Refetch the current view here so the UI isn't stale (spec §3.7).
   */
  onResync?: () => void;
  /** When false, no channel is created (e.g. gated behind a flag). Default true. */
  enabled?: boolean;
}

/**
 * Mobile-hardened Supabase Realtime subscription wrapper (spec §3.7).
 *
 *  - Creates the channel, runs `setup`, subscribes.
 *  - On `visibilitychange → visible` and `window online`, tears the channel down
 *    and re-subscribes (mobile drops the socket on backgrounding / Wi-Fi↔cellular
 *    handoff), then fires `onResync` so the caller can refetch.
 *  - Tears the channel down on unmount (don't hold subscriptions alive in the
 *    background / on other screens — cellular cost, §3.7).
 *
 * Keep the API minimal: screens own their handlers + state; this only manages
 * the channel lifecycle. Adoption in cockpit-list / run-drawer lands in later
 * phases.
 */
export function useRealtimeChannel({
  channelName,
  setup,
  onResync,
  enabled = true,
}: UseRealtimeChannelOptions): void {
  // Hold the latest callbacks in refs so reconnect handlers don't need them in
  // the effect deps (which would re-subscribe on every render).
  const setupRef = useRef(setup);
  const resyncRef = useRef(onResync);
  setupRef.current = setup;
  resyncRef.current = onResync;

  useEffect(() => {
    if (!enabled) return;
    const supabase = createSupabaseBrowserClient();
    let channel: RealtimeChannel | null = null;

    const subscribe = () => {
      channel = supabase.channel(channelName);
      setupRef.current(channel, supabase);
      channel.subscribe();
    };

    const teardown = () => {
      if (channel) {
        void supabase.removeChannel(channel);
        channel = null;
      }
    };

    const resubscribe = () => {
      teardown();
      subscribe();
      resyncRef.current?.();
    };

    subscribe();

    const onVisible = () => {
      if (document.visibilityState === 'visible') resubscribe();
    };

    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', resubscribe);

    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', resubscribe);
      teardown();
    };
  }, [channelName, enabled]);
}
