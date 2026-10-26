import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import {
  requireEnv,
  verifyAdminSecretHeader,
  verifyCronSecretHeader,
} from '@/lib/env';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ============================================================================
// [TASK B.10] Edge Rate Limiting (Sliding Window 60s per API Key)
// Note (Section 2): Removed x-rate-limit-max client header override hook.
// ============================================================================
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 60 seconds
const DEFAULT_RATE_LIMIT_MAX_REQUESTS = 100; // 100 requests / minute per API key

interface RateLimitBucket {
  timestamps: number[];
}

const rateLimitStore: Map<string, RateLimitBucket> =
  (globalThis as any).__antigravityRateLimitStore ||
  new Map<string, RateLimitBucket>();
(globalThis as any).__antigravityRateLimitStore = rateLimitStore;

function checkRateLimit(
  keyId: string,
  maxRequests: number = DEFAULT_RATE_LIMIT_MAX_REQUESTS
): {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetSeconds: number;
  retryAfterSeconds: number;
} {
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW_MS;

  let bucket = rateLimitStore.get(keyId);
  if (!bucket) {
    bucket = { timestamps: [] };
    rateLimitStore.set(keyId, bucket);
  }

  bucket.timestamps = bucket.timestamps.filter((ts) => ts > windowStart);

  if (bucket.timestamps.length >= maxRequests) {
    const oldestInWindow = bucket.timestamps[0] || now;
    const retryAfterMs = Math.max(1000, oldestInWindow + RATE_LIMIT_WINDOW_MS - now);
    const retryAfterSeconds = Math.ceil(retryAfterMs / 1000);
    return {
      allowed: false,
      limit: maxRequests,
      remaining: 0,
      resetSeconds: retryAfterSeconds,
      retryAfterSeconds,
    };
  }

  bucket.timestamps.push(now);
  const remaining = Math.max(0, maxRequests - bucket.timestamps.length);
  const oldestInWindow = bucket.timestamps[0] || now;
  const resetSeconds = Math.max(
    1,
    Math.ceil((oldestInWindow + RATE_LIMIT_WINDOW_MS - now) / 1000)
  );

  return {
    allowed: true,
    limit: maxRequests,
    remaining,
    resetSeconds,
    retryAfterSeconds: 0,
  };
}

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers':
    'Content-Type, Authorization, x-api-key, x-user-id, x-end-user-id, x-admin-secret',
};

interface ApiKeyRecord {
  id: string;
  org_id: string;
  user_id?: string | null;
  name: string;
  can_read: boolean;
  can_upload: boolean;
  can_delete: boolean;
  is_active: boolean;
}

interface UserRecord {
  id: string;
  org_id: string;
  name: string;
  email: string;
  role: string;
  can_upload: boolean;
}

