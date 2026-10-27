import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { supabase } from '@/lib/supabase';
import { addServiceLog } from '@/lib/service-logs';
import {
  validateAllowedFileType,
  generateOpaqueS3Key,
  createS3MultipartUpload,
  generatePresignedUploadPartUrl,
  listS3UploadedParts,
  completeS3MultipartUpload,
  abortS3MultipartUpload,
  headS3Object,
  deleteS3Object,
  getS3ObjectRangeBytes,
} from '@/lib/s3';
import { generateTicketConfirmToken, verifyTicketConfirmToken } from '@/lib/ticket-token';
import { getBaseCloudFrontUrl } from '@/lib/cloudfront';
import { detectMagicBytesMime } from '@/lib/magic-bytes';
import { processUpload, ENABLE_SERVER_PROCESSING_FALLBACK } from '@/lib/lambda-fallback/process-upload';
import { dispatchFileWebhook, processPendingWebhookDeliveries } from '@/lib/lambda-fallback/webhook-dispatcher';
import { checkOrganizationQuotas } from '@/lib/quotas';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key, x-user-id',
};

// Maximum multipart upload size: 500 MB
const MAX_MULTIPART_UPLOAD_BYTES = 500 * 1024 * 1024;

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

/**
 * GET /api/upload/multipart?ticketId=<uuid> (or ?fileId=<uuid>)
 * Task B.9: Lists already uploaded parts for an active S3 Multipart Upload so clients can resume.
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const ticketId = searchParams.get('ticketId');
  const fileId = searchParams.get('fileId');
  const validatedOrgId = req.headers.get('x-validated-org-id');
  const validatedUserId = req.headers.get('x-validated-user-id');

  if (!ticketId && !fileId) {
    return NextResponse.json(
      {
        error: 'Bad Request',
        code: 'MISSING_IDENTIFIER',
        message: 'Se requiere ticketId o fileId en los parámetros de consulta para listar partes.',
      },
      { status: 400, headers: corsHeaders }
    );
  }

  let query = supabase.from('files').select('*');
  if (ticketId) {
    query = query.eq('ticket_id', ticketId);
  } else if (fileId) {
    query = query.eq('id', fileId);
  }

  const { data: fileRow, error } = await query.maybeSingle();
  if (error || !fileRow) {
    return NextResponse.json(
      { error: 'Not Found', code: 'MULTIPART_TICKET_NOT_FOUND', message: 'No se encontró el ticket multipart.' },
      { status: 404, headers: corsHeaders }
    );
  }

  if (validatedOrgId && fileRow.org_id !== validatedOrgId) {
    return NextResponse.json(
      { error: 'Forbidden', code: 'FORBIDDEN_TENANT_MISMATCH', message: 'El ticket pertenece a otra organización.' },
      { status: 403, headers: corsHeaders }
    );
  }

  if (validatedUserId && fileRow.user_id !== validatedUserId) {
    return NextResponse.json(
      { error: 'Forbidden', code: 'FORBIDDEN_NOT_OWNER', message: 'El ticket multipart pertenece a otro usuario.' },
      { status: 403, headers: corsHeaders }
    );
  }

  if (!fileRow.s3_upload_id || !fileRow.s3_pending_key) {
    return NextResponse.json(
      {
        error: 'Bad Request',
        code: 'NO_ACTIVE_MULTIPART_UPLOAD',
        message: 'Este registro no tiene un s3_upload_id activo para listar partes.',
        status: fileRow.status,
      },
      { status: 400, headers: corsHeaders }
    );
  }

  try {
    const parts = await listS3UploadedParts(fileRow.s3_pending_key, fileRow.s3_upload_id);
    const totalUploadedBytes = parts.reduce((acc, p) => acc + (p.Size || 0), 0);

    return NextResponse.json(
      {
        status: 'success',
        action: 'list_parts',
        ticketId: fileRow.ticket_id,
        fileId: fileRow.id,
        uploadId: fileRow.s3_upload_id,
        declaredSizeBytes: Number(fileRow.size_bytes || 0),
        totalUploadedBytes,
        partsCount: parts.length,
        parts,
      },
      { status: 200, headers: corsHeaders }
    );
  } catch (err: any) {
    return NextResponse.json(
      {
        error: 'S3 ListParts Error',
        code: 'S3_LIST_PARTS_FAILED',
        message: err.message || 'No se pudieron listar las partes en S3.',
      },
      { status: 500, headers: corsHeaders }
    );
  }
}

/**
 * POST /api/upload/multipart
 * Task B.9: Handles:
 *  - action: "create" (default) -> Initiates S3 Multipart Upload & creates DB ticket with s3_upload_id
 *  - action: "presign_part" -> Generates Presigned PUT URL for a specific partNumber (1..10000) on demand
 *  - action: "complete" -> Completes S3 Multipart Upload, verifies with HeadObject, and runs processUpload(fileId)
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const action = String(body.action || 'create').toLowerCase().trim();

    if (action === 'presign_part') {
      return handlePresignPart(req, body);
    }
    if (action === 'complete') {
      return handleCompleteMultipart(req, body);
    }
    return handleCreateMultipart(req, body);
  } catch (err: any) {
    return NextResponse.json(
      { error: 'Internal Server Error', code: 'MULTIPART_POST_ERROR', message: err.message },
      { status: 500, headers: corsHeaders }
    );
  }
}

/**
 * PUT /api/upload/multipart
 * Alias for action: "complete" to mirror PUT /api/upload.
 */
