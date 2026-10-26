import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { addServiceLog } from '@/lib/service-logs';
import { deleteS3ObjectsByKeys } from '@/lib/s3';
import { verifyAdminSecretHeader } from '@/lib/env';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-admin-secret',
  'X-Content-Type-Options': 'nosniff',
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

  try {
    const { searchParams } = new URL(req.url);
    const limit = Math.min(Number(searchParams.get('limit') || '50'), 200);
    const userId = searchParams.get('userId');
    const orgId = searchParams.get('orgId');
    const status = searchParams.get('status');

    let query = supabase
      .from('files')
      .select(`
        *,
        user:users!files_user_id_fkey ( id, name, email, role ),
        organization:organizations!files_org_id_fkey ( id, name, slug )
      `)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (userId) {
      query = query.eq('user_id', userId);
    }
    if (orgId) {
      query = query.eq('org_id', orgId);
    }
    if (status) {
      query = query.eq('status', status);
    }

    const { data, error } = await query;

    if (error) {
      return NextResponse.json(
        { error: 'Error al consultar la tabla files en Supabase', details: error.message },
        { status: 500, headers: corsHeaders }
      );
    }

    const sanitizedRecords = (data || []).map((row: any) => {
      const { s3_pending_key, s3_processed_key, s3_upload_id, ...safeRow } = row;
      return safeRow;
    });

    return NextResponse.json(
      {
        count: sanitizedRecords.length,
        records: sanitizedRecords,
      },
      { status: 200, headers: corsHeaders }
    );
  } catch (err: any) {
    return NextResponse.json(
      { error: 'Internal Server Error', message: err.message },
      { status: 500, headers: corsHeaders }
    );
  }
}

export async function DELETE(req: NextRequest) {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json(
      {
        error: 'Forbidden',
        code: 'ENDPOINT_DISABLED_IN_PRODUCTION',
        message: 'DELETE /api/records está deshabilitado permanentemente en producción.',
      },
      { status: 403, headers: corsHeaders }
    );
  }

  const authError = enforceAdminAuth(req);
  if (authError) return authError;

  try {
    const { searchParams } = new URL(req.url);
    const id = searchParams.get('id');
    const ticketId = searchParams.get('ticketId');

    let selectQuery = supabase
      .from('files')
      .select('id, s3_pending_key, s3_processed_key');

    if (id) {
      selectQuery = selectQuery.eq('id', id);
    } else if (ticketId) {
      selectQuery = selectQuery.eq('ticket_id', ticketId);
    } else {
      selectQuery = selectQuery.neq('id', '00000000-0000-0000-0000-000000000000');
    }

    const { data: recordsToDelete } = await selectQuery;

    const s3KeysToRemove: string[] = [];
    if (recordsToDelete && recordsToDelete.length > 0) {
      for (const rec of recordsToDelete) {
        if (rec.s3_pending_key) s3KeysToRemove.push(rec.s3_pending_key);
        if (rec.s3_processed_key) s3KeysToRemove.push(rec.s3_processed_key);
      }
    }

    let s3Result = { count: 0, keys: [] as string[] };
    if (s3KeysToRemove.length > 0) {
      try {
        s3Result = await deleteS3ObjectsByKeys(s3KeysToRemove);
      } catch (s3Err) {
        console.warn('No se pudieron limpiar objetos S3 en DELETE /api/records:', s3Err);
      }
    }

    let deleteQuery = supabase.from('files').delete();

    if (id) {
      deleteQuery = deleteQuery.eq('id', id);
    } else if (ticketId) {
      deleteQuery = deleteQuery.eq('ticket_id', ticketId);
    } else {
      deleteQuery = deleteQuery.neq('id', '00000000-0000-0000-0000-000000000000');
    }

    const { error } = await deleteQuery;

    if (error) {
      return NextResponse.json(
        { error: 'Error al eliminar registros en files', details: error.message },
        { status: 500, headers: corsHeaders }
      );
    }

    await addServiceLog({
      method: 'DELETE',
      action: 'RECORDS_DELETED',
      status: 'ALLOWED',
      ticketId: ticketId || undefined,
      fileId: id || undefined,
      message: id
        ? `Registro eliminado (id: ${id}) y ${s3Result.count} objeto(s) en S3.`
        : ticketId
        ? `Registro eliminado (ticketId: ${ticketId}) y ${s3Result.count} objeto(s) en S3.`
        : `Todos los registros de prueba en files fueron eliminados junto con ${s3Result.count} objeto(s) en S3.`,
    });

    return NextResponse.json(
      {
        message: 'Registros y objetos en S3 eliminados correctamente (entorno de desarrollo).',
        s3DeletedCount: s3Result.count,
        s3DeletedKeys: s3Result.keys,
      },
      { status: 200, headers: corsHeaders }
    );
  } catch (err: any) {
    return NextResponse.json(
      { error: 'Internal Server Error', message: err.message },
      { status: 500, headers: corsHeaders }
    );
  }
}
