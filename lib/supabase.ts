import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { requireEnv } from '@/lib/env';

let cachedClient: SupabaseClient | null = null;
let cachedUrl: string | null = null;
let cachedKey: string | null = null;

export function getSupabaseUrl(): string {
  return requireEnv('SUPABASE_URL');
}

export function getSupabaseServiceRoleKey(): string {
  return requireEnv('SUPABASE_SERVICE_ROLE_KEY');
}

export function getSupabaseClient(): SupabaseClient {
  const url = getSupabaseUrl();
  const key = getSupabaseServiceRoleKey();

  if (!cachedClient || cachedUrl !== url || cachedKey !== key) {
    cachedClient = createClient(url, key, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
      global: {
        fetch: (fetchUrl, options = {}) =>
          fetch(fetchUrl, {
            ...options,
            cache: 'no-store',
          }),
      },
    });
    cachedUrl = url;
    cachedKey = key;
  }

  return cachedClient;
}

/**
 * Proxy client that validates SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
 * on every runtime read without any hardcoded fallback URL or key.
 */
export const supabase: SupabaseClient = new Proxy({} as SupabaseClient, {
  get(_target, prop, _receiver) {
    const client = getSupabaseClient();
    const value = (client as any)[prop];
    return typeof value === 'function' ? value.bind(client) : value;
  },
});
