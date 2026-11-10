import { corsHeaders, handleCorsOptions } from '@/lib/cors';
import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { getServiceLogs, clearServiceLogs } from '@/lib/service-logs';
import { verifyAdminSecretHeader } from '@/lib/env';
import { pgClient } from '@/lib/postgres';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function OPTIONS() {
  return handleCorsOptions();
}

function enforceAdminAuth(req: NextRequest): NextResponse | null {
  const check = verifyAdminSecretHeader(req.headers);
  if (!check.valid) {
    return NextResponse.json(
      {
        error: check.status === 401 ? 'Unauthorized' : 'Forbidden',
        code: check.code,
        message: check.message,
      },
      { status: check.status, headers: corsHeaders }
    );
  }
  return null;
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const pageParam = url.searchParams.get('page');
  const limitParam = url.searchParams.get('limit');

  const page = pageParam ? Math.max(1, parseInt(pageParam, 10) || 1) : 1;
  const limit = limitParam ? Math.max(1, Math.min(100, parseInt(limitParam, 10) || 20)) : 20;

  const rawApiKey = (
    req.headers.get('x-api-key') ||
    req.headers.get('x-admin-secret') ||
    url.searchParams.get('apiKey') ||
    ''
  ).trim();

  // Check if either the original headers OR the key provided in x-api-key matches ADMIN_API_SECRET
  const syntheticAdminHeaders = new Headers(req.headers);
  if (rawApiKey && !syntheticAdminHeaders.get('x-admin-secret')) {
    syntheticAdminHeaders.set('x-admin-secret', rawApiKey);
  }
  const isAdmin = verifyAdminSecretHeader(syntheticAdminHeaders).valid;

  if (!isAdmin && !rawApiKey) {
    return NextResponse.json(
      {
        error: 'Unauthorized',
        code: 'AUTHENTICATION_REQUIRED',
        message:
          'Se requiere una API Key de organización (para ver los logs de tu organización) o la llave de administrador (para ver todos los logs) en la cabecera x-api-key.',
      },
      { status: 401, headers: corsHeaders }
    );
  }

  // Caso 1: Llave de una Organización -> devolver únicamente los logs de esa organización (con su IP real sin censurar)
  if (!isAdmin && rawApiKey) {
    const keyHash = crypto.createHash('sha256').update(rawApiKey).digest('hex');
    const { data: keyRecord } = await pgClient
      .from('api_keys')
      .select('id, org_id, name, is_active')
      .eq('hashed_key', keyHash)
      .eq('is_active', true)
      .maybeSingle();

    if (!keyRecord) {
      return NextResponse.json(
        {
          error: 'Forbidden',
          code: 'INVALID_OR_INACTIVE_API_KEY',
          message: 'La API Key proporcionada no es válida o está inactiva.',
        },
        { status: 403, headers: corsHeaders }
      );
    }

    const allRes = await getServiceLogs({ page: 1, limit: 1000 });
    const orgLogs = allRes.logs.filter(
      (l) => l.orgId === keyRecord.org_id || l.targetOrgId === keyRecord.org_id
    );

    const total = orgLogs.length;
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const offset = (page - 1) * limit;
    const paged = orgLogs.slice(offset, offset + limit);

    return NextResponse.json(
      {
        scope: 'organization',
        orgId: keyRecord.org_id,
        keyName: keyRecord.name,
        count: total,
        total,
        page,
        limit,
        totalPages,
        logs: paged,
      },
      { status: 200, headers: corsHeaders }
    );
  }

  // Caso 2: Llave de Administrador -> devolver TODOS los logs del sistema (con IP real sin censurar)
  const result = await getServiceLogs({ page, limit });

  return NextResponse.json(
    {
      scope: 'admin_all',
      orgId: null,
      count: result.total,
      total: result.total,
      page: result.page,
      limit: result.limit,
      totalPages: result.totalPages,
      logs: result.logs,
    },
    { status: 200, headers: corsHeaders }
  );
}

export async function DELETE(req: NextRequest) {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json(
      {
        error: 'Forbidden',
        code: 'ENDPOINT_DISABLED_IN_PRODUCTION',
        message: 'DELETE /api/logs está deshabilitado permanentemente en producción.',
      },
      { status: 403, headers: corsHeaders }
    );
  }

  const authError = enforceAdminAuth(req);
  if (authError) return authError;

  await clearServiceLogs();
  return NextResponse.json(
    { message: 'Logs limpiados correctamente (entorno de desarrollo).' },
    { status: 200, headers: corsHeaders }
  );
}
