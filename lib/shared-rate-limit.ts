import crypto from 'crypto';
import { pgClient } from '@/lib/postgres';
import { db, isDirectDatabaseConfigured, rateLimitBuckets } from '@/lib/db';
import { sql, lt } from 'drizzle-orm';

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
  if (isDirectDatabaseConfigured()) {
    try {
      const cutoffDate = new Date(Date.now() - RATE_LIMIT_BUCKET_RETENTION_MS);
      await db.delete(rateLimitBuckets).where(lt(rateLimitBuckets.last_request_at, cutoffDate));
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err.message || 'DELETE_FAILED' };
    }
  }

  const cutoffIso = new Date(Date.now() - RATE_LIMIT_BUCKET_RETENTION_MS).toISOString();
  const { error } = await pgClient
    .from('rate_limit_buckets')
    .delete()
    .lt('last_request_at', cutoffIso);
  return error ? { ok: false, error: error.code || 'DELETE_FAILED' } : { ok: true };
}

/**
 * Checks rate limit against database sliding window table `rate_limit_buckets`.
 * - If DATABASE_URL is configured: executes atomic portable SQL UPSERT directly.
 * - Otherwise: falls back to PostgreSQL client RPC `check_rate_limit_atomic`.
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

  // 1. Direct PostgreSQL Execution (Portable SQL without proprietary RPC)
  if (isDirectDatabaseConfigured()) {
    try {
      const queryResult: any = await db.execute(sql`
        INSERT INTO rate_limit_buckets AS b (key, count, window_start, last_request_at)
        VALUES (${key}, 1, clock_timestamp(), clock_timestamp())
        ON CONFLICT (key) DO UPDATE
        SET count = CASE WHEN b.window_start + (${windowSeconds} * INTERVAL '1 second') <= clock_timestamp() THEN 1 ELSE b.count + 1 END,
            window_start = CASE WHEN b.window_start + (${windowSeconds} * INTERVAL '1 second') <= clock_timestamp() THEN clock_timestamp() ELSE b.window_start END,
            last_request_at = clock_timestamp()
        RETURNING b.count, b.window_start
      `);

      if (Math.random() < OPPORTUNISTIC_CLEANUP_PROBABILITY) {
        await purgeStaleRateLimitBuckets().catch(() => undefined);
      }

      const row = queryResult?.[0];
      if (!row) return failOpen;

      const currentCount = Number(row.count);
      const windowStartTime = new Date(row.window_start).getTime();
      const now = Date.now();
      const elapsedSeconds = Math.max(0, Math.floor((now - windowStartTime) / 1000));
      const resetSeconds = Math.max(1, windowSeconds - elapsedSeconds);

      return {
        allowed: currentCount <= maxRequests,
        currentCount,
        limit: maxRequests,
        remaining: Math.max(0, maxRequests - currentCount),
        resetSeconds,
        isShared: true,
      };
    } catch (err: any) {
      console.warn('[RATE_LIMIT_DIRECT_SQL_FALLBACK] Direct query failed, falling back to fail-open:', err.message, err.cause);
      return failOpen;
    }
  }

  // 2. Legacy PostgreSQL PostgREST RPC Fallback
  try {
    const { data, error } = await pgClient.rpc('check_rate_limit_atomic', {
      p_key: key,
      p_max_requests: maxRequests,
      p_window_seconds: windowSeconds,
    });

    if (Math.random() < OPPORTUNISTIC_CLEANUP_PROBABILITY) {
      await purgeStaleRateLimitBuckets().catch(() => undefined);
    }

    if (error || !Array.isArray(data) || data.length === 0) {
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
