import { NextRequest, NextResponse } from 'next/server';

// Credenciales de conexión a Supabase REST API (Edge Compatible)
const FALLBACK_URL = 'https://ztmjgbhdgbgbtmvxgtrc.supabase.co';
const FALLBACK_KEY = typeof atob !== 'undefined'
  ? atob('c2Jfc2VjcmV0X0tGcjZGV19icy14eXJ3bFlGekt5S0FfZTdvTGxjUWU=')
  : '';

const SUPABASE_URL = process.env.SUPABASE_URL || FALLBACK_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || FALLBACK_KEY;

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
  // 1. Dejar pasar peticiones preflight CORS sin validar la API Key
  if (req.method === 'OPTIONS') {
    return NextResponse.next();
  }

  // 2. Extraer cabecera x-api-key
  const apiKey = req.headers.get('x-api-key')?.trim();
  if (!apiKey) {
    return NextResponse.json(
      {
        error: 'Unauthorized',
        code: 'MISSING_API_KEY',
        message: 'Acceso Denegado: Se requiere la cabecera "x-api-key" para acceder a esta ruta protegida.',
      },
      { status: 401 }
    );
  }

  try {
    // 3. Hashear la llave entrante usando Web Crypto API (crypto.subtle)
    const hashedKey = await hashSha256(apiKey);

    // 4. Consultar PostgREST en Supabase buscando coincidencia exacta del hash y is_active=true
    const queryUrl = `${SUPABASE_URL}/rest/v1/api_keys?hashed_key=eq.${encodeURIComponent(hashedKey)}&is_active=eq.true&select=id,org_id,name,can_read,can_upload,can_delete,is_active`;

    const supabaseRes = await fetch(queryUrl, {
      method: 'GET',
      headers: {
        'apikey': SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      },
      // Desactivar caché para garantizar revocaciones inmediatas
      cache: 'no-store',
    });

    if (!supabaseRes.ok) {
      console.error('Error al consultar Supabase desde Edge Middleware:', supabaseRes.statusText);
      return NextResponse.json(
        {
          error: 'Internal Server Error',
          code: 'AUTH_GATEWAY_ERROR',
          message: 'Error de comunicación al validar la llave de acceso en la base de datos.',
        },
        { status: 500 }
      );
    }

    const matchingKeys = await supabaseRes.json();

    // Si no existe la llave o no está activa -> 401
    if (!Array.isArray(matchingKeys) || matchingKeys.length === 0) {
      return NextResponse.json(
        {
          error: 'Unauthorized',
          code: 'INVALID_API_KEY',
          message: 'Acceso Denegado: La llave API provista es inválida, ha sido revocada o se encuentra inactiva.',
        },
        { status: 401 }
      );
    }

    const keyRecord = matchingKeys[0];
    const pathname = req.nextUrl.pathname;
    const method = req.method;

    // 5. Verificar permisos basados en el Principio de Menor Privilegio
    // Regla de Subida: Si el método es POST o PUT hacia /api/upload o /api/files -> Exigir can_upload
    if ((pathname.startsWith('/api/upload') || pathname.startsWith('/api/files')) && (method === 'POST' || method === 'PUT')) {
      if (!keyRecord.can_upload) {
        return NextResponse.json(
          {
            error: 'Forbidden',
            code: 'FORBIDDEN_INSUFFICIENT_PERMISSIONS',
            message: `Permisos Insuficientes: La llave API "${keyRecord.name}" no cuenta con la facultad "can_upload" requerida para operaciones ${method}.`,
          },
          { status: 403 }
        );
      }
    }

    // Regla de Lectura: Si es GET hacia /api/files -> Exigir can_read
    if (pathname.startsWith('/api/files') && method === 'GET' && !keyRecord.can_read) {
      return NextResponse.json(
        {
          error: 'Forbidden',
          code: 'FORBIDDEN_INSUFFICIENT_PERMISSIONS',
          message: `Permisos Insuficientes: La llave API "${keyRecord.name}" no cuenta con la facultad "can_read" requerida para consultas.`,
        },
        { status: 403 }
      );
    }

    // Regla de Eliminación: Si es DELETE hacia /api/files -> Exigir can_delete
    if (pathname.startsWith('/api/files') && method === 'DELETE' && !keyRecord.can_delete) {
      return NextResponse.json(
        {
          error: 'Forbidden',
          code: 'FORBIDDEN_INSUFFICIENT_PERMISSIONS',
          message: `Permisos Insuficientes: La llave API "${keyRecord.name}" no cuenta con la facultad "can_delete" requerida para eliminación.`,
        },
        { status: 403 }
      );
    }

    // 6. Inyección de Headers de Contexto Seguro
    // Clonamos las cabeceras de la petición original e inyectamos los datos verificados de la llave
    const requestHeaders = new Headers(req.headers);
    requestHeaders.set('x-validated-org-id', keyRecord.org_id);
    requestHeaders.set('x-api-key-id', keyRecord.id);
    requestHeaders.set('x-api-key-name', keyRecord.name);

    return NextResponse.next({
      request: {
        headers: requestHeaders,
      },
    });
  } catch (err: any) {
    console.error('Fallo no controlado en Edge Middleware:', err);
    return NextResponse.json(
      {
        error: 'Internal Server Error',
        code: 'EDGE_AUTH_EXCEPTION',
        message: 'Ocurrió un error inesperado al procesar la autenticación de la llave.',
      },
      { status: 500 }
    );
  }
}

// Configuración de rutas interceptadas por el Middleware
export const config = {
  matcher: [
    '/api/upload',
    '/api/upload/:path*',
    '/api/files',
    '/api/files/:path*',
  ],
};
