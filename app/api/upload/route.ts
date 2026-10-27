import { NextRequest, NextResponse } from 'next/server';
import { addServiceLog } from '@/lib/service-logs';
import { supabase } from '@/lib/supabase';
import {
  isAwsConfigured,
  generateOpaqueS3Key,
  generatePresignedUploadUrl,
  applyS3CacheControlMetadata,
  getCacheControlForVisibility,
  validateAllowedFileType,
  headS3Object,
  deleteS3Object,
  getS3ObjectRangeBytes,
  ALLOWED_FILE_TYPES,
  MAX_SINGLE_UPLOAD_BYTES,
  PRIVATE_NO_STORE_CACHE_CONTROL,
} from '@/lib/s3';
import { generateTicketConfirmToken, verifyTicketConfirmToken } from '@/lib/ticket-token';
import { getBaseCloudFrontUrl } from '@/lib/cloudfront';
import { detectMagicBytesMime } from '@/lib/magic-bytes';
import { processUpload, ENABLE_SERVER_PROCESSING_FALLBACK } from '@/lib/lambda-fallback/process-upload';
import { dispatchFileWebhook, processPendingWebhookDeliveries } from '@/lib/lambda-fallback/webhook-dispatcher';
import { checkOrganizationQuotas } from '@/lib/quotas';

// CORS Headers
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key, x-user-id',
};

// 1. Preflight OPTIONS handler
export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: corsHeaders,
  });
}