export async function PUT(req: NextRequest) {
  try {
    const body = await req.json();
    return handleCompleteMultipart(req, body);
  } catch (err: any) {
    return NextResponse.json(
      { error: 'Internal Server Error', code: 'MULTIPART_PUT_ERROR', message: err.message },
      { status: 500, headers: corsHeaders }
    );
  }
}

/**
 * DELETE /api/upload/multipart?ticketId=<uuid> (or ?fileId=<uuid>)
 * Task B.9: Aborts an active S3 Multipart Upload using AbortMultipartUploadCommand.
 */
export async function DELETE(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const ticketId = searchParams.get('ticketId');
  const fileId = searchParams.get('fileId');
  const deleteRow = searchParams.get('deleteRow') === 'true';
  const validatedOrgId = req.headers.get('x-validated-org-id');
  const validatedUserId = req.headers.get('x-validated-user-id');
  const ipAddress = req.headers.get('x-forwarded-for') || '127.0.0.1';

  if (!ticketId && !fileId) {
    return NextResponse.json(
      {
        error: 'Bad Request',
        code: 'MISSING_IDENTIFIER',
        message: 'Se requiere ticketId o fileId para abortar la subida multipart.',
      },
      { status: 400, headers: corsHeaders }
    );
  }

  let query = supabase.from('files').select('*');
  if (ticketId) {
    query = query.eq('ticket_id', ticketId);
  } else if (fileId) {
    query = query.eq('id', fileId);
  }

  const { data: fileRow, error } = await query.maybeSingle();
  if (error || !fileRow) {
    return NextResponse.json(
      { error: 'Not Found', code: 'MULTIPART_TICKET_NOT_FOUND', message: 'No se encontró el ticket multipart.' },
      { status: 404, headers: corsHeaders }
    );
  }

  if (validatedOrgId && fileRow.org_id !== validatedOrgId) {
    return NextResponse.json(
      { error: 'Forbidden', code: 'FORBIDDEN_TENANT_MISMATCH', message: 'El ticket pertenece a otra organización.' },
      { status: 403, headers: corsHeaders }
    );
  }

  if (validatedUserId && fileRow.user_id !== validatedUserId) {
    return NextResponse.json(
      { error: 'Forbidden', code: 'FORBIDDEN_NOT_OWNER', message: 'El ticket multipart pertenece a otro usuario.' },
      { status: 403, headers: corsHeaders }
    );
  }

  let s3Aborted = false;
  if (fileRow.s3_upload_id && fileRow.s3_pending_key) {
    try {
      await abortS3MultipartUpload(fileRow.s3_pending_key, fileRow.s3_upload_id);
      s3Aborted = true;
    } catch (abortErr: any) {
      console.error('Error en AbortMultipartUploadCommand:', abortErr.message);
    }
  }

  if (fileRow.s3_pending_key) {
    try {
      await deleteS3Object(fileRow.s3_pending_key);
    } catch {}
  }

  if (deleteRow) {
    await supabase.from('files').delete().eq('id', fileRow.id);
  } else {
    await supabase
      .from('files')
      .update({
        status: 'failed',
        s3_upload_id: null,
        error_message: 'Multipart upload abortado explícitamente por el cliente.',
        updated_at: new Date().toISOString(),
      })
      .eq('id', fileRow.id);
  }

  await addServiceLog({
    method: 'DELETE',
    action: 'MULTIPART_UPLOAD_ABORTED',
    status: 'ABORTED',
    userId: fileRow.user_id,
    orgId: fileRow.org_id,
    ticketId: fileRow.ticket_id,
    fileId: fileRow.status && !deleteRow ? fileRow.id : undefined,
    fileName: fileRow.original_name,
    ipAddress,
    message: `Subida multipart abortada (uploadId='${fileRow.s3_upload_id}', s3Aborted=${s3Aborted}, deleteRow=${deleteRow}).`,
  });

  return NextResponse.json(
    {
      status: 'success',
      action: 'abort',
      ticketId: fileRow.ticket_id,
      fileId: fileRow.id,
      uploadIdAborted: fileRow.s3_upload_id,
      s3Aborted,
      rowDeleted: deleteRow,
    },
    { status: 200, headers: corsHeaders }
  );
}

