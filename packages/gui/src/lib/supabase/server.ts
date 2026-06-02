import { createServerClient } from '@supabase/ssr';
import { createClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import { supabaseEnv } from './env';
import type { Database } from './types';

/**
 * Per-request client scoped to the signed-in user's session. RLS policies
 * apply to every query — this is the right client for most reads.
 *
 * Always built against the *public* Supabase URL, not SUPABASE_INTERNAL_URL.
 * `@supabase/ssr` derives the session cookie name from the URL host
 * (`sb-<host>-auth-token`), so if the browser client (always public) and
 * the server client (internal) disagreed, every cookie read would miss and
 * OAuth code exchange would fail with `auth_failed`. The internal-URL
 * shortcut is preserved for the admin client below, which doesn't use
 * cookies.
 */
export async function createSupabaseServerClient() {
  const cookieStore = await cookies();
  return createServerClient<Database>(supabaseEnv.url(), supabaseEnv.anonKey(), {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (entries) => {
        try {
          for (const { name, value, options } of entries) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Middleware handles cookie writes in Server Components.
        }
      },
    },
  });
}

/**
 * Privileged client that bypasses RLS. Only use inside server-only code paths
 * that have already authorized the caller (e.g. webhook handlers, admin
 * maintenance). Never expose to components rendered client-side.
 *
 * Uses SUPABASE_INTERNAL_URL so webhook + cron paths shortcut Kong over the
 * Docker network instead of bouncing through Traefik.
 */
export function createSupabaseAdminClient() {
  return createClient<Database>(supabaseEnv.internalUrl(), supabaseEnv.serviceRoleKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
