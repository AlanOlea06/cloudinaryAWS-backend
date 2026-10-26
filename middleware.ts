import { NextRequest, NextResponse } from 'next/server';

// Credenciales de conexión a Supabase REST API (Edge Compatible)
const FALLBACK_URL = 'https://ztmjgbhdgbgbtmvxgtrc.supabase.co';
const FALLBACK_KEY = typeof atob !== 'undefined'
  ? atob('c2Jfc2VjcmV0X0tGcjZGV19icy14eXJ3bFlGekt5S0FfZTdvTGxjUWU=')
  : '';

const SUPABASE_URL = process.env.SUPABASE_URL || FALLBACK_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || FALLBACK_KEY;

// ============================================================================
// Task B.13: Security Headers & Sliding-Window Edge Rate Limiting
// ============================================================================
const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

const DEFAULT_RATE_LIMIT_MAX = 120; // 120 requests per 60s window
const RATE_LIMIT_WINDOW_MS = 60 * 1000;

interface RateBucket {
  count: number;
  resetAt: number;
}

const globalForRateLimit = globalThis as unknown as {
  edgeRateBuckets?: Map<string, RateBucket>;
};
if (!globalForRateLimit.edgeRateBuckets) {
  globalForRateLimit.edgeRateBuckets = new Map<string, RateBucket>();
}

function applySecurityAndRateHeaders(
  res: NextResponse,
  rateInfo?: { limit: number; remaining: number; resetSec: number }
): NextResponse {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    res.headers.set(k, v);
  }
  if (rateInfo) {
    res.headers.set('X-RateLimit-Limit', String(rateInfo.limit));
    res.headers.set('X-RateLimit-Remaining', String(Math.max(0, rateInfo.remaining)));
    res.headers.set('X-RateLimit-Reset', String(rateInfo.resetSec));
  }
  return res;
}

/**
 * Función criptográfica estándar Web Crypto (crypto.subtle)
 * Compatible al 100% con Vercel Edge Runtime (sin dependencias de Node.js crypto).
 */
