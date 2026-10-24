import { NextRequest, NextResponse } from 'next/server';
import { addServiceLog } from '@/lib/service-logs';
import { supabase } from '@/lib/supabase';
import {
  isAwsConfigured,
  generateOpaqueS3Key,
  generatePresignedUploadUrl,
  applyS3CacheControlMetadata,
  getCacheControlForVisibility,
  PRIVATE_NO_STORE_CACHE_CONTROL,
} from '@/lib/s3';
import { generateTicketConfirmToken, verifyTicketConfirmToken } from '@/lib/ticket-token';
import { getBaseCloudFrontUrl } from '@/lib/cloudfront';

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
      userId: bodyUserId,
      orgId: bodyOrgId,
      fileName = 'file.png',
      fileType = 'image/png',
      fileSize = 1024,
      visibility: rawVisibility = body.visibilidad || 'private',
      sha256Hash = body.sha256Hash || body.hashSha256 || null,
      extension: incomingExtension,
    } = body;

    const visibility = String(rawVisibility).toLowerCase() === 'public' ? 'public' : 'private';
    const validatedOrgId = req.headers.get('x-validated-org-id');
    const validatedUserId = req.headers.get('x-validated-user-id');
    const orgId = bodyOrgId || validatedOrgId;

    // Decisión 1-A: Si la API Key está vinculada a un user_id (x-validated-user-id),
    // impedir que el cliente suplante a otro usuario enviando un userId distinto en el body.
    if (validatedUserId && bodyUserId && bodyUserId.trim() !== validatedUserId) {
      await addServiceLog({
        method: req.method,
        action: 'USER_IMPERSONATION_BLOCKED',
        status: 'ACCESS_DENIED',
        userId: validatedUserId,
        orgId: validatedOrgId || orgId,
        fileName,
        ipAddress: req.headers.get('x-forwarded-for') || '127.0.0.1',
        message: `Intento de suplantación bloqueado: la API Key pertenece al usuario '${validatedUserId}', pero el body solicitó subir como '${bodyUserId}'.`,
      });

      return NextResponse.json(
        {
          error: 'Forbidden',
          code: 'FORBIDDEN_USER_IMPERSONATION',
          method: req.method,
          message:
            'Violación de Seguridad: El userId enviado en el body no coincide con el usuario propietario de la API Key autenticada.',
          authenticatedUserId: validatedUserId,
          attemptedUserId: bodyUserId,
        },
        { status: 403, headers: corsHeaders }
      );
    }

    const userId = validatedUserId || bodyUserId;

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

    // CHECK 1.5: API Key Tenant Matching (Injected by Edge Middleware)
    if (validatedOrgId && validatedOrgId !== orgId) {
      await addServiceLog({
        method: req.method,
        action: 'API_KEY_ORG_MISMATCH',
        status: 'DENIED_CROSS_ORG',
        userId: user.id,
        userName: user.name,
        orgId: validatedOrgId,
        targetOrgId: orgId,
        ipAddress: req.headers.get('x-forwarded-for') || '127.0.0.1',
        message: 'API Key does not belong to destination organization.',
      });

      return NextResponse.json(
        {
          error: 'Forbidden',
          code: 'FORBIDDEN_API_KEY_ORG_MISMATCH',
          method: req.method,
          message: 'Multi-Tenant Security Violation: The provided API Key does not belong to the requested target organization.',
        },
        { status: 403, headers: corsHeaders }
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

    // ALL CHECKS PASSED -> Generate Ticket & Opaque 128-bit S3 Key (Task A.1)
    const fileId = crypto.randomUUID();
    const ticketId = crypto.randomUUID();
    const timestamp = Date.now();
    const TTL_SECONDS = 300; // 5-minute TTL
    const expiresAt = new Date(timestamp + TTL_SECONDS * 1000).toISOString();
    const orgSlug = targetOrg.slug;

    // Resource categorization (images, documents)
    let resourceType: 'images' | 'documents' | 'videos' = 'documents';
    if (fileType.startsWith('image/')) resourceType = 'images';
    else if (fileType.startsWith('video/')) resourceType = 'videos';

    // File extension: prioritize explicit field sent in HTTP request, or extract from fileName
    let extension = incomingExtension ? String(incomingExtension).trim().toLowerCase() : '';
    if (extension && !extension.startsWith('.')) {
      extension = `.${extension}`;
    }
    if (!extension && fileName.lastIndexOf('.') !== -1) {
      extension = fileName.slice(fileName.lastIndexOf('.')).toLowerCase();
    }

    // Task A.1: Opaque 128-bit random S3 key (distinct from DB fileId & ticketId; no orgSlug, visibility, or fileName)
    const landingZoneKey = generateOpaqueS3Key('static/pending', extension);
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
        fileType,
        TTL_SECONDS,
        signedUploadCacheControl
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
      mime_type: fileType,
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

    let { error: insertErr } = await supabase.from('files').insert(filePayload);
    // Fallback resiliente si el constraint legado archivos_scan_status_check aún no fue eliminado en el SQL Editor
    if (insertErr && insertErr.message?.includes('scan_status')) {
      const fallbackRes = await supabase.from('files').insert({
        ...filePayload,
        scan_status: 'NO_APLICA',
      });
      insertErr = fallbackRes.error;
    }

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
      message: `Presigned S3 upload URL issued for file '${fileName}' (${fileType}, ${fileSize} bytes, visibility=${visibility})`,
    });

    return NextResponse.json(
      {
        ticketId,
        fileId,
        uploadUrl,
        method: req.method,
        uploadMethod: 'PUT',
        requiredHeaders: {
          'Content-Type': fileType,
          'Cache-Control': signedUploadCacheControl,
        },
        isRealS3: true,
        isMultipart: fileSize > 20 * 1024 * 1024,
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
        s3Hierarchy: {
          landingZone: landingZoneKey,
          permanentTarget: null,
        },
        metadata: {
          userId: user.id,
          orgId: targetOrg.id,
          orgSlug,
          visibility,
          fileName,
          extension,
          mimeType: fileType,
          fileSize,
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
  let confirmToken = searchParams.get('token') || searchParams.get('confirmToken') || '';

  // Optional: Read confirmToken from request body if sent as JSON
  try {
    const body = await req.json().catch(() => ({}));
    if (body?.token) confirmToken = body.token;
    if (body?.confirmToken) confirmToken = body.confirmToken;
  } catch {
    // Body is optional
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

  // 1. Retrieve file record from Supabase (files table - No Spanish fallbacks)
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

  // CHECK 2: Ticket Already Completed (Idempotency / Replay protection)
  const currentStatus = fileRow.status;
  if (currentStatus === 'completed') {
    return NextResponse.json(
      {
        error: 'Conflict',
        code: 'TICKET_ALREADY_COMPLETED',
        method: req.method,
        message: `Upload ticket '${ticketId}' has already been confirmed and completed.`,
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
    // Mark as expired in database
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

  // CHECK 4: HMAC Cryptographic Signature (if token provided)
  if (confirmToken) {
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
  }

  // 2. Apply Cache-Control metadata in S3 based on visibility ('private' -> no-store, 'public' -> short 5m TTL)
  const fileVisibility = String(fileRow?.visibility || 'private').toLowerCase() === 'public' ? 'public' : 'private';
  let s3CacheControl: string | null = null;
  if (fileRow?.s3_pending_key) {
    try {
      s3CacheControl = await applyS3CacheControlMetadata(
        fileRow.s3_pending_key,
        fileRow.mime_type || 'application/octet-stream',
        fileVisibility
      );
    } catch (metaErr: any) {
      console.warn('Could not apply Cache-Control metadata on S3 object:', metaErr.message);
    }
  }

  // 3. Task A.2: Mark ticket completed in Supabase.
  // Private files NEVER store or return cloudfront_url (only public files exit through CloudFront).
  const nowIso = new Date().toISOString();
  const activeKey = fileRow?.s3_processed_key || fileRow?.s3_pending_key;
  const publicCfUrl =
    fileVisibility === 'public' && activeKey
      ? getBaseCloudFrontUrl(activeKey)
      : null;

  try {
    const updatePayload: Record<string, any> = {
      status: 'completed',
      completed_at: nowIso,
      updated_at: nowIso,
      cloudfront_url: publicCfUrl, // Explicitly null for private files
    };

    const { data: updated } = await supabase
      .from('files')
      .update(updatePayload)
      .eq('ticket_id', ticketId)
      .select('*');
    if (updated && updated.length > 0) {
      fileRow = updated[0];
    }
  } catch (dbErr: any) {
    console.error('Error updating file status in Supabase:', dbErr.message);
  }

  // 4. Record confirmation audit event in Supabase
  await addServiceLog({
    method: req.method,
    action: 'S3_UPLOAD_CONFIRMED',
    status: 'UPLOADED_LANDING',
    userId: fileRow?.user_id || undefined,
    orgId: fileRow?.org_id || undefined,
    ticketId,
    fileId: fileRow?.id || undefined,
    fileName: fileRow?.original_name || undefined,
    ipAddress: req.headers.get('x-forwarded-for') || '127.0.0.1',
    message: `File confirmed in S3 landing zone for ticket ${ticketId} (visibility=${fileVisibility})`,
  });

  return NextResponse.json(
    {
      status: 'success',
      method: req.method,
      message: `File upload confirmed for ticket ${ticketId}`,
      ticketId,
      fileId: fileRow?.id || null,
      visibility: fileVisibility,
      ownerUserId: fileRow?.user_id || null,
      cacheControl: s3CacheControl || getCacheControlForVisibility(fileVisibility, false),
      s3Status: 'uploaded_to_landing',
      s3Landing: fileRow?.s3_pending_key || null,
      cloudfrontUrl: fileVisibility === 'public' ? publicCfUrl : null,
      tokenVerified: Boolean(confirmToken),
    },
    { status: 200, headers: corsHeaders }
  );
}
