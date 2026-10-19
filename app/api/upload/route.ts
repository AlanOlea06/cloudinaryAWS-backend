import { NextRequest, NextResponse } from 'next/server';
import { USERS, ORGANIZATIONS, addServiceLog } from '@/lib/service-logs';
import { supabase } from '@/lib/supabase';
import { isAwsConfigured, generatePresignedUploadUrl } from '@/lib/s3';
import { generateTicketConfirmToken, verifyTicketConfirmToken } from '@/lib/ticket-token';

// CORS Headers
const corsHeaders = {
  'Access-Control-Allow-Origin': 'http://localhost:3000',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-mock-mode',
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
      userId,
      orgId,
      fileName = 'file.png',
      fileType = 'image/png',
      fileSize = 1024,
      visibility = body.visibilidad || 'private',
      sha256Hash = body.hashSha256 || 'simulated-sha256-hash',
      extension: incomingExtension,
    } = body;

    // CHECK 1: User Authentication / Registration
    const user = userId ? USERS[userId] : null;
    if (!user) {
      await addServiceLog({
        method: req.method,
        action: 'TICKET_REQUEST',
        status: 'DENIED_NOT_REGISTERED',
        userId: userId || 'unknown',
        userName: 'Unregistered User',
        targetOrgId: orgId,
        details: {
          method: req.method,
          reason: 'User does not exist in the database.',
          ip: req.headers.get('x-forwarded-for') || '127.0.0.1',
          fileName,
          mimeType: fileType,
          fileSize,
        },
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

    const userOrg = ORGANIZATIONS[user.orgId];
    const targetOrg = orgId ? ORGANIZATIONS[orgId] : null;

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
        details: {
          method: req.method,
          alert: 'CROSS-ORGANIZATION UPLOAD ATTEMPT BLOCKED',
          originOrg: userOrg?.name,
          destinationOrg: targetOrg.name,
          fileName,
          mimeType: fileType,
          fileSize,
          ip: req.headers.get('x-forwarded-for') || '127.0.0.1',
        },
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
        details: {
          method: req.method,
          reason: 'User has a viewer role and lacks upload authorization.',
          fileName,
          mimeType: fileType,
          fileSize,
          ip: req.headers.get('x-forwarded-for') || '127.0.0.1',
        },
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

    // ALL CHECKS PASSED -> Generate Ticket & S3 Keys
    const fileId = crypto.randomUUID();
    const ticketId = crypto.randomUUID();
    const timestamp = Date.now();
    const TTL_SECONDS = 300; // 5-minute TTL
    const expiresAt = new Date(timestamp + TTL_SECONDS * 1000).toISOString();
    const orgSlug = targetOrg.slug;

    // Resource categorization (images, documents, videos)
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

    // Standardized S3 Key hierarchy: pending/{fileId}{extension} (opaque, avoids overwrites and hides sensitive user IDs)
    const landingZoneKey = `pending/${fileId}${extension}`;
    const permanentTargetKey = `organizations/${orgSlug}/${resourceType}/${visibility}/${ticketId}-${fileName}`;

    // Cryptographically signed confirmation token (HMAC-SHA256)
    const confirmToken = generateTicketConfirmToken(ticketId, user.id, expiresAt);

    // Determine AWS S3 direct upload vs Mock fallback
    const forceMock = req.headers.get('x-mock-mode') === 'true' && !isAwsConfigured();
    let uploadUrl = '';
    let isRealS3 = false;

    if (isAwsConfigured() && !forceMock) {
      try {
        const presignedS3Url = await generatePresignedUploadUrl(landingZoneKey, fileType, TTL_SECONDS);
        if (presignedS3Url) {
          uploadUrl = presignedS3Url;
          isRealS3 = true;
        }
      } catch (s3Err: any) {
        console.error('Error generating AWS S3 Presigned URL:', s3Err.message);
      }
    }

    // Fallback URL if AWS S3 is not yet configured
    if (!uploadUrl) {
      const host = req.headers.get('host') || 'localhost:3000';
      const protocol = host.includes('localhost') ? 'http' : 'https';
      uploadUrl = `${protocol}://${host}/api/upload?ticketId=${ticketId}`;
      isRealS3 = false;
    }

    // 1. Insert file record into Supabase (files table with fallback to archivos)
    try {
      const filePayload: any = {
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
        s3_processed_key: permanentTargetKey,
        status: 'pending_upload',
        expires_at: expiresAt,
        created_at: new Date(timestamp).toISOString(),
      };

      let { error: englishErr } = await supabase.from('files').insert(filePayload);

      // If expires_at column does not exist yet in Supabase files table, retry without it
      if (englishErr && englishErr.message?.includes('expires_at')) {
        delete filePayload.expires_at;
        const retryRes = await supabase.from('files').insert(filePayload);
        englishErr = retryRes.error;
      }

      if (englishErr) {
        // Fallback to Spanish table if not yet migrated
        const spanishVisibility = visibility === 'private' ? 'privados' : 'publicos';
        const spanishType = resourceType === 'images' ? 'imagenes' : resourceType;

        const spanishPayload: any = {
          id: fileId,
          ticket_id: ticketId,
          user_id: user.id,
          org_id: targetOrg.id,
          nombre_original: fileName,
          formato: fileType,
          tamano_bytes: fileSize,
          hash_sha256: sha256Hash,
          tipo_recurso: spanishType,
          visibilidad: spanishVisibility,
          s3_key_pendiente: landingZoneKey,
          s3_key_procesado: permanentTargetKey,
          estado: 'pendiente_subida',
          created_at: new Date(timestamp).toISOString(),
        };
        if (extension) {
          spanishPayload.extension = extension;
        }

        const { error: spanishErr } = await supabase.from('archivos').insert(spanishPayload);
        // If extension column doesn't exist on archivos yet, retry without it
        if (spanishErr && spanishErr.message?.includes('extension')) {
          delete spanishPayload.extension;
          await supabase.from('archivos').insert(spanishPayload);
        }
      }
    } catch (dbErr: any) {
      console.error('Error inserting file in Supabase:', dbErr.message);
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
      details: {
        method: req.method,
        uploadMethod: 'PUT',
        ticketId,
        fileId,
        fileName,
        extension,
        mimeType: fileType,
        fileSize,
        resourceType,
        visibility,
        uploadUrl,
        mode: isRealS3 ? 'REAL_AWS_S3' : 'MOCK_SIMULATED',
        s3Landing: landingZoneKey,
        s3Permanent: permanentTargetKey,
        expiresAt,
        ttlSeconds: TTL_SECONDS,
        confirmTokenPreview: confirmToken.substring(0, 20) + '...',
        ip: req.headers.get('x-forwarded-for') || '127.0.0.1',
      },
    });

    return NextResponse.json(
      {
        ticketId,
        fileId,
        uploadUrl,
        method: req.method,
        uploadMethod: 'PUT',
        isRealS3,
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
          permanentTarget: permanentTargetKey,
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
          method: req.method,
          uploadMethod: 'PUT',
          isRealS3,
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

// 3. Upload Confirmation / Mock PUT Fallback
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

  // 1. Retrieve file record from Supabase (files table with fallback to archivos)
  let fileRow: any = null;
  let isLegacyTable = false;

  try {
    const { data: existingFiles, error: errFiles } = await supabase
      .from('files')
      .select('*')
      .eq('ticket_id', ticketId)
      .limit(1);

    if (!errFiles && existingFiles && existingFiles.length > 0) {
      fileRow = existingFiles[0];
    } else {
      const { data: existingArchivos } = await supabase
        .from('archivos')
        .select('*')
        .eq('ticket_id', ticketId)
        .limit(1);

      if (existingArchivos && existingArchivos.length > 0) {
        fileRow = existingArchivos[0];
        isLegacyTable = true;
      }
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
      details: {
        method: req.method,
        ticketId,
        reason: 'Ticket not found in database.',
        ip: req.headers.get('x-forwarded-for') || '127.0.0.1',
      },
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
  const currentStatus = fileRow.status || fileRow.estado;
  if (currentStatus === 'completed' || currentStatus === 'completado') {
    return NextResponse.json(
      {
        error: 'Conflict',
        code: 'TICKET_ALREADY_COMPLETED',
        method: req.method,
        message: `Upload ticket '${ticketId}' has already been confirmed and completed.`,
        ticketId,
        completedAt: fileRow.completed_at || fileRow.completado_at || null,
      },
      { status: 409, headers: corsHeaders }
    );
  }

  // CHECK 3: Expiration Check (5-minute TTL + 2-minute grace window)
  const GRACE_PERIOD_MS = 2 * 60 * 1000;
  const expiresAtStr = fileRow.expires_at || fileRow.expira_en;
  if (expiresAtStr) {
    const expirationTime = new Date(expiresAtStr).getTime();
    if (!isNaN(expirationTime) && Date.now() > expirationTime + GRACE_PERIOD_MS) {
      // Mark as expired in database
      try {
        if (!isLegacyTable) {
          await supabase.from('files').update({ status: 'expired' }).eq('ticket_id', ticketId);
        } else {
          await supabase.from('archivos').update({ estado: 'expirado' }).eq('ticket_id', ticketId);
        }
      } catch (expErr: any) {
        console.warn('Could not mark ticket expired in DB:', expErr.message);
      }

      await addServiceLog({
        method: req.method,
        action: 'TICKET_EXPIRED',
        status: 'DENIED_EXPIRED',
        userId: fileRow.user_id,
        orgId: fileRow.org_id,
        details: {
          method: req.method,
          ticketId,
          fileId: fileRow.id,
          expiresAt: expiresAtStr,
          expiredAgoSeconds: Math.floor((Date.now() - expirationTime) / 1000),
          reason: 'Ticket TTL exceeded (5 min window expired).',
          ip: req.headers.get('x-forwarded-for') || '127.0.0.1',
        },
      });

      return NextResponse.json(
        {
          error: 'Gone',
          code: 'TICKET_EXPIRED',
          method: req.method,
          message: `Upload ticket '${ticketId}' has expired (5-minute TTL exceeded). Request a new upload ticket.`,
          expiresAt: expiresAtStr,
        },
        { status: 410, headers: corsHeaders }
      );
    }
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
        details: {
          method: req.method,
          ticketId,
          reason: tokenResult.reason,
          tokenPreview: confirmToken.substring(0, 16) + '...',
          ip: req.headers.get('x-forwarded-for') || '127.0.0.1',
        },
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

  // 2. Mark ticket completed in Supabase
  const nowIso = new Date().toISOString();
  try {
    if (!isLegacyTable) {
      const { data: updated } = await supabase
        .from('files')
        .update({
          status: 'completed',
          completed_at: nowIso,
          updated_at: nowIso,
        })
        .eq('ticket_id', ticketId)
        .select('*');
      if (updated && updated.length > 0) {
        fileRow = updated[0];
      }
    } else {
      const { data: updated } = await supabase
        .from('archivos')
        .update({
          estado: 'completado',
          completado_at: nowIso,
          updated_at: nowIso,
        })
        .eq('ticket_id', ticketId)
        .select('*');
      if (updated && updated.length > 0) {
        fileRow = updated[0];
      }
    }
  } catch (dbErr: any) {
    console.error('Error updating file status in Supabase:', dbErr.message);
  }

  // 3. Record confirmation audit event in Supabase
  await addServiceLog({
    method: req.method,
    action: 'S3_UPLOAD_CONFIRMED',
    status: 'UPLOADED_LANDING',
    userId: fileRow?.user_id || undefined,
    orgId: fileRow?.org_id || undefined,
    details: {
      method: req.method,
      ticketId,
      fileId: fileRow?.id || null,
      fileName: fileRow?.original_name || fileRow?.nombre_original || null,
      extension: fileRow?.extension || null,
      mimeType: fileRow?.mime_type || fileRow?.formato || null,
      fileSize: fileRow?.size_bytes ?? fileRow?.tamano_bytes ?? null,
      resourceType: fileRow?.resource_type || fileRow?.tipo_recurso || null,
      visibility: fileRow?.visibility || fileRow?.visibilidad || null,
      s3Landing: fileRow?.s3_pending_key || fileRow?.s3_key_pendiente || null,
      s3Permanent: fileRow?.s3_processed_key || fileRow?.s3_key_procesado || null,
      tokenVerified: Boolean(confirmToken),
      ip: req.headers.get('x-forwarded-for') || '127.0.0.1',
      message: `File confirmed in S3 landing zone for ticket ${ticketId}`,
    },
  });

  return NextResponse.json(
    {
      status: 'success',
      method: req.method,
      message: `File upload confirmed for ticket ${ticketId}`,
      ticketId,
      fileId: fileRow?.id || null,
      s3Status: 'uploaded_to_landing',
      s3Landing: fileRow?.s3_pending_key || fileRow?.s3_key_pendiente || null,
      tokenVerified: Boolean(confirmToken),
    },
    { status: 200, headers: corsHeaders }
  );
}