// ============================================================================
// HANDLER 1: CREATE MULTIPART UPLOAD
// ============================================================================
async function handleCreateMultipart(req: NextRequest, body: any) {
  const {
    fileName = 'file.png',
    fileType = 'image/png',
    fileSize = 0,
    visibility = 'private',
  } = body;

  // Section 3 (Option A): Ignore userId and orgId from the request body.
  // Take both strictly from the middleware-validated context headers.
  const orgId = (req.headers.get('x-validated-org-id') || '').trim();
  const userId = (req.headers.get('x-validated-user-id') || '').trim();
  const ipAddress = req.headers.get('x-forwarded-for') || '127.0.0.1';

  if (!orgId) {
    return NextResponse.json(
      {
        error: 'Unauthorized',
        code: 'MISSING_VALIDATED_ORG',
        message: 'Contexto de organización no validado. Envía una API Key válida en x-api-key.',
      },
      { status: 401, headers: corsHeaders }
    );
  }

  if (!userId) {
    return NextResponse.json(
      {
        error: 'Bad Request',
        code: 'MISSING_END_USER_ID',
        message:
          'El backend debe enviar el UUID del usuario final en la cabecera x-user-id (o usar una llave vinculada a un usuario). Se ignoran userId y orgId del cuerpo.',
      },
      { status: 400, headers: corsHeaders }
    );
  }

  // Validate whitelist (Task A.4)
  const typeValidation = validateAllowedFileType(fileName, fileType);
  if (!typeValidation.valid) {
    return NextResponse.json(
      {
        error: 'Bad Request',
        code: typeValidation.code,
        message: typeValidation.message,
      },
      { status: 400, headers: corsHeaders }
    );
  }

  const numericSize = Number(fileSize);
  if (!Number.isFinite(numericSize) || numericSize <= 0) {
    return NextResponse.json(
      {
        error: 'Bad Request',
        code: 'INVALID_FILE_SIZE',
        message: 'Debes declarar un fileSize entero positivo.',
      },
      { status: 400, headers: corsHeaders }
    );
  }

  if (numericSize > MAX_MULTIPART_UPLOAD_BYTES) {
    return NextResponse.json(
      {
        error: 'Payload Too Large',
        code: 'MULTIPART_SIZE_EXCEEDS_LIMIT',
        message: `El tamaño declarado (${numericSize} bytes) supera el límite máximo multipart de ${MAX_MULTIPART_UPLOAD_BYTES} bytes.`,
      },
      { status: 413, headers: corsHeaders }
    );
  }

  // Verify user belongs to org and has can_upload
  const { data: userRow, error: userErr } = await supabase
    .from('users')
    .select('id, org_id, can_upload, role')
    .eq('id', userId)
    .maybeSingle();

  if (userErr || !userRow || userRow.org_id !== orgId || !userRow.can_upload) {
    return NextResponse.json(
      {
        error: 'Forbidden',
        code: 'FORBIDDEN_UPLOAD_PERMISSION',
        message: 'Usuario no válido o sin permiso de subida en la organización.',
      },
      { status: 403, headers: corsHeaders }
    );
  }

  const normalizedVisibility: 'private' | 'public' =
    String(visibility).toLowerCase() === 'public' ? 'public' : 'private';
  const ext = typeValidation.extension || '.bin';
  const normalizedMime = typeValidation.mimeType || fileType;
  // ============================================================================
  // [TEMPORARY-LAMBDA-FALLBACK: OPPORTUNISTIC-TICKET-CLEANUP]
  // Limpieza de tickets vencidos antes de evaluar cuotas para liberar cupo
  // ============================================================================
  try {
    const nowIso = new Date().toISOString();
    const { data: expiredBatch } = await supabase
      .from('files')
      .select('id, s3_pending_key, expires_at')
      .eq('org_id', orgId)
      .eq('status', 'pending_upload')
      .lt('expires_at', nowIso)
      .limit(3);

    if (expiredBatch && expiredBatch.length > 0) {
      for (const exp of expiredBatch) {
        if (exp.s3_pending_key) {
          let s3Deleted = false;
          try {
            await deleteS3Object(exp.s3_pending_key);
            s3Deleted = true;
          } catch (err: any) {
            console.warn('[TEMPORARY-LAMBDA-FALLBACK] Error borrando S3 en limpieza oportunista multipart:', err.message);
          }
          if (s3Deleted) {
            await supabase.from('files').delete().eq('id', exp.id);
          }
        }
      }
    }
  } catch (e: any) {
    console.warn('[TEMPORARY-LAMBDA-FALLBACK] Limpieza oportunista multipart ignorada:', e.message);
  }

  // Task B.13: Check organization quotas before initiating multipart upload
  const quotaCheck = await checkOrganizationQuotas(orgId, numericSize, {
    overrideMaxStorageBytes:
      body.testMaxStorageBytes !== undefined ? Number(body.testMaxStorageBytes) : undefined,
    overrideMaxPendingTickets:
      body.testMaxPendingTickets !== undefined ? Number(body.testMaxPendingTickets) : undefined,
  });

  if (!quotaCheck.allowed) {
    return NextResponse.json(
      {
        error: quotaCheck.httpStatus === 429 ? 'Too Many Requests' : 'Payload Too Large',
        code: quotaCheck.code,
        message: quotaCheck.message,
        quotaUsage: quotaCheck.usage,
      },
      { status: quotaCheck.httpStatus || 429, headers: corsHeaders }
    );
  }

  const ticketId = crypto.randomUUID();
  const s3FolderPrefix = normalizedVisibility === 'private' ? 'static/private' : 'static/files';
  const pendingKey = generateOpaqueS3Key(s3FolderPrefix, ext);

  const { uploadId, cacheControl, contentDisposition } = await createS3MultipartUpload({
    key: pendingKey,
    contentType: normalizedMime,
    visibility: normalizedVisibility,
    extension: ext,
  });

  const { data: insertedFile, error: insertError } = await supabase
    .from('files')
    .insert({
      ticket_id: ticketId,
      org_id: orgId,
      user_id: userId,
      original_name: fileName,
      extension: ext,
      mime_type: normalizedMime,
      size_bytes: numericSize,
      resource_type: typeValidation.resourceType,
      visibility: normalizedVisibility,
      s3_pending_key: pendingKey,
      s3_processed_key: null,
      s3_upload_id: uploadId,
      cloudfront_url: null,
      scan_status: 'not_scanned',
      status: 'pending_upload',
    })
    .select('id, ticket_id, status, scan_status, created_at')
    .single();

  if (insertError || !insertedFile) {
    try {
      await abortS3MultipartUpload(pendingKey, uploadId);
    } catch {}
    return NextResponse.json(
      { error: 'Database Error', message: insertError?.message || 'No se pudo registrar el ticket multipart.' },
      { status: 500, headers: corsHeaders }
    );
  }

  // Confirm token valid for 60 minutes (3600 seconds) for multipart uploads
  const expiresAtIso = new Date(Date.now() + 3600 * 1000).toISOString();
  const confirmToken = generateTicketConfirmToken(ticketId, userId, expiresAtIso);

  await addServiceLog({
    method: 'POST',
    action: 'MULTIPART_UPLOAD_INITIATED',
    status: 'ALLOWED',
    userId,
    orgId,
    ticketId,
    fileId: insertedFile.id,
    fileName,
    ipAddress,
    message: `Subida multipart iniciada (uploadId='${uploadId}', size=${numericSize} bytes, visibility=${normalizedVisibility}).`,
  });

  return NextResponse.json(
    {
      status: 'success',
      action: 'create',
      ticketId,
      fileId: insertedFile.id,
      uploadId,
      visibility: normalizedVisibility,
      cacheControl,
      contentDisposition,
      confirmToken,
      expiresInSeconds: 3600,
      minPartSizeBytes: 5 * 1024 * 1024,
    },
    { status: 200, headers: corsHeaders }
  );
}

