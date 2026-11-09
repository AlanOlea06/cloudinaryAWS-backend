import { corsHeaders, handleCorsOptions } from '@/lib/cors';
import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { getServiceLogs, clearServiceLogs } from '@/lib/service-logs';
import { verifyAdminSecretHeader } from '@/lib/env';
import { supabase } from '@/lib/supabase';

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

function maskIpAddress(ip: string | null | undefined): string | null {
  if (!ip) return null;
  return 'xxx.xxx.xxx.xxx';
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const pageParam = url.searchParams.get('page');
  const limitParam = url.searchParams.get('limit');

  const page = pageParam ? Math.max(1, parseInt(pageParam, 10) || 1) : 1;
  const limit = limitParam ? Math.max(1, Math.min(100, parseInt(limitParam, 10) || 20)) : 20;

  const isAdmin = verifyAdminSecretHeader(req.headers).valid;
  const rawApiKey = req.headers.get('x-api-key')?.trim();

  // Si envía x-api-key, devolver exclusivamente los logs de su propia organización
  if (!isAdmin && rawApiKey) {
    const keyHash = crypto.createHash('sha256').update(rawApiKey).digest('hex');
    const { data: keyRecord } = await supabase
      .from('api_keys')
      .select('id, org_id, is_active')
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
    const orgLogs = allRes.logs
      .filter((l) => l.orgId === keyRecord.org_id || l.targetOrgId === keyRecord.org_id)
      .map((l) => ({
        ...l,
        ipAddress: maskIpAddress(l.ipAddress),
      }));

    const total = orgLogs.length;
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const offset = (page - 1) * limit;
    const paged = orgLogs.slice(offset, offset + limit);

    return NextResponse.json(
      {
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

  const result = await getServiceLogs({ page, limit });

  // Si es vista pública (sin x-admin-secret), enmascarar IPs y nombres de archivos privados
  const safeLogs = isAdmin
    ? result.logs
    : result.logs.map((l) => {
        const isPrivate = String(l.visibility || '').toLowerCase() === 'private';
        return {
          ...l,
          ipAddress: maskIpAddress(l.ipAddress),
          fileName: isPrivate && l.fileName ? '[privado]' : l.fileName,
        };
      });

  return NextResponse.json(
    {
      count: result.total,
      total: result.total,
      page: result.page,
      limit: result.limit,
      totalPages: result.totalPages,
      logs: safeLogs,
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
