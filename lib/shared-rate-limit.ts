import crypto from 'crypto';
import { supabase } from '@/lib/supabase';

export interface SharedRateLimitResult {
  allowed: boolean;
  currentCount: number;
  limit: number;
  remaining: number;
  resetSeconds: number;
  isShared: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEGMENT_RE = /^[a-z_]+$/;

/** Buckets older than this are deleted by the cron and by opportunistic cleanup. */
export const RATE_LIMIT_BUCKET_RETENTION_MS = 24 * 60 * 60 * 1000;
const OPPORTUNISTIC_CLEANUP_PROBABILITY = 0.01;

/**
 * Builds a rate-limit bucket key from a non-secret UUID (api_keys.id, organizations.id).
 * Format: `<scope>:<kind>:<uuid>` — never raw API keys or IP addresses.
 * Matches the CHECK constraint `rate_limit_buckets_key_format_check` in the database.
 */
export function buildRateLimitKey(scope: string, kind: string, uuid: string): string {
  if (!SEGMENT_RE.test(scope) || !SEGMENT_RE.test(kind)) {
    throw new Error('[RATE_LIMIT_KEY] scope/kind deben ser [a-z_]+');
  }
  const id = String(uuid || '').trim().toLowerCase();
  if (!UUID_RE.test(id)) {
    throw new Error('[RATE_LIMIT_KEY] el identificador debe ser un UUID (nunca una llave API ni una IP).');
  }
  return `${scope}:${kind}:${id}`;
}

/**
 * Builds a rate-limit bucket key from a sensitive identifier (e.g., client IP address).
 * Format: `<scope>:<kind>:h:<sha256hex>` — SHA256 hash, never cleartext.
 * Matches the CHECK constraint `rate_limit_buckets_key_format_check` in the database.
 */
export function buildHashedRateLimitKey(scope: string, kind: string, rawIdentifier: string): string {
  if (!SEGMENT_RE.test(scope) || !SEGMENT_RE.test(kind)) {
    throw new Error('[RATE_LIMIT_KEY] scope/kind deben ser [a-z_]+');
  }
  const id = String(rawIdentifier || '').trim();
  if (!id) {
    throw new Error('[RATE_LIMIT_KEY] el identificador no puede estar vacío');
  }
  const hash = crypto.createHash('sha256').update(id).digest('hex');
  return `${scope}:${kind}:h:${hash}`;
}

/**
 * Deletes buckets whose last_request_at is older than 1 day.
 * Called from the maintenance cron and opportunistically from checkSharedRateLimit.
 */
export async function purgeStaleRateLimitBuckets(): Promise<{ ok: boolean; error?: string }> {
  const cutoffIso = new Date(Date.now() - RATE_LIMIT_BUCKET_RETENTION_MS).toISOString();
  const { error } = await supabase
    .from('rate_limit_buckets')
    .delete()
    .lt('last_request_at', cutoffIso);
  return error ? { ok: false, error: error.code || 'DELETE_FAILED' } : { ok: true };
}

/**
 * Checks rate limit against PostgreSQL atomic function `check_rate_limit_atomic`.
 * Shared across serverless instances without new external services.
 * Latency: one extra Supabase roundtrip (~40-120 ms). Applied only to /api/keys mutations.
 *
 * `key` must come from buildRateLimitKey().
 */
export async function checkSharedRateLimit(
  key: string,
  maxRequests: number,
  windowSeconds: number
): Promise<SharedRateLimitResult> {
  const failOpen: SharedRateLimitResult = {
    allowed: true,
    currentCount: 0,
    limit: maxRequests,
    remaining: maxRequests,
    resetSeconds: windowSeconds,
    isShared: false,
  };

  try {
    const { data, error } = await supabase.rpc('check_rate_limit_atomic', {
      p_key: key,
      p_max_requests: maxRequests,
      p_window_seconds: windowSeconds,
    });

    // Opportunistic cleanup (≈1% of calls). Failures are ignored; the cron is the backstop.
    if (Math.random() < OPPORTUNISTIC_CLEANUP_PROBABILITY) {
      await purgeStaleRateLimitBuckets().catch(() => undefined);
    }

    if (error || !Array.isArray(data) || data.length === 0) {
      // Fail-open: if the function is not migrated yet or the DB fails, the
      // in-memory Edge limiter in middleware.ts still applies.
      return failOpen;
    }

    const row = data[0];
    return {
      allowed: Boolean(row.allowed),
      currentCount: Number(row.current_count),
      limit: Number(row.limit_count),
      remaining: Number(row.remaining),
      resetSeconds: Number(row.reset_seconds),
      isShared: true,
    };
  } catch {
    return failOpen;
  }
}