// ============================================================================
// HANDLER 2: PRESIGN PART URL ON DEMAND
// ============================================================================
async function handlePresignPart(req: NextRequest, body: any) {
  const { ticketId, fileId, partNumber } = body;
  const validatedOrgId = req.headers.get('x-validated-org-id');
  const validatedUserId = req.headers.get('x-validated-user-id');

  const numPart = Number(partNumber);
  if (!Number.isInteger(numPart) || numPart < 1 || numPart > 10000) {
    return NextResponse.json(
      {
        error: 'Bad Request',
        code: 'INVALID_PART_NUMBER',
        message: 'partNumber debe ser un entero entre 1 y 10000.',
      },
      { status: 400, headers: corsHeaders }
    );
  }

  if (!ticketId && !fileId) {
    return NextResponse.json(
      { error: 'Bad Request', code: 'MISSING_IDENTIFIER', message: 'Se requiere ticketId o fileId.' },
      { status: 400, headers: corsHeaders }
    );
  }

  let query = supabase.from('files').select('*');
  if (ticketId) {
    query = query.eq('ticket_id', ticketId);
  } else {
    query = query.eq('id', fileId);
  }

  const { data: fileRow, error } = await query.maybeSingle();
  if (error || !fileRow) {
    return NextResponse.json(
      { error: 'Not Found', code: 'MULTIPART_TICKET_NOT_FOUND', message: 'Ticket multipart no encontrado.' },
      { status: 404, headers: corsHeaders }
    );
  }

  if (validatedOrgId && fileRow.org_id !== validatedOrgId) {
    return NextResponse.json(
      { error: 'Forbidden', code: 'FORBIDDEN_TENANT_MISMATCH', message: 'El ticket pertenece a otra organización.' },
      { status: 403, headers: corsHeaders }
    );
  }

  if (validatedUserId && fileRow.user_id !== validatedUserId) {
    return NextResponse.json(
      { error: 'Forbidden', code: 'FORBIDDEN_NOT_OWNER', message: 'El ticket multipart pertenece a otro usuario.' },
      { status: 403, headers: corsHeaders }
    );
  }

  if (!fileRow.s3_upload_id || !fileRow.s3_pending_key) {
    return NextResponse.json(
      {
        error: 'Bad Request',
        code: 'NO_ACTIVE_MULTIPART_UPLOAD',
        message: 'El registro no tiene un s3_upload_id activo.',
      },
      { status: 400, headers: corsHeaders }
    );
  }

  const uploadPartUrl = await generatePresignedUploadPartUrl(
    fileRow.s3_pending_key,
    fileRow.s3_upload_id,
    numPart,
    900
  );

  return NextResponse.json(
    {
      status: 'success',
      action: 'presign_part',
      ticketId: fileRow.ticket_id,
      fileId: fileRow.id,
      uploadId: fileRow.s3_upload_id,
      partNumber: numPart,
      uploadPartUrl,
      expiresInSeconds: 900,
    },
    { status: 200, headers: corsHeaders }
  );
}