// 2. Primary Endpoint: Issue Upload Ticket & Generate S3 Presigned URL
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      fileName = 'file.png',
      fileType = body.mimeType || 'image/png',
      fileSize: rawFileSize = body.sizeBytes ?? 1024,
      visibility: rawVisibility = body.visibilidad || 'private',
      sha256Hash = body.sha256Hash || body.hashSha256 || null,
      extension: incomingExtension,
    } = body;

    const visibility = String(rawVisibility).toLowerCase() === 'public' ? 'public' : 'private';

    // Section 3 (Option A): Ignore userId and orgId from the request body.
    // Take both strictly from the middleware-validated context headers.
    const orgId = (req.headers.get('x-validated-org-id') || '').trim();
    const userId = (req.headers.get('x-validated-user-id') || '').trim();

    if (!orgId) {
      return NextResponse.json(
        {
          error: 'Unauthorized',
          code: 'MISSING_VALIDATED_ORG',
          method: req.method,
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
          method: req.method,
          message:
            'El backend debe enviar el UUID del usuario final en la cabecera x-user-id (o usar una llave vinculada a un usuario). Se ignoran userId y orgId del cuerpo.',
        },
        { status: 400, headers: corsHeaders }
      );
    }

    // 1. Query User from Supabase (Real Database Lookup - No Hardcoding)
    let user: any = null;
    if (userId) {
      const { data: dbUser } = await supabase
        .from('users')
        .select('id, org_id, name, email, role, can_upload')
        .eq('id', userId)
        .maybeSingle();

      if (dbUser) {
        user = {
          id: dbUser.id,
          orgId: dbUser.org_id,
          name: dbUser.name,
          email: dbUser.email,
          role: dbUser.role,
          canUpload: Boolean(dbUser.can_upload),
        };
      }
    }

    // CHECK 1: User Authentication / Registration
    if (!user) {
      await addServiceLog({
        method: req.method,
        action: 'TICKET_REQUEST',
        status: 'DENIED_NOT_REGISTERED',
        userId: userId || 'unknown',
        userName: 'Unregistered User',
        targetOrgId: orgId,
        fileName,
        ipAddress: req.headers.get('x-forwarded-for') || '127.0.0.1',
        message: 'User does not exist in the database.',
      });

      return NextResponse.json(
        {
          error: 'Unauthorized',
          code: 'USER_NOT_REGISTERED',
          method: req.method,
          message: 'Access Denied: User is not registered in the system.',
        },
        { status: 401, headers: corsHeaders }
      );
    }

    // 2. Query Organizations from Supabase (Real Database Lookup - No Hardcoding)
    let userOrg: any = null;
    let targetOrg: any = null;

    if (user.orgId) {
      const { data: dbUserOrg } = await supabase
        .from('organizations')
        .select('id, name, slug')
        .eq('id', user.orgId)
        .maybeSingle();

      if (dbUserOrg) {
        userOrg = dbUserOrg;
      }
    }

    if (orgId) {
      const { data: dbTargetOrg } = await supabase
        .from('organizations')
        .select('id, name, slug')
        .eq('id', orgId)
        .maybeSingle();

      if (dbTargetOrg) {
        targetOrg = dbTargetOrg;
      }
    }

    if (!targetOrg) {
      return NextResponse.json(
        {
          error: 'Not Found',
          code: 'ORGANIZATION_NOT_FOUND',
          method: req.method,
          message: 'Target organization does not exist.',
        },
        { status: 404, headers: corsHeaders }
      );
    }

    // CHECK 2: Multi-Tenant Isolation (Disallow uploading to a foreign organization)
    if (user.orgId !== orgId) {
      await addServiceLog({
        method: req.method,
        action: 'CROSS_ORG_VIOLATION',
        status: 'DENIED_CROSS_ORG',
        userId: user.id,
        userName: user.name,
        orgId: user.orgId,
        orgName: userOrg?.name,
        targetOrgId: orgId,
        fileName,
        ipAddress: req.headers.get('x-forwarded-for') || '127.0.0.1',
        message: `CROSS-ORGANIZATION UPLOAD ATTEMPT BLOCKED: User '${user.name}' (${userOrg?.name}) attempted to upload to '${targetOrg.name}'.`,
      });

      return NextResponse.json(
        {
          error: 'Forbidden',
          code: 'FORBIDDEN_CROSS_ORGANIZATION',
          method: req.method,
          message: `Multi-Tenant Security Violation: User '${user.name}' belongs to '${userOrg?.name}' and cannot upload files to '${targetOrg.name}'.`,
          details: {
            userOrg: userOrg?.name,
            targetOrg: targetOrg.name,
          },
        },
        { status: 403, headers: corsHeaders }
      );
    }

    // CHECK 3: Upload Permissions (RBAC)
    if (!user.canUpload) {
      await addServiceLog({
        method: req.method,
        action: 'INSUFFICIENT_PERMISSIONS',
        status: 'DENIED_NO_PERMISSION',
        userId: user.id,
        userName: user.name,
        orgId: user.orgId,
        orgName: userOrg?.name,
        fileName,
        ipAddress: req.headers.get('x-forwarded-for') || '127.0.0.1',
        message: 'User has a viewer role and lacks upload authorization.',
      });

      return NextResponse.json(
        {
          error: 'Forbidden',
          code: 'FORBIDDEN_NO_PERMISSION',
          method: req.method,
          message: `Permission Denied: User '${user.name}' is not authorized to upload files to '${userOrg?.name}'.`,
        },
        { status: 403, headers: corsHeaders }
      );
    }

    // CHECK 4 (Task A.4): Strict File Type Whitelist, Extension/MIME Coherence, XSS & Video Blocking
    const typeValidation = validateAllowedFileType(fileName, fileType, incomingExtension);
    if (!typeValidation.valid) {
      await addServiceLog({
        method: req.method,
        action: 'FILE_TYPE_REJECTED',
        status: 'DENIED_INVALID_TYPE',
        userId: user.id,
        userName: user.name,
        orgId: user.orgId,
        orgName: userOrg?.name,
        fileName,
        ipAddress: req.headers.get('x-forwarded-for') || '127.0.0.1',
        message: `${typeValidation.code}: ${typeValidation.message}`,
      });

      return NextResponse.json(
        {
          error: 'Bad Request',
          code: typeValidation.code,
          method: req.method,
          message: typeValidation.message,
          allowedExtensions: Object.keys(ALLOWED_FILE_TYPES),
        },
        { status: 400, headers: corsHeaders }
      );
    }

    // CHECK 5 (Task A.5): File Size Validation & Maximum Single Upload Limit
    const fileSize = Number(rawFileSize);
    if (!Number.isFinite(fileSize) || !Number.isInteger(fileSize) || fileSize <= 0) {
      return NextResponse.json(
        {
          error: 'Bad Request',
          code: 'INVALID_FILE_SIZE',
          method: req.method,
          message: 'El tamaño del archivo (fileSize) debe ser un número entero positivo de bytes mayor a 0.',
        },
        { status: 400, headers: corsHeaders }
      );
    }

    if (fileSize > MAX_SINGLE_UPLOAD_BYTES) {
      await addServiceLog({
        method: req.method,
        action: 'FILE_SIZE_REJECTED',
        status: 'DENIED_SIZE_LIMIT',
        userId: user.id,
        userName: user.name,
        orgId: user.orgId,
        orgName: userOrg?.name,
        fileName,
        ipAddress: req.headers.get('x-forwarded-for') || '127.0.0.1',
        message: `Tamaño declarado (${fileSize} bytes) excede el máximo permitido para subida simple (${MAX_SINGLE_UPLOAD_BYTES} bytes).`,
      });

      return NextResponse.json(
        {
          error: 'Payload Too Large',
          code: 'FILE_SIZE_EXCEEDS_LIMIT',
          method: req.method,
          message: `El tamaño declarado (${fileSize} bytes) excede el límite máximo de subida simple (${MAX_SINGLE_UPLOAD_BYTES} bytes / 25 MB).`,
          declaredSizeBytes: fileSize,
          maxAllowedBytes: MAX_SINGLE_UPLOAD_BYTES,
        },
        { status: 413, headers: corsHeaders }
      );
    }

    // CHECK 6 (Task B.13): Organization Quotas (max_storage_bytes & max_pending_tickets)
    const quotaCheck = await checkOrganizationQuotas(orgId, fileSize, {
      overrideMaxStorageBytes:
        body.testMaxStorageBytes !== undefined ? Number(body.testMaxStorageBytes) : undefined,
      overrideMaxPendingTickets:
        body.testMaxPendingTickets !== undefined ? Number(body.testMaxPendingTickets) : undefined,
    });

    if (!quotaCheck.allowed) {
      await addServiceLog({
        method: req.method,
        action: 'ORG_QUOTA_EXCEEDED',
        status: quotaCheck.code || 'DENIED_QUOTA',
        userId: user.id,
        userName: user.name,
        orgId: user.orgId,
        orgName: userOrg?.name,
        fileName,
        ipAddress: req.headers.get('x-forwarded-for') || '127.0.0.1',
        message: `${quotaCheck.code}: ${quotaCheck.message}`,
      });

      return NextResponse.json(
        {
          error: quotaCheck.httpStatus === 429 ? 'Too Many Requests' : 'Payload Too Large',
          code: quotaCheck.code,
          method: req.method,
          message: quotaCheck.message,
          quotaUsage: quotaCheck.usage,
        },
        { status: quotaCheck.httpStatus || 429, headers: corsHeaders }
      );
    }

    // ============================================================================
    // [TEMPORARY-LAMBDA-FALLBACK: OPPORTUNISTIC-TICKET-CLEANUP]
    // Reemplaza temporalmente las reglas de ciclo de vida automáticas de AWS S3.
    // Al emitir un ticket, borra de la organización hasta 3 tickets vencidos (objeto S3 y fila).
    // NO borra la fila si falla el borrado en S3. El cron queda de respaldo.
    // ============================================================================
    try {
      const nowIso = new Date().toISOString();
      const { data: expiredBatch } = await supabase
        .from('files')
        .select('id, s3_pending_key, expires_at')
        .eq('org_id', user.orgId)
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
              console.warn('[TEMPORARY-LAMBDA-FALLBACK] Error borrando S3 en limpieza oportunista:', err.message);
            }
            if (s3Deleted) {
              await supabase.from('files').delete().eq('id', exp.id);
            }
          }
        }
      }
    } catch (e: any) {
      console.warn('[TEMPORARY-LAMBDA-FALLBACK] Limpieza oportunista ignorada:', e.message);
    }
    // ============================================================================
    // END [TEMPORARY-LAMBDA-FALLBACK: OPPORTUNISTIC-TICKET-CLEANUP]
    // ============================================================================

    // ALL CHECKS PASSED -> Generate Ticket & Opaque 128-bit S3 Key (Task A.1)
    const fileId = crypto.randomUUID();
    const ticketId = crypto.randomUUID();
    const timestamp = Date.now();
    const TTL_SECONDS = 300; // 5-minute TTL
    const expiresAt = new Date(timestamp + TTL_SECONDS * 1000).toISOString();
    const orgSlug = targetOrg.slug;

    const extension = typeValidation.extension!;
    const validatedMimeType = typeValidation.mimeType!;
    const resourceType = typeValidation.resourceType!;
    const contentDisposition = typeValidation.contentDisposition!;

    // Claves por visibilidad: públicos en static/files/<rand128>.<ext>, privados en static/private/<rand128>.<ext>
    const s3FolderPrefix = visibility === 'private' ? 'static/private' : 'static/files';
    const landingZoneKey = generateOpaqueS3Key(s3FolderPrefix, extension);
    // Task A.3: Signed Cache-Control for landing zone is strictly no-store
    const signedUploadCacheControl = PRIVATE_NO_STORE_CACHE_CONTROL;

    // Cryptographically signed confirmation token (HMAC-SHA256)
    const confirmToken = generateTicketConfirmToken(ticketId, user.id, expiresAt);

    // Generate AWS S3 Presigned Upload URL (Direct AWS S3 - No Simulation)
    if (!isAwsConfigured()) {
      return NextResponse.json(
        {
          error: 'Configuration Error',
          code: 'AWS_S3_NOT_CONFIGURED',
          message: 'AWS S3 storage is not properly configured on the server.',
        },
        { status: 500, headers: corsHeaders }
      );
    }

    let uploadUrl: string | null = null;
    try {
      uploadUrl = await generatePresignedUploadUrl(
        landingZoneKey,
        validatedMimeType,
        TTL_SECONDS,
        signedUploadCacheControl,
        fileSize,
        contentDisposition,
        sha256Hash || undefined
      );
    } catch (s3Err: any) {
      console.error('Error generating AWS S3 Presigned URL:', s3Err.message);
    }

    if (!uploadUrl) {
      return NextResponse.json(
        {
          error: 'Storage Error',
          code: 'S3_PRESIGNED_URL_FAILED',
          message: 'Failed to generate secure S3 presigned upload URL.',
        },
        { status: 500, headers: corsHeaders }
      );
    }

    // 1. Insert file record into Supabase (files table - original_name only in DB, scan_status='not_scanned')
    const filePayload: Record<string, any> = {
      id: fileId,
      ticket_id: ticketId,
      user_id: user.id,
      org_id: targetOrg.id,
      original_name: fileName,
      extension,
      mime_type: validatedMimeType,
      size_bytes: fileSize,
      sha256_hash: sha256Hash,
      resource_type: resourceType,
      visibility,
      s3_pending_key: landingZoneKey,
      s3_processed_key: null,
      cloudfront_url: null,
      scan_status: 'not_scanned',
      status: 'pending_upload',
      created_at: new Date(timestamp).toISOString(),
    };

    const { error: insertErr } = await supabase.from('files').insert(filePayload);

    if (insertErr) {
      console.error('Error inserting file in Supabase files table:', insertErr.message);
      return NextResponse.json(
        {
          error: 'Database Error',
          code: 'FILE_RECORD_INSERT_FAILED',
          message: `No se pudo registrar el ticket en la base de datos: ${insertErr.message}`,
        },
        { status: 500, headers: corsHeaders }
      );
    }

    // 2. Record audit log event in Supabase
    await addServiceLog({
      method: req.method,
      action: 'TICKET_ISSUED',
      status: 'ALLOWED',
      userId: user.id,
      userName: user.name,
      orgId: user.orgId,
      orgName: userOrg?.name,
      targetOrgId: orgId,
      ticketId,
      fileId,
      fileName,
      ipAddress: req.headers.get('x-forwarded-for') || '127.0.0.1',
      message: `Presigned S3 upload URL issued for file '${fileName}' (${validatedMimeType}, ${fileSize} bytes, visibility=${visibility}, disposition=${contentDisposition})`,
    });

    const requiredHeaders: Record<string, string> = {
      'Content-Type': validatedMimeType,
      'Cache-Control': signedUploadCacheControl,
      'Content-Length': String(fileSize),
    };
    if (contentDisposition === 'attachment') {
      requiredHeaders['Content-Disposition'] = 'attachment';
    }
    if (sha256Hash && /^[0-9a-f]{64}$/i.test(sha256Hash)) {
      requiredHeaders['x-amz-checksum-sha256'] = Buffer.from(sha256Hash, 'hex').toString('base64');
    }

    return NextResponse.json(
      {
        ticketId,
        fileId,
        uploadUrl,
        method: req.method,
        uploadMethod: 'PUT',
        requiredHeaders,
        isRealS3: true,
        isMultipart: false,
        expiresAt,
        expiresInSeconds: TTL_SECONDS,
        confirmToken,
        user: {
          id: user.id,
          name: user.name,
          role: user.role,
        },
        organization: {
          id: targetOrg.id,
          name: targetOrg.name,
          slug: targetOrg.slug,
        },
        metadata: {
          userId: user.id,
          orgId: targetOrg.id,
          orgSlug,
          visibility,
          fileName,
          extension,
          mimeType: validatedMimeType,
          fileSize,
          contentDisposition,
          sha256Hash,
          scanStatus: 'not_scanned',
          signedCacheControl: signedUploadCacheControl,
          method: req.method,
          uploadMethod: 'PUT',
          isRealS3: true,
          expiresAt,
          expiresInSeconds: TTL_SECONDS,
          issuedAt: new Date(timestamp).toISOString(),
        },
        // Backward compatibility fields for frontend/postman
        usuario: {
          id: user.id,
          nombre: user.name,
          rol: user.role,
        },
        organizacion: {
          id: targetOrg.id,
          nombre: targetOrg.name,
          slug: targetOrg.slug,
        },
      },
      { status: 200, headers: corsHeaders }
    );
  } catch (error: any) {
    return NextResponse.json(
      { error: 'Internal Server Error', message: error.message },
      { status: 500, headers: corsHeaders }
    );
  }
}