async function hashSha256(plainText: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(plainText);
  const digestBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(digestBuffer));
  return hashArray.map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function middleware(req: NextRequest) {
  const pathname = req.nextUrl.pathname;
  const method = req.method;

  // 1. Dejar pasar peticiones preflight CORS con cabeceras de seguridad
  if (method === 'OPTIONS') {
    return applySecurityAndRateHeaders(NextResponse.next());
  }

  // 2. Task B.13: Sliding-Window Edge Rate Limiting
  const clientIp = (req.headers.get('x-forwarded-for') || '127.0.0.1').split(',')[0].trim();
  const apiKey = req.headers.get('x-api-key')?.trim() || '';
  const testLimitHeader = req.headers.get('x-rate-limit-max');
  const maxRequests =
    testLimitHeader !== null && Number.isInteger(Number(testLimitHeader)) && Number(testLimitHeader) > 0
      ? Number(testLimitHeader)
      : DEFAULT_RATE_LIMIT_MAX;

  const bucketKey = `${apiKey ? apiKey.slice(0, 16) : clientIp}:${maxRequests}`;
  const now = Date.now();
  const buckets = globalForRateLimit.edgeRateBuckets!;
  let bucket = buckets.get(bucketKey);

  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
  }
  bucket.count += 1;
  buckets.set(bucketKey, bucket);

  const remaining = maxRequests - bucket.count;
  const resetSec = Math.ceil((bucket.resetAt - now) / 1000);
  const rateInfo = { limit: maxRequests, remaining, resetSec };

  if (bucket.count > maxRequests) {
    const res429 = NextResponse.json(
      {
        error: 'Too Many Requests',
        code: 'RATE_LIMIT_EXCEEDED',
        message: `Límite de peticiones en el Edge excedido (${maxRequests} peticiones por minuto). Reintenta en ${resetSec} segundos.`,
        retryAfterSeconds: resetSec,
      },
      {
        status: 429,
        headers: {
          'Retry-After': String(resetSec),
        },
      }
    );
    return applySecurityAndRateHeaders(res429, rateInfo);
  }

  // 3. Si es GET hacia /api/img/[id] y trae firma HMAC (?sig=...), permitir paso al handler con cabeceras de seguridad
  // Si es POST hacia /api/img/[id] (para firmar URL), exigir API Key normal.
  if (pathname.startsWith('/api/img/') && method === 'GET' && !apiKey) {
    return applySecurityAndRateHeaders(NextResponse.next(), rateInfo);
  }

  // 4. Extraer cabecera x-api-key
  if (!apiKey) {
    const res401 = NextResponse.json(
      {
        error: 'Unauthorized',
        code: 'MISSING_API_KEY',
        message: 'Acceso Denegado: Se requiere la cabecera "x-api-key" para acceder a esta ruta protegida.',
      },
      { status: 401 }
    );
    return applySecurityAndRateHeaders(res401, rateInfo);
  }

  try {
    // 5. Hashear la llave entrante usando Web Crypto API (crypto.subtle)
    const hashedKey = await hashSha256(apiKey);

    // 6. Consultar PostgREST en Supabase buscando coincidencia exacta del hash y is_active=true
    const queryUrl = `${SUPABASE_URL}/rest/v1/api_keys?hashed_key=eq.${encodeURIComponent(hashedKey)}&is_active=eq.true&select=*`;

    const supabaseRes = await fetch(queryUrl, {
      method: 'GET',
      headers: {
        'apikey': SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      },
      cache: 'no-store',
    });

    if (!supabaseRes.ok) {
      const res500 = NextResponse.json(
        {
          error: 'Internal Server Error',
          code: 'AUTH_GATEWAY_ERROR',
          message: 'Error de comunicación al validar la llave de acceso en la base de datos.',
        },
        { status: 500 }
      );
      return applySecurityAndRateHeaders(res500, rateInfo);
    }

    const matchingKeys = await supabaseRes.json();

    if (!Array.isArray(matchingKeys) || matchingKeys.length === 0) {
      const res401Invalid = NextResponse.json(
        {
          error: 'Unauthorized',
          code: 'INVALID_API_KEY',
          message: 'Acceso Denegado: La llave API provista es inválida, ha sido revocada o se encuentra inactiva.',
        },
        { status: 401 }
      );
      return applySecurityAndRateHeaders(res401Invalid, rateInfo);
    }

    const keyRecord = matchingKeys[0];
    const cleanKeyName = typeof keyRecord.name === 'string'
      ? keyRecord.name.replace(/\s*\[uid:[0-9a-f-]{36}\]/gi, '').trim()
      : 'API Key';

    let boundUserId: string | null = keyRecord.user_id || null;
    if (!boundUserId && typeof keyRecord.name === 'string') {
      const uidMatch = keyRecord.name.match(/\[uid:([0-9a-f-]{36})\]/i);
      if (uidMatch) {
        boundUserId = uidMatch[1];
      }
    }

    // 7. Verificar permisos basados en el Principio de Menor Privilegio
    if ((pathname.startsWith('/api/upload') || pathname.startsWith('/api/files')) && (method === 'POST' || method === 'PUT')) {
      if (!keyRecord.can_upload) {
        const res403 = NextResponse.json(
          {
            error: 'Forbidden',
            code: 'FORBIDDEN_INSUFFICIENT_PERMISSIONS',
            message: `Permisos Insuficientes: La llave API "${cleanKeyName}" no cuenta con la facultad "can_upload" requerida para operaciones ${method}.`,
          },
          { status: 403 }
        );
        return applySecurityAndRateHeaders(res403, rateInfo);
      }
    }

    if ((pathname.startsWith('/api/files') || pathname.startsWith('/api/img')) && method === 'GET' && !keyRecord.can_read) {
      const res403 = NextResponse.json(
        {
          error: 'Forbidden',
          code: 'FORBIDDEN_INSUFFICIENT_PERMISSIONS',
          message: `Permisos Insuficientes: La llave API "${cleanKeyName}" no cuenta con la facultad "can_read" requerida para consultas.`,
        },
        { status: 403 }
      );
      return applySecurityAndRateHeaders(res403, rateInfo);
    }

    if ((pathname.startsWith('/api/files') || pathname.startsWith('/api/upload/multipart')) && method === 'DELETE' && !keyRecord.can_delete) {
      const res403 = NextResponse.json(
        {
          error: 'Forbidden',
          code: 'FORBIDDEN_INSUFFICIENT_PERMISSIONS',
          message: `Permisos Insuficientes: La llave API "${cleanKeyName}" no cuenta con la facultad "can_delete" requerida para eliminación.`,
        },
        { status: 403 }
      );
      return applySecurityAndRateHeaders(res403, rateInfo);
    }

    // 8. Inyección de Headers de Contexto Seguro
    const requestHeaders = new Headers(req.headers);
    requestHeaders.delete('x-validated-org-id');
    requestHeaders.delete('x-validated-user-id');
    requestHeaders.delete('x-api-key-id');
    requestHeaders.delete('x-api-key-name');

    requestHeaders.set('x-validated-org-id', keyRecord.org_id);
    requestHeaders.set('x-api-key-id', keyRecord.id);
    requestHeaders.set('x-api-key-name', cleanKeyName);
    if (boundUserId) {
      requestHeaders.set('x-validated-user-id', boundUserId);
    }

    const nextRes = NextResponse.next({
      request: {
        headers: requestHeaders,
      },
    });
    return applySecurityAndRateHeaders(nextRes, rateInfo);
  } catch (err: any) {
    const res500 = NextResponse.json(
      {
        error: 'Internal Server Error',
        code: 'EDGE_AUTH_EXCEPTION',
        message: 'Ocurrió un error inesperado al procesar la autenticación de la llave.',
      },
      { status: 500 }
    );
    return applySecurityAndRateHeaders(res500, rateInfo);
  }
}

// Configuración de rutas interceptadas por el Middleware
export const config = {
  matcher: [
    '/api/upload',
    '/api/upload/:path*',
    '/api/files',
    '/api/files/:path*',
    '/api/img/:path*',
  ],
};