// ============================================================================
// HANDLER 3: COMPLETE MULTIPART UPLOAD + HEADOBJECT + processUpload(fileId)
// ============================================================================
async function handleCompleteMultipart(req: NextRequest, body: any) {
  const { searchParams } = new URL(req.url);
  const ticketId = body.ticketId || searchParams.get('ticketId');
  const fileId = body.fileId || searchParams.get('fileId');
  const confirmToken = body.confirmToken || searchParams.get('token');
  const validatedOrgId = req.headers.get('x-validated-org-id');
  const validatedUserId = req.headers.get('x-validated-user-id');
  const ipAddress = req.headers.get('x-forwarded-for') || '127.0.0.1';

  if (!ticketId && !fileId) {
    return NextResponse.json(
      { error: 'Bad Request', code: 'MISSING_IDENTIFIER', message: 'Se requiere ticketId o fileId para completar.' },
      { status: 400, headers: corsHeaders }
    );
  }

  if (!confirmToken) {
    return NextResponse.json(
      {
        error: 'Bad Request',
        code: 'MISSING_CONFIRM_TOKEN',
        message: 'El campo confirmToken es obligatorio para completar una subida multipart.',
      },
      { status: 400, headers: corsHeaders }
    );
  }

  let query = supabase.from('files').select('*');
  if (ticketId) {
    query = query.eq('ticket_id', ticketId);
  } else {
    query = query.eq('id', fileId);
  }

  const { data: fileRow, error } = await query.maybeSingle();
  if (error || !fileRow) {
    return NextResponse.json(
      { error: 'Not Found', code: 'MULTIPART_TICKET_NOT_FOUND', message: 'Ticket multipart no encontrado.' },
      { status: 404, headers: corsHeaders }
    );
  }

  if (validatedOrgId && fileRow.org_id !== validatedOrgId) {
    return NextResponse.json(
      { error: 'Forbidden', code: 'FORBIDDEN_TENANT_MISMATCH', message: 'El ticket pertenece a otra organización.' },
      { status: 403, headers: corsHeaders }
    );
  }

  if (validatedUserId && fileRow.user_id !== validatedUserId) {
    return NextResponse.json(
      { error: 'Forbidden', code: 'FORBIDDEN_NOT_OWNER', message: 'El ticket multipart pertenece a otro usuario.' },
      { status: 403, headers: corsHeaders }
    );
  }

  const tokenResult = verifyTicketConfirmToken(confirmToken, fileRow.ticket_id, fileRow.user_id);
  if (!tokenResult.valid) {
    return NextResponse.json(
      {
        error: 'Forbidden',
        code: 'INVALID_CONFIRM_TOKEN',
        message: `Token de confirmación inválido: ${tokenResult.reason}`,
      },
      { status: 403, headers: corsHeaders }
    );
  }

  if (!fileRow.s3_upload_id || !fileRow.s3_pending_key) {
    return NextResponse.json(
      {
        error: 'Bad Request',
        code: 'NO_ACTIVE_MULTIPART_UPLOAD',
        message: 'Este ticket no tiene un s3_upload_id activo para completar.',
      },
      { status: 400, headers: corsHeaders }
    );
  }

  // Obtain parts from client body or automatically via ListPartsCommand
  let partsToComplete: Array<{ PartNumber: number; ETag: string }> = Array.isArray(body.parts)
    ? body.parts
    : [];

  if (partsToComplete.length === 0) {
    const listedParts = await listS3UploadedParts(fileRow.s3_pending_key, fileRow.s3_upload_id);
    partsToComplete = listedParts.map((p) => ({
      PartNumber: p.PartNumber,
      ETag: p.ETag,
    }));
  }

  if (partsToComplete.length === 0) {
    return NextResponse.json(
      {
        error: 'Bad Request',
        code: 'NO_PARTS_UPLOADED',
        message: 'No se encontraron partes subidas en S3 para completar el Multipart Upload.',
      },
      { status: 400, headers: corsHeaders }
    );
  }

  // 1. Complete Multipart Upload in S3
  await completeS3MultipartUpload(fileRow.s3_pending_key, fileRow.s3_upload_id, partsToComplete);

  // 2. Verify with HeadObjectCommand (Task A.5)
  const headMeta = await headS3Object(fileRow.s3_pending_key);
  if (!headMeta.exists) {
    return NextResponse.json(
      {
        error: 'Bad Request',
        code: 'FILE_NOT_FOUND_AFTER_COMPLETE',
        message: 'El objeto ensamblado no fue encontrado en S3 tras CompleteMultipartUpload.',
      },
      { status: 400, headers: corsHeaders }
    );
  }

  const declaredSize = Number(fileRow.size_bytes);
  const actualSize = Number(headMeta.contentLength ?? -1);
  if (declaredSize > 0 && actualSize !== declaredSize) {
    await deleteS3Object(fileRow.s3_pending_key);
    await supabase
      .from('files')
      .update({
        status: 'failed',
        s3_upload_id: null,
        error_message: `Tamaño ensamblado (${actualSize} bytes) no coincide con el declarado (${declaredSize} bytes).`,
        updated_at: new Date().toISOString(),
      })
      .eq('id', fileRow.id);

    return NextResponse.json(
      {
        error: 'Bad Request',
        code: 'MULTIPART_SIZE_MISMATCH',
        message: `El tamaño ensamblado (${actualSize} bytes) difiere del declarado (${declaredSize} bytes). Objeto eliminado.`,
      },
      { status: 400, headers: corsHeaders }
    );
  }

  // 3. Verify real binary format with 32-byte Range GET (Zero full file download)
  const rangeBytes = await getS3ObjectRangeBytes(fileRow.s3_pending_key, 0, 31);
  if (!rangeBytes || rangeBytes.length < 4) {
    try {
      await deleteS3Object(fileRow.s3_pending_key);
    } catch {}
    await supabase
      .from('files')
      .update({
        status: 'failed',
        s3_upload_id: null,
        error_message: 'No se pudieron leer los primeros bytes del objeto ensamblado para verificar cabecera binaria.',
        updated_at: new Date().toISOString(),
      })
      .eq('id', fileRow.id);

    return NextResponse.json(
      {
        error: 'Bad Request',
        code: 'INVALID_FILE_HEADER',
        message: 'No se pudieron leer los primeros bytes del archivo ensamblado en S3.',
      },
      { status: 400, headers: corsHeaders }
    );
  }

  const declaredMime = String(fileRow.mime_type || '').toLowerCase().trim();
  const detectedMagicMime = detectMagicBytesMime(rangeBytes);
  if (!detectedMagicMime || detectedMagicMime !== declaredMime) {
    try {
      await deleteS3Object(fileRow.s3_pending_key);
    } catch {}
    const magicMismatch = `Cabecera binaria inválida: detectado '${detectedMagicMime || 'desconocido'}' no coincide con declarado '${declaredMime}'.`;
    await supabase
      .from('files')
      .update({
        status: 'failed',
        s3_upload_id: null,
        error_message: magicMismatch,
        updated_at: new Date().toISOString(),
      })
      .eq('id', fileRow.id);

    return NextResponse.json(
      {
        error: 'Unprocessable Entity',
        code: 'MAGIC_BYTES_MISMATCH',
        message: magicMismatch,
        detectedMime: detectedMagicMime,
        declaredMime,
      },
      { status: 422, headers: corsHeaders }
    );
  }

  // 4. [TEST-ONLY: TASK-B6-MULTIPART-TRIGGER]
  if (ENABLE_SERVER_PROCESSING_FALLBACK) {
    const processResult = await processUpload(fileRow.id, {
      triggerSource: 'multipart_complete',
      ipAddress,
    });

    if (!processResult.success) {
      return NextResponse.json(
        {
          error: 'Bad Request',
          code: processResult.code || 'PROCESS_UPLOAD_FAILED',
          message: processResult.message,
          ticketId: fileRow.ticket_id,
          fileId: fileRow.id,
          processing: processResult,
        },
        { status: 400, headers: corsHeaders }
      );
    }

    return NextResponse.json(
      {
        status: 'success',
        action: 'complete',
        ticketId: fileRow.ticket_id,
        fileId: fileRow.id,
        fileStatus: 'uploaded',
        scanStatus: processResult.scanStatus,
        visibility: fileRow.visibility,
        partsCompleted: partsToComplete.length,
        cloudfrontUrl: fileRow.visibility === 'public' ? processResult.cloudfrontUrl : null,
        processing: {
          executed: true,
          exifStripped: processResult.exifStripped,
          detectedMime: processResult.detectedMimeType,
          originalSizeBytes: processResult.originalSizeBytes,
          processedSizeBytes: processResult.processedSizeBytes,
          sha256Hash: processResult.sha256Hash,
        },
        webhook: processResult.webhook,
      },
      { status: 200, headers: corsHeaders }
    );
  }

  // 5. PRODUCTION FLOW: Direct storage without server processing
  const publicCfUrl =
    fileRow.visibility === 'public'
      ? getBaseCloudFrontUrl(fileRow.s3_pending_key)
      : null;

  const isChecksumVerified = Boolean(fileRow.sha256_hash && headMeta.checksumSHA256);

  await supabase
    .from('files')
    .update({
      s3_upload_id: null,
      size_bytes: actualSize,
      status: 'uploaded',
      scan_status: 'not_scanned',
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      cloudfront_url: publicCfUrl,
      s3_processed_key: fileRow.s3_pending_key,
      sha256_verified: isChecksumVerified,
    })
    .eq('id', fileRow.id);

  await addServiceLog({
    method: req.method,
    action: 'MULTIPART_UPLOAD_CONFIRMED',
    status: 'UPLOADED',
    userId: fileRow.user_id,
    orgId: fileRow.org_id,
    ticketId: fileRow.ticket_id,
    fileId: fileRow.id,
    fileName: fileRow.original_name,
    ipAddress,
    message: `Multipart upload completado: status='uploaded', scan_status='not_scanned', parts=${partsToComplete.length}, size=${actualSize}, magicBytesVerified=true, sha256_verified=${isChecksumVerified}.`,
  });

  const webhookResult = await dispatchFileWebhook({
    fileId: fileRow.id,
    event: 'file.uploaded',
    ipAddress,
  });

  // Procesamiento oportunista de webhooks pendientes (10% de probabilidad, máx 2 entregas)
  if (Math.random() < 0.1) {
    await processPendingWebhookDeliveries(2).catch(() => undefined);
  }

  return NextResponse.json(
    {
      status: 'success',
      action: 'complete',
      ticketId: fileRow.ticket_id,
      fileId: fileRow.id,
      fileStatus: 'uploaded',
      sha256Verified: isChecksumVerified,
      scanStatus: 'not_scanned',
      visibility: fileRow.visibility,
      partsCompleted: partsToComplete.length,
      cloudfrontUrl: publicCfUrl,
      verification: {
        magicBytesVerified: true,
        detectedMimeType: detectedMagicMime,
      },
      webhook: webhookResult,
    },
    { status: 200, headers: corsHeaders }
  );
}
