import { supabase } from '@/lib/supabase';

export interface SharedRateLimitResult {
  allowed: boolean;
  currentCount: number;
  limit: number;
  remaining: number;
  resetSeconds: number;
  isShared: boolean;
}

/**
 * Checks rate limit against PostgreSQL atomic function `check_rate_limit_atomic`.
 * Shared across serverless Edge instances without new external services.
 *
 * Latency Note:
 * Adds approximately 40ms-120ms roundtrip to Supabase.
 * Recommended use: critical mutation routes (/api/keys, /api/upload) where consistency is mandatory.
 */
export async function checkSharedRateLimit(
  key: string,
  maxRequests: number,
  windowSeconds: number
): Promise<SharedRateLimitResult> {
  try {
    const { data, error } = await supabase.rpc('check_rate_limit_atomic', {
      p_key: key,
      p_max_requests: maxRequests,
      p_window_seconds: windowSeconds,
    });

    if (error || !data || data.length === 0) {
      // Fallback: if database function is not yet available, allow gracefully
      return {
        allowed: true,
        currentCount: 1,
        limit: maxRequests,
        remaining: maxRequests - 1,
        resetSeconds: windowSeconds,
        isShared: false,
      };
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
  } catch (err: any) {
    return {
      allowed: true,
      currentCount: 1,
      limit: maxRequests,
      remaining: maxRequests - 1,
      resetSeconds: windowSeconds,
      isShared: false,
    };
  }
}
