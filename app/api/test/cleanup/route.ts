import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { addServiceLog } from '@/lib/service-logs';
import { deleteS3ObjectsByPrefix, deleteS3ObjectsByKeys } from '@/lib/s3';
import { verifyAdminSecretHeader } from '@/lib/env';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'DELETE, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-admin-secret',
  'X-Content-Type-Options': 'nosniff',
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

export async function DELETE(req: NextRequest) {
  return handleCleanup(req);
}

export async function POST(req: NextRequest) {
  return handleCleanup(req);
}

async function handleCleanup(req: NextRequest) {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json(
      {
        error: 'Forbidden',
        code: 'ENDPOINT_DISABLED_IN_PRODUCTION',
        message: 'El endpoint /api/test/cleanup está deshabilitado permanentemente en producción.',
      },
      { status: 403, headers: corsHeaders }
    );
  }

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

  try {
    const { searchParams } = new URL(req.url);
    const userId = searchParams.get('userId') || undefined;
    const orgId = searchParams.get('orgId') || undefined;

    let selectQuery = supabase
      .from('files')
      .select('id, s3_pending_key, s3_processed_key, user_id, org_id');

    if (userId) {
      selectQuery = selectQuery.eq('user_id', userId);
    }
    if (orgId) {
      selectQuery = selectQuery.eq('org_id', orgId);
    }

    const { data: records } = await selectQuery;
    const keysToDelete: string[] = [];

    if (records && records.length > 0) {
      for (const r of records) {
        if (r.s3_pending_key) keysToDelete.push(r.s3_pending_key);
        if (r.s3_processed_key) keysToDelete.push(r.s3_processed_key);
      }
    }

    let s3Result = { count: 0, keys: [] as string[] };
    if (keysToDelete.length > 0) {
      try {
        s3Result = await deleteS3ObjectsByKeys(keysToDelete);
      } catch (e) {
        console.warn('Error eliminando objetos S3 por keys en cleanup:', e);
      }
    }

    if (userId) {
      try {
        const prefixRes = await deleteS3ObjectsByPrefix(`static/pending/${userId}/`);
        s3Result.count += prefixRes.count;
        s3Result.keys.push(...prefixRes.keys);
      } catch (e) {
        console.warn('Error eliminando prefijo S3 en cleanup:', e);
      }
    }

    let deleteDbQuery = supabase.from('files').delete();
    if (userId) {
      deleteDbQuery = deleteDbQuery.eq('user_id', userId);
    } else if (orgId) {
      deleteDbQuery = deleteDbQuery.eq('org_id', orgId);
    } else {
      deleteDbQuery = deleteDbQuery.neq('id', '00000000-0000-0000-0000-000000000000');
    }

    const { error: dbDeleteError } = await deleteDbQuery;

    if (dbDeleteError) {
      return NextResponse.json(
        { error: 'Error al limpiar registros en Supabase', details: dbDeleteError.message },
        { status: 500, headers: corsHeaders }
      );
    }

    await addServiceLog({
      method: 'DELETE',
      action: 'TEST_CLEANUP_EXECUTED',
      status: 'ALLOWED',
      userId,
      orgId,
      message: `Limpieza de pruebas completada (dev): ${records?.length || 0} registro(s) en DB y ${s3Result.count} objeto(s) en S3 eliminados.`,
    });

    return NextResponse.json(
      {
        status: 'cleaned',
        dbDeletedCount: records?.length || 0,
        s3DeletedCount: s3Result.count,
        message: 'Entorno de pruebas limpiado exitosamente (Base de datos + AWS S3).',
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
