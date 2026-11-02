import { NextResponse } from 'next/server';

/**
 * Standard CORS and security headers for API responses across all endpoints.
 * Unified and standardized to avoid inconsistencies.
 */
export const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers':
    'Content-Type, Authorization, x-api-key, x-user-id, x-end-user-id, x-admin-secret, x-cron-secret, x-amz-checksum-sha256',
  'X-Content-Type-Options': 'nosniff',
};

/**
 * Standard Preflight OPTIONS handler for Route Handlers.
 */
export function handleCorsOptions(): NextResponse {
  return new NextResponse(null, {
    status: 204,
    headers: corsHeaders,
  });
}
