import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { addServiceLog } from '@/lib/service-logs';
import { abortS3MultipartUpload, deleteS3Object } from '@/lib/s3';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key, x-user-id',
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

/**
 * GET /api/files?userId=<uuid>&orgId=<uuid>
 * Lists files belonging to the authenticated organization (optionally filtered by userId).
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const validatedOrgId = req.headers.get('x-validated-org-id');
  const queryOrgId = searchParams.get('orgId') || validatedOrgId;
  const queryUserId = searchParams.get('userId');

  if (validatedOrgId && queryOrgId && queryOrgId !== validatedOrgId) {
    return NextResponse.json(
      { error: 'Forbidden', code: 'FORBIDDEN_TENANT_MISMATCH', message: 'La llave API pertenece a otra organización.' },
      { status: 403, headers: corsHeaders }
    );
  }

  let query = supabase
    .from('files')
    .select('*')
    .order('created_at', { ascending: false });

  if (queryOrgId) {
    query = query.eq('org_id', queryOrgId);
  }
  if (queryUserId) {
    query = query.eq('user_id', queryUserId);
  }

  const { data: files, error } = await query;
  if (error) {
    return NextResponse.json(
      { error: 'Database Error', message: error.message },
      { status: 500, headers: corsHeaders }
    );
  }

  return NextResponse.json(
    {
      status: 'success',
      count: (files || []).length,
      files: files || [],
    },
    { status: 200, headers: corsHeaders }
  );
}

/**
 * DELETE /api/files?userId=<uuid> OR DELETE /api/files?orgId=<uuid>&confirmOrgWipe=true
 * Task B.10: Derecho de Eliminación (Right to Erasure) — Borrado completo de todos los archivos
 * de un usuario (userId) o de una organización entera (orgId), eliminando tanto s3_pending_key
 * como s3_processed_key y abortando cualquier subida multipart activa.
 */
export async function DELETE(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const validatedOrgId = req.headers.get('x-validated-org-id');
    const validatedUserId = req.headers.get('x-validated-user-id');
    const ipAddress = req.headers.get('x-forwarded-for') || '127.0.0.1';

    let body: any = {};
    try {
      body = await req.json();
    } catch {
      body = {};
    }

    const targetUserId = (searchParams.get('userId') || body.userId || '').trim();
    const targetOrgId = (searchParams.get('orgId') || body.orgId || validatedOrgId || '').trim();
    const confirmOrgWipe =
      searchParams.get('confirmOrgWipe') === 'true' || body.confirmOrgWipe === true;
    const excludeIdsRaw = searchParams.get('excludeFileIds') || body.excludeFileIds || '';
    const excludeFileIds = new Set(
      (Array.isArray(excludeIdsRaw) ? excludeIdsRaw : String(excludeIdsRaw).split(','))
        .map((s) => String(s).trim())
        .filter(Boolean)
    );

    if (!targetOrgId) {
      return NextResponse.json(
        {
          error: 'Bad Request',
          code: 'MISSING_ORG_ID',
          message: 'Se requiere identificar la organización (orgId) para ejecutar el borrado masivo.',
        },
        { status: 400, headers: corsHeaders }
      );
    }

    if (validatedOrgId && targetOrgId !== validatedOrgId) {
      return NextResponse.json(
        {
          error: 'Forbidden',
          code: 'FORBIDDEN_TENANT_MISMATCH',
          message: 'Acceso Denegado: No puedes borrar archivos de otra organización.',
        },
        { status: 403, headers: corsHeaders }
      );
    }

    if (!targetUserId && !confirmOrgWipe) {
      return NextResponse.json(
        {
          error: 'Bad Request',
          code: 'MISSING_ERASURE_SCOPE',
          message:
            'Para derecho de eliminación (Tarea B.10), indica ?userId=<uuid> para borrar todos los archivos de un usuario, o ?orgId=<uuid>&confirmOrgWipe=true para borrar toda la organización.',
        },
        { status: 400, headers: corsHeaders }
      );
    }

    let query = supabase.from('files').select('*').eq('org_id', targetOrgId);
    if (targetUserId) {
      query = query.eq('user_id', targetUserId);
    }

    const { data: filesToDelete, error: fetchErr } = await query;
    if (fetchErr) {
      return NextResponse.json(
        { error: 'Database Error', message: fetchErr.message },
        { status: 500, headers: corsHeaders }
      );
    }

    const filteredFiles = (filesToDelete || []).filter((f) => !excludeFileIds.has(f.id));
    const deletedFileIds: string[] = [];
    const deletedS3Keys: string[] = [];
    let abortedMultiparts = 0;

    for (const fileRow of filteredFiles) {
      // 1. Abort multipart upload if active
      if (fileRow.s3_upload_id && fileRow.s3_pending_key) {
        try {
          await abortS3MultipartUpload(fileRow.s3_pending_key, fileRow.s3_upload_id);
          abortedMultiparts++;
        } catch {}
      }

      // 2. Delete both s3_pending_key and s3_processed_key from S3
      const keys = Array.from(
        new Set([fileRow.s3_pending_key, fileRow.s3_processed_key].filter(Boolean))
      ) as string[];

      for (const k of keys) {
        try {
          await deleteS3Object(k);
          deletedS3Keys.push(k);
        } catch (s3Err: any) {
          console.warn(`Error eliminando clave S3 '${k}':`, s3Err.message);
        }
      }

      // 3. Delete row from public.files
      const { error: delRowErr } = await supabase.from('files').delete().eq('id', fileRow.id);
      if (!delRowErr) {
        deletedFileIds.push(fileRow.id);
      }
    }

    const scopeLabel = targetUserId
      ? `user_id='${targetUserId}' en org_id='${targetOrgId}'`
      : `org_id='${targetOrgId}' (organización completa)`;

    await addServiceLog({
      method: 'DELETE',
      action: 'BULK_FILES_DELETED',
      status: 'ALLOWED',
      userId: validatedUserId || targetUserId || undefined,
      orgId: targetOrgId,
      ipAddress,
      message: `Derecho de eliminación ejecutado para ${scopeLabel}: ${deletedFileIds.length} archivos borrados de DB, ${deletedS3Keys.length} claves borradas de S3 y ${abortedMultiparts} multiparts abortados.`,
    });

    return NextResponse.json(
      {
        status: 'success',
        action: 'right_to_erasure',
        scope: targetUserId ? 'user' : 'organization',
        orgId: targetOrgId,
        userId: targetUserId || null,
        deletedFilesCount: deletedFileIds.length,
        deletedFileIds,
        deletedS3KeysCount: deletedS3Keys.length,
        deletedS3Keys,
        abortedMultiparts,
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
