import { NextRequest, NextResponse } from 'next/server';
import { getServiceLogs, clearServiceLogs } from '@/lib/service-logs';
import { verifyAdminSecretHeader } from '@/lib/env';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-admin-secret',
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'private, no-store, no-cache, max-age=0, must-revalidate',
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
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
  const authError = enforceAdminAuth(req);
  if (authError) return authError;

  const url = new URL(req.url);
  const pageParam = url.searchParams.get('page');
  const limitParam = url.searchParams.get('limit');

  const page = pageParam ? Math.max(1, parseInt(pageParam, 10) || 1) : 1;
  const limit = limitParam ? Math.max(1, Math.min(100, parseInt(limitParam, 10) || 20)) : 20;

  const result = await getServiceLogs({ page, limit });

  return NextResponse.json(
    {
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