// 3. Upload Confirmation (PUT)
export async function PUT(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const ticketId = searchParams.get('ticketId') || '';
  const skipProcess = searchParams.get('skipProcess') === 'true';
  let confirmToken = searchParams.get('token') || searchParams.get('confirmToken') || '';

  // Read confirmToken from request body if sent as JSON
  try {
    const body = await req.json().catch(() => ({}));
    if (body?.token) confirmToken = body.token;
    if (body?.confirmToken) confirmToken = body.confirmToken;
  } catch {
    // Body is optional if confirmToken was sent via query parameter
  }

  if (!ticketId) {
    return NextResponse.json(
      {
        error: 'Bad Request',
        code: 'MISSING_TICKET_ID',
        method: req.method,
        message: 'A valid ticketId query parameter is required to confirm upload.',
      },
      { status: 400, headers: corsHeaders }
    );
  }

  // 1. Retrieve file record from Supabase (files table)
  let fileRow: any = null;

  try {
    const { data: existingFiles, error: errFiles } = await supabase
      .from('files')
      .select('*')
      .eq('ticket_id', ticketId)
      .limit(1);

    if (!errFiles && existingFiles && existingFiles.length > 0) {
      fileRow = existingFiles[0];
    }
  } catch (dbErr: any) {
    console.error('Error querying ticket in Supabase:', dbErr.message);
  }

  // CHECK 1: Ticket Existence (Return 404 if ticket doesn't exist)
  if (!fileRow) {
    await addServiceLog({
      method: req.method,
      action: 'TICKET_CONFIRM_FAILED',
      status: 'DENIED_NOT_FOUND',
      ticketId,
      ipAddress: req.headers.get('x-forwarded-for') || '127.0.0.1',
      message: 'Ticket not found in database.',
    });

    return NextResponse.json(
      {
        error: 'Not Found',
        code: 'TICKET_NOT_FOUND',
        method: req.method,
        message: `Upload ticket '${ticketId}' does not exist or has been removed.`,
      },
      { status: 404, headers: corsHeaders }
    );
  }

  // CHECK 1.5: Tenant & User Anti-Impersonation on Confirmation
  const validatedOrgId = req.headers.get('x-validated-org-id');
  const validatedUserId = req.headers.get('x-validated-user-id');

  if (validatedOrgId && fileRow.org_id && validatedOrgId !== fileRow.org_id) {
    await addServiceLog({
      method: req.method,
      action: 'CONFIRM_CROSS_ORG_DENIED',
      status: 'ACCESS_DENIED',
      userId: validatedUserId || undefined,
      orgId: validatedOrgId,
      targetOrgId: fileRow.org_id,
      ticketId,
      fileId: fileRow.id,
      ipAddress: req.headers.get('x-forwarded-for') || '127.0.0.1',
      message: `Intento de confirmar ticket de otra organización bloqueado.`,
    });

    return NextResponse.json(
      {
        error: 'Forbidden',
        code: 'FORBIDDEN_CROSS_ORGANIZATION',
        method: req.method,
        message: 'No tienes permiso para confirmar tickets de otra organización.',
      },
      { status: 403, headers: corsHeaders }
    );
  }

  if (validatedUserId && fileRow.user_id && validatedUserId !== fileRow.user_id) {
    await addServiceLog({
      method: req.method,
      action: 'CONFIRM_IMPERSONATION_DENIED',
      status: 'ACCESS_DENIED',
      userId: validatedUserId,
      orgId: validatedOrgId || fileRow.org_id,
      ticketId,
      fileId: fileRow.id,
      ipAddress: req.headers.get('x-forwarded-for') || '127.0.0.1',
      message: `El usuario autenticado '${validatedUserId}' intentó confirmar el ticket del usuario '${fileRow.user_id}'.`,
    });

    return NextResponse.json(
      {
        error: 'Forbidden',
        code: 'FORBIDDEN_USER_IMPERSONATION',
        method: req.method,
        message: 'Violación de Seguridad: Solo el usuario propietario que emitió el ticket puede confirmarlo.',
      },
      { status: 403, headers: corsHeaders }
    );
  }

  // CHECK 2: Ticket Already Uploaded / Completed (Idempotency / Replay protection)
  const currentStatus = fileRow.status;
  if (currentStatus === 'uploaded' || currentStatus === 'completed' || currentStatus === 'processed') {
    return NextResponse.json(
      {
        error: 'Conflict',
        code: 'TICKET_ALREADY_COMPLETED',
        method: req.method,
        message: `Upload ticket '${ticketId}' has already been confirmed and ${currentStatus}.`,
        ticketId,
        completedAt: fileRow.completed_at || null,
      },
      { status: 409, headers: corsHeaders }
    );
  }

  // CHECK 3: Expiration Check (5-minute TTL + 2-minute grace window)
  const GRACE_PERIOD_MS = 2 * 60 * 1000;
  const createdAtMs = new Date(fileRow.created_at).getTime();
  const TTL_MS = 300 * 1000;
  if (!isNaN(createdAtMs) && Date.now() > createdAtMs + TTL_MS + GRACE_PERIOD_MS) {
    try {
      await supabase.from('files').update({ status: 'expired' }).eq('ticket_id', ticketId);
    } catch (expErr: any) {
      console.warn('Could not mark ticket expired in DB:', expErr.message);
    }

    await addServiceLog({
      method: req.method,
      action: 'TICKET_EXPIRED',
      status: 'DENIED_EXPIRED',
      userId: fileRow.user_id,
      orgId: fileRow.org_id,
      ticketId,
      fileId: fileRow.id,
      ipAddress: req.headers.get('x-forwarded-for') || '127.0.0.1',
      message: 'Ticket TTL exceeded (5 min window expired).',
    });

    return NextResponse.json(
      {
        error: 'Gone',
        code: 'TICKET_EXPIRED',
        method: req.method,
        message: `Upload ticket '${ticketId}' has expired (5-minute TTL exceeded). Request a new upload ticket.`,
      },
      { status: 410, headers: corsHeaders }
    );
  }

  // CHECK 4 (Task A.5): Mandatory HMAC Cryptographic Signature Verification (confirmToken required)
  if (!confirmToken || !confirmToken.trim()) {
    await addServiceLog({
      method: req.method,
      action: 'TICKET_CONFIRM_MISSING_TOKEN',
      status: 'DENIED_MISSING_TOKEN',
      userId: fileRow.user_id,
      orgId: fileRow.org_id,
      ticketId,
      fileId: fileRow.id,
      ipAddress: req.headers.get('x-forwarded-for') || '127.0.0.1',
      message: 'Confirmation rejected: confirmToken is mandatory.',
    });

    return NextResponse.json(
      {
        error: 'Bad Request',
        code: 'MISSING_CONFIRM_TOKEN',
        method: req.method,
        message: 'Seguridad: El token criptográfico de confirmación (confirmToken) es obligatorio para confirmar la subida.',
      },
      { status: 400, headers: corsHeaders }
    );
  }

  const tokenResult = verifyTicketConfirmToken(confirmToken, ticketId, fileRow.user_id);
  if (!tokenResult.valid) {
    await addServiceLog({
      method: req.method,
      action: 'TICKET_SIGNATURE_INVALID',
      status: 'DENIED_FORGED_TOKEN',
      userId: fileRow.user_id,
      orgId: fileRow.org_id,
      ticketId,
      fileId: fileRow.id,
      ipAddress: req.headers.get('x-forwarded-for') || '127.0.0.1',
      message: `Invalid or forged ticket confirmation token: ${tokenResult.reason}`,
    });

    return NextResponse.json(
      {
        error: 'Forbidden',
        code: 'INVALID_CONFIRM_TOKEN',
        method: req.method,
        message: `Invalid or forged ticket confirmation token: ${tokenResult.reason}`,
      },
      { status: 403, headers: corsHeaders }
    );
  }

  // CHECK 5 (Task A.5): Real S3 HeadObject Verification (Size & MIME Type vs Ticket Declaration)
  const pendingKey = fileRow.s3_pending_key;
  const headMeta = await headS3Object(pendingKey);

  if (!headMeta.exists) {
    await addServiceLog({
      method: req.method,
      action: 'UPLOAD_CONFIRM_MISSING_S3_OBJECT',
      status: 'DENIED_NOT_UPLOADED',
      userId: fileRow.user_id,
      orgId: fileRow.org_id,
      ticketId,
      fileId: fileRow.id,
      fileName: fileRow.original_name,
      ipAddress: req.headers.get('x-forwarded-for') || '127.0.0.1',
      message: `HeadObject failed: object '${pendingKey}' does not exist in S3.`,
    });

    return NextResponse.json(
      {
        error: 'Bad Request',
        code: 'FILE_NOT_UPLOADED_TO_S3',
        method: req.method,
        message: 'El archivo aún no existe en el almacenamiento S3. Realiza el PUT a uploadUrl antes de confirmar.',
      },
      { status: 400, headers: corsHeaders }
    );
  }

  const declaredSize = Number(fileRow.size_bytes);
  const actualSize = Number(headMeta.contentLength ?? -1);
  const declaredMime = String(fileRow.mime_type || '').toLowerCase().trim();
  const actualMime = String(headMeta.contentType || '').toLowerCase().trim();

  const sizeMismatch = actualSize !== declaredSize || actualSize <= 0 || actualSize > MAX_SINGLE_UPLOAD_BYTES;
  const mimeMismatch = actualMime !== declaredMime;

  if (sizeMismatch || mimeMismatch) {
    const mismatchReason = `Discrepancia detectada por HeadObject en S3: declarado=(${declaredSize} bytes, '${declaredMime}') vs real=(${actualSize} bytes, '${actualMime}').`;

    // Delete fraudulent/mismatched object from S3 immediately
    try {
      await deleteS3Object(pendingKey);
    } catch (delErr: any) {
      console.error('Failed to delete mismatched S3 object:', delErr.message);
    }

    const failNowIso = new Date().toISOString();
    await supabase
      .from('files')
      .update({
        status: 'failed',
        error_message: mismatchReason,
        updated_at: failNowIso,
      })
      .eq('ticket_id', ticketId);

    await addServiceLog({
      method: req.method,
      action: 'UPLOAD_HEAD_VERIFICATION_FAILED',
      status: 'REJECTED_MISMATCH',
      userId: fileRow.user_id,
      orgId: fileRow.org_id,
      ticketId,
      fileId: fileRow.id,
      fileName: fileRow.original_name,
      ipAddress: req.headers.get('x-forwarded-for') || '127.0.0.1',
      message: `${mismatchReason} Objeto eliminado de S3 y ticket marcado como 'failed'.`,
    });

    return NextResponse.json(
      {
        error: 'Bad Request',
        code: 'UPLOAD_VERIFICATION_MISMATCH',
        method: req.method,
        message: mismatchReason,
        declared: {
          sizeBytes: declaredSize,
          mimeType: declaredMime,
        },
        actual: {
          sizeBytes: actualSize,
          mimeType: actualMime,
        },
        remediation: 'deleted_from_s3_and_marked_failed',
      },
      { status: 400, headers: corsHeaders }
    );
  }

  // CHECK 6 (Section 5): Real binary format validation via 32-Byte Range GET (Zero full file download)
  const rangeBytes = await getS3ObjectRangeBytes(pendingKey, 0, 31);
  if (!rangeBytes || rangeBytes.length < 4) {
    try {
      await deleteS3Object(pendingKey);
    } catch {}
    const failNowIso = new Date().toISOString();
    await supabase
      .from('files')
      .update({
        status: 'failed',
        error_message: 'No se pudieron leer los primeros bytes del objeto en S3 para verificar la cabecera binaria.',
        updated_at: failNowIso,
      })
      .eq('ticket_id', ticketId);

    return NextResponse.json(
      {
        error: 'Bad Request',
        code: 'INVALID_FILE_HEADER',
        method: req.method,
        message: 'No se pudieron leer los primeros bytes del archivo en S3 para validar su cabecera binaria.',
      },
      { status: 400, headers: corsHeaders }
    );
  }

  const detectedMagicMime = detectMagicBytesMime(rangeBytes);
  if (!detectedMagicMime || detectedMagicMime !== declaredMime) {
    try {
      await deleteS3Object(pendingKey);
    } catch {}
    const magicMismatchReason = `Cabecera binaria inválida: detectado '${detectedMagicMime || 'desconocido'}' no coincide con el tipo MIME declarado '${declaredMime}'.`;
    const failNowIso = new Date().toISOString();
    await supabase
      .from('files')
      .update({
        status: 'failed',
        error_message: magicMismatchReason,
        updated_at: failNowIso,
      })
      .eq('ticket_id', ticketId);

    await addServiceLog({
      method: req.method,
      action: 'MAGIC_BYTES_VERIFICATION_FAILED',
      status: 'REJECTED_MAGIC_BYTES',
      userId: fileRow.user_id,
      orgId: fileRow.org_id,
      ticketId,
      fileId: fileRow.id,
      fileName: fileRow.original_name,
      ipAddress: req.headers.get('x-forwarded-for') || '127.0.0.1',
      message: `${magicMismatchReason} Objeto eliminado de S3 y ticket marcado como 'failed'.`,
    });

    return NextResponse.json(
      {
        error: 'Bad Request',
        code: 'INVALID_MAGIC_BYTES',
        method: req.method,
        message: magicMismatchReason,
        detectedMime: detectedMagicMime,
        declaredMime,
      },
      { status: 400, headers: corsHeaders }
    );
  }

  // CHECK 7 (Section 5): SHA-256 S3 Checksum Verification (Single PUT upload)
  if (fileRow.sha256_hash && headMeta.checksumSHA256) {
    const expectedBase64 = Buffer.from(fileRow.sha256_hash, 'hex').toString('base64');
    if (headMeta.checksumSHA256 !== expectedBase64) {
      try {
        await deleteS3Object(pendingKey);
      } catch {}
      const checksumMismatchReason = `Checksum SHA-256 no coincide: declarado base64='${expectedBase64}' vs S3='${headMeta.checksumSHA256}'.`;
      const failNowIso = new Date().toISOString();
      await supabase
        .from('files')
        .update({
          status: 'failed',
          error_message: checksumMismatchReason,
          updated_at: failNowIso,
        })
        .eq('ticket_id', ticketId);

      await addServiceLog({
        method: req.method,
        action: 'CHECKSUM_SHA256_VERIFICATION_FAILED',
        status: 'REJECTED_CHECKSUM',
        userId: fileRow.user_id,
        orgId: fileRow.org_id,
        ticketId,
        fileId: fileRow.id,
        fileName: fileRow.original_name,
        ipAddress: req.headers.get('x-forwarded-for') || '127.0.0.1',
        message: `${checksumMismatchReason} Objeto eliminado de S3 y ticket marcado como 'failed'.`,
      });

      return NextResponse.json(
        {
          error: 'Bad Request',
          code: 'CHECKSUM_MISMATCH',
          method: req.method,
          message: checksumMismatchReason,
        },
        { status: 400, headers: corsHeaders }
      );
    }
  }

  const fileVisibility = String(fileRow?.visibility || 'private').toLowerCase() === 'public' ? 'public' : 'private';
  const expectedDisposition =
    String(fileRow?.extension || '').toLowerCase() === '.pdf' ? 'attachment' : 'inline';
  const nowIso = new Date().toISOString();
  const clientIp = req.headers.get('x-forwarded-for') || '127.0.0.1';

  // [TEST-ONLY: TASK-B6-TRIGGER-FROM-CONFIRM]
  // Fallback for local testing only (disabled by default in production per "no binary files through Vercel" rule)
  if (ENABLE_SERVER_PROCESSING_FALLBACK) {
    const procResult = await processUpload(fileRow.id, {
      ipAddress: clientIp,
      triggerSource: 'put_confirm',
    });

    if (!procResult.success) {
      return NextResponse.json(
        {
          error: 'Bad Request',
          code: procResult.code || 'PROCESS_UPLOAD_FAILED',
          method: req.method,
          message: procResult.message,
          ticketId,
          fileId: fileRow.id,
          processing: procResult,
        },
        { status: 400, headers: corsHeaders }
      );
    }

    return NextResponse.json(
      {
        status: 'success',
        method: req.method,
        message: `File upload confirmed and processed (test fallback) for ticket ${ticketId}`,
        ticketId,
        fileId: fileRow.id,
        fileStatus: 'uploaded',
        scanStatus: procResult.scanStatus,
        visibility: fileVisibility,
        ownerUserId: fileRow?.user_id || null,
        cacheControl: getCacheControlForVisibility(fileVisibility, false),
        cloudfrontUrl: fileVisibility === 'public' ? procResult.cloudfrontUrl : null,
        tokenVerified: true,
        headVerification: {
          verified: true,
          actualSizeBytes: actualSize,
          actualContentType: actualMime,
          eTag: headMeta.eTag,
        },
        processing: {
          exifStripped: procResult.exifStripped,
          detectedMimeType: procResult.detectedMimeType,
          originalSizeBytes: procResult.originalSizeBytes,
          processedSizeBytes: procResult.processedSizeBytes,
          sha256Hash: procResult.sha256Hash,
        },
        webhook: procResult.webhook,
      },
      { status: 200, headers: corsHeaders }
    );
  }

  // PRODUCTION FLOW: No files pass through Vercel
  let s3CacheControl: string | null = null;
  if (fileVisibility === 'public' && fileRow?.s3_pending_key) {
    try {
      s3CacheControl = await applyS3CacheControlMetadata(
        fileRow.s3_pending_key,
        fileRow.mime_type || 'application/octet-stream',
        fileVisibility,
        expectedDisposition
      );
    } catch (metaErr: any) {
      console.warn('Could not apply Cache-Control metadata on S3 object:', metaErr.message);
    }
  }

  const publicCfUrl =
    fileVisibility === 'public' && fileRow?.s3_pending_key
      ? getBaseCloudFrontUrl(fileRow.s3_pending_key)
      : null;

  const isChecksumVerified = Boolean(fileRow.sha256_hash && headMeta.checksumSHA256);

  await supabase
    .from('files')
    .update({
      status: 'uploaded',
      scan_status: 'not_scanned',
      completed_at: nowIso,
      updated_at: nowIso,
      cloudfront_url: publicCfUrl,
      s3_processed_key: fileRow.s3_pending_key,
      sha256_verified: isChecksumVerified,
    })
    .eq('ticket_id', ticketId);

  await addServiceLog({
    method: req.method,
    action: 'S3_UPLOAD_CONFIRMED',
    status: 'UPLOADED',
    userId: fileRow?.user_id || undefined,
    orgId: fileRow?.org_id || undefined,
    ticketId,
    fileId: fileRow?.id || undefined,
    fileName: fileRow?.original_name || undefined,
    ipAddress: clientIp,
    message: `File confirmed in S3: status='uploaded', scan_status='not_scanned', visibility='${fileVisibility}', size=${actualSize}, magicBytesVerified=true, sha256_verified=${isChecksumVerified}`,
  });

  const webhookResult = await dispatchFileWebhook({
    fileId: fileRow.id,
    event: 'file.uploaded',
    ipAddress: clientIp,
  });

  // Procesamiento oportunista de webhooks pendientes (10% de probabilidad, máx 2 entregas)
  if (Math.random() < 0.1) {
    await processPendingWebhookDeliveries(2).catch(() => undefined);
  }

  return NextResponse.json(
    {
      status: 'success',
      method: req.method,
      message: `File upload confirmed for ticket ${ticketId}`,
      ticketId,
      fileId: fileRow?.id || null,
      fileStatus: 'uploaded',
      sha256Verified: isChecksumVerified,
      scanStatus: 'not_scanned',
      visibility: fileVisibility,
      ownerUserId: fileRow?.user_id || null,
      cacheControl: s3CacheControl || getCacheControlForVisibility(fileVisibility, false),
      cloudfrontUrl: publicCfUrl,
      tokenVerified: true,
      headVerification: {
        verified: true,
        actualSizeBytes: actualSize,
        actualContentType: actualMime,
        actualCacheControl: s3CacheControl || headMeta.cacheControl,
        actualContentDisposition:
          expectedDisposition === 'attachment' ? 'attachment' : headMeta.contentDisposition,
        eTag: headMeta.eTag,
      },
      verification: {
        magicBytesVerified: true,
        detectedMimeType: detectedMagicMime,
        checksumVerified: isChecksumVerified,
      },
      webhook: webhookResult,
    },
    { status: 200, headers: corsHeaders }
  );
}