async function sha256Hex(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

function applySecurityHeaders(response: NextResponse): NextResponse {
  Object.entries(SECURITY_HEADERS).forEach(([key, value]) => {
    response.headers.set(key, value);
  });
  return response;
}

function jsonError(
  status: number,
  error: string,
  code: string,
  message: string,
  extraHeaders?: Record<string, string>
): NextResponse {
  const res = applySecurityHeaders(
    NextResponse.json({ error, code, message }, { status })
  );
  if (extraHeaders) {
    Object.entries(extraHeaders).forEach(([k, v]) => res.headers.set(k, v));
  }
  return res;
}

function isAdminRoute(pathname: string): boolean {
  return (
    pathname === '/api/keys' ||
    pathname.startsWith('/api/keys/') ||
    pathname === '/api/logs' ||
    pathname.startsWith('/api/logs/') ||
    pathname === '/api/records' ||
    pathname.startsWith('/api/records/') ||
    pathname === '/api/users' ||
    pathname.startsWith('/api/users/') ||
    pathname === '/api/webhooks' ||
    pathname.startsWith('/api/webhooks/') ||
    pathname === '/api/test' ||
    pathname.startsWith('/api/test/')
  );
}

export async function middleware(request: NextRequest) {
  if (request.method === 'OPTIONS') {
    return applySecurityHeaders(new NextResponse(null, { status: 204 }));
  }

  const { pathname } = request.nextUrl;
  const method = request.method.toUpperCase();
  const isProd = process.env.NODE_ENV === 'production';

  // 1. Public healthcheck endpoint (/api/health) — no sensitive data
  if (pathname === '/api/health') {
    return applySecurityHeaders(NextResponse.next());
  }

  // 2. Disable /api/img in production until the transformations stage
  if (pathname === '/api/img' || pathname.startsWith('/api/img/')) {
    if (isProd) {
      return jsonError(
        503,
        'Service Unavailable',
        'IMAGE_TRANSFORM_DISABLED_IN_PRODUCTION',
        'El endpoint de transformaciones (/api/img) está deshabilitado en producción hasta la etapa de transformaciones.'
      );
    }
  }

  // 3. Block destructive test/debug endpoints in production
  if (isProd) {
    if (
      pathname === '/api/test/cleanup' ||
      pathname.startsWith('/api/test/') ||
      (pathname === '/api/logs' && method === 'DELETE') ||
      (pathname === '/api/records' && method === 'DELETE') ||
      (pathname === '/api/webhooks/test-receiver' && method === 'PUT')
    ) {
      return jsonError(
        403,
        'Forbidden',
        'ENDPOINT_DISABLED_IN_PRODUCTION',
        `La operación '${method} ${pathname}' está deshabilitada en el entorno de producción.`
      );
    }
  }

  try {
    // 4. Cron routes (/api/cron/*) require CRON_SECRET (Authorization: Bearer <CRON_SECRET>)
    if (pathname === '/api/cron' || pathname.startsWith('/api/cron/')) {
      const cronCheck = verifyCronSecretHeader(request.headers);
      if (!cronCheck.valid) {
        return jsonError(
          cronCheck.status,
          cronCheck.status === 401 ? 'Unauthorized' : 'Forbidden',
          cronCheck.code || 'CRON_AUTH_FAILED',
          cronCheck.message || 'No autorizado para ejecutar tareas de Cron.'
        );
      }
      return applySecurityHeaders(NextResponse.next());
    }

    // 5. Administrative routes require ADMIN_API_SECRET (with ADMIN_API_SECRET_PREVIOUS support)
    if (isAdminRoute(pathname)) {
      const adminCheck = verifyAdminSecretHeader(request.headers);
      if (!adminCheck.valid) {
        return jsonError(
          adminCheck.status,
          adminCheck.status === 401 ? 'Unauthorized' : 'Forbidden',
          adminCheck.code || 'ADMIN_AUTH_FAILED',
          adminCheck.message || 'No autorizado para acceder a rutas administrativas.'
        );
      }
      return applySecurityHeaders(NextResponse.next());
    }

    // 6. All remaining /api/* routes require a valid organization API Key (x-api-key)
    const supabaseUrl = requireEnv('SUPABASE_URL');
    const supabaseServiceRoleKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

    const rawApiKey = request.headers.get('x-api-key')?.trim();
    if (!rawApiKey) {
      return jsonError(
        401,
        'Unauthorized',
        'MISSING_API_KEY',
        'Autenticación requerida: debe enviar una API Key válida en la cabecera x-api-key.'
      );
    }

    const hashedKey = await sha256Hex(rawApiKey);
    const restUrl = `${supabaseUrl}/rest/v1/api_keys?hashed_key=eq.${encodeURIComponent(
      hashedKey
    )}&select=id,org_id,user_id,name,can_read,can_upload,can_delete,is_active&limit=1`;

    const dbResponse = await fetch(restUrl, {
      method: 'GET',
      headers: {
        apikey: supabaseServiceRoleKey,
        Authorization: `Bearer ${supabaseServiceRoleKey}`,
        'Content-Type': 'application/json',
      },
      cache: 'no-store',
    });

    if (!dbResponse.ok) {
      return jsonError(
        500,
        'Internal Server Error',
        'AUTH_VERIFICATION_ERROR',
        'Error al verificar la API Key contra el almacén de seguridad.'
      );
    }

    const records = (await dbResponse.json()) as ApiKeyRecord[];
    const keyRecord = records?.[0];

    if (!keyRecord || !keyRecord.is_active) {
      return jsonError(
        403,
        'Forbidden',
        'INVALID_OR_INACTIVE_API_KEY',
        'Acceso denegado: la API Key proporcionada no existe o ha sido revocada.'
      );
    }

    // 7. Sliding Window Rate Limit (60s) per API Key (no header override allowed)
    const rateStatus = checkRateLimit(keyRecord.id, DEFAULT_RATE_LIMIT_MAX_REQUESTS);

    const rateLimitHeaders: Record<string, string> = {
      'X-RateLimit-Limit': String(rateStatus.limit),
      'X-RateLimit-Remaining': String(rateStatus.remaining),
      'X-RateLimit-Reset': String(rateStatus.resetSeconds),
    };

    if (!rateStatus.allowed) {
      return jsonError(
        429,
        'Too Many Requests',
        'RATE_LIMIT_EXCEEDED',
        `Límite de peticiones excedido para esta API Key (${rateStatus.limit} req / 60s). Reintenta en ${rateStatus.retryAfterSeconds} segundos.`,
        {
          ...rateLimitHeaders,
          'Retry-After': String(rateStatus.retryAfterSeconds),
        }
      );
    }

    // 8. Least-Privilege RBAC Verification
    let hasPermission = false;
    let requiredPermissionName = '';

    if (method === 'GET' || method === 'HEAD') {
      hasPermission = Boolean(keyRecord.can_read);
      requiredPermissionName = 'can_read';
    } else if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
      hasPermission = Boolean(keyRecord.can_upload);
      requiredPermissionName = 'can_upload';
    } else if (method === 'DELETE') {
      hasPermission = Boolean(keyRecord.can_delete);
      requiredPermissionName = 'can_delete';
    }

    if (!hasPermission) {
      return jsonError(
        403,
        'Forbidden',
        'INSUFFICIENT_API_KEY_PERMISSIONS',
        `Permisos insuficientes: la llave '${keyRecord.name}' no cuenta con el privilegio '${requiredPermissionName}' para ejecutar métodos ${method}.`,
        rateLimitHeaders
      );
    }

    // 9. Section 3 (Option A): Organization-bound API Key + End-User validation
    const headerUserId = (
      request.headers.get('x-user-id') ||
      request.headers.get('x-end-user-id') ||
      ''
    ).trim();

    const boundUserId = keyRecord.user_id ? String(keyRecord.user_id).trim() : '';

    // If the key is bound to a specific user_id, prevent impersonating any other user via header
    if (boundUserId && headerUserId && headerUserId !== boundUserId) {
      return jsonError(
        403,
        'Forbidden',
        'FORBIDDEN_USER_IMPERSONATION',
        `La API Key '${keyRecord.name}' está vinculada exclusivamente al usuario '${boundUserId}' y no puede operar en nombre de '${headerUserId}'.`,
        rateLimitHeaders
      );
    }

    const candidateUserId = boundUserId || headerUserId;

    // Upload ticket creation (POST /api/upload, POST /api/upload/multipart) always requires an end-user
    const isTicketCreationRequest =
      method === 'POST' &&
      (pathname === '/api/upload' || pathname === '/api/upload/multipart');

    if (!candidateUserId && isTicketCreationRequest) {
      return jsonError(
        400,
        'Bad Request',
        'MISSING_END_USER_ID',
        'Las API Keys de organización (sin user_id fijo) requieren que el backend envíe el UUID del usuario final en la cabecera x-user-id.',
        rateLimitHeaders
      );
    }

    let validatedUserId = '';

    if (candidateUserId) {
      if (!UUID_REGEX.test(candidateUserId)) {
        return jsonError(
          400,
          'Bad Request',
          'INVALID_END_USER_ID',
          'El identificador de usuario final en la cabecera x-user-id debe ser un UUID v4 válido.',
          rateLimitHeaders
        );
      }

      const userRestUrl = `${supabaseUrl}/rest/v1/users?id=eq.${encodeURIComponent(
        candidateUserId
      )}&select=id,org_id,name,email,role,can_upload&limit=1`;

      const userResp = await fetch(userRestUrl, {
        method: 'GET',
        headers: {
          apikey: supabaseServiceRoleKey,
          Authorization: `Bearer ${supabaseServiceRoleKey}`,
          'Content-Type': 'application/json',
        },
        cache: 'no-store',
      });

      if (!userResp.ok) {
        return jsonError(
          500,
          'Internal Server Error',
          'USER_VERIFICATION_ERROR',
          'Error al verificar la pertenencia del usuario final en la base de datos.',
          rateLimitHeaders
        );
      }

      const userRows = (await userResp.json()) as UserRecord[];
      const userRecord = userRows?.[0];

      if (!userRecord) {
        return jsonError(
          401,
          'Unauthorized',
          'USER_NOT_REGISTERED',
          `El usuario final '${candidateUserId}' no existe en el sistema.`,
          rateLimitHeaders
        );
      }

      if (userRecord.org_id !== keyRecord.org_id) {
        return jsonError(
          403,
          'Forbidden',
          'FORBIDDEN_USER_ORG_MISMATCH',
          `Aislamiento Multi-Tenant: el usuario '${candidateUserId}' no pertenece a la organización propietaria de la API Key.`,
          rateLimitHeaders
        );
      }

      validatedUserId = userRecord.id;
    }

    // 10. Strip any client-supplied x-validated-* headers and inject server-verified context
    const requestHeaders = new Headers(request.headers);
    requestHeaders.delete('x-validated-org-id');
    requestHeaders.delete('x-validated-user-id');
    requestHeaders.delete('x-api-key-id');
    requestHeaders.delete('x-api-key-name');
    requestHeaders.delete('x-api-key-bound-user-id');

    requestHeaders.set('x-validated-org-id', keyRecord.org_id);
    if (validatedUserId) {
      requestHeaders.set('x-validated-user-id', validatedUserId);
    }
    requestHeaders.set('x-api-key-id', keyRecord.id);
    requestHeaders.set('x-api-key-name', keyRecord.name);
    requestHeaders.set('x-api-key-bound-user-id', boundUserId);

    const response = NextResponse.next({
      request: {
        headers: requestHeaders,
      },
    });

    Object.entries(rateLimitHeaders).forEach(([k, v]) => response.headers.set(k, v));
    return applySecurityHeaders(response);
  } catch (error: any) {
    return jsonError(
      500,
      'Internal Server Error',
      'MIDDLEWARE_INTERNAL_ERROR',
      error?.message || 'Error inesperado en el middleware de seguridad.'
    );
  }
}

// Intercept ALL /api/* routes (only /api/health is public inside middleware)
export const config = {
  matcher: ['/api/:path*'],
};
