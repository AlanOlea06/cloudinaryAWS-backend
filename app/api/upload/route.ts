import { NextRequest, NextResponse } from 'next/server';
import { USERS, ORGANIZATIONS, addServiceLog } from '@/lib/service-logs';
import { supabase } from '@/lib/supabase';
import { isAwsConfigured, generatePresignedUploadUrl } from '@/lib/s3';

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
    } = body;

    // CHECK 1: User Authentication / Registration
    const user = userId ? USERS[userId] : null;
    if (!user) {
      await addServiceLog({
        action: 'TICKET_REQUEST',
        status: 'DENIED_NOT_REGISTERED',
        userId: userId || 'unknown',
        userName: 'Unregistered User',
        targetOrgId: orgId,
        details: {
          reason: 'User does not exist in the database.',
          ip: req.headers.get('x-forwarded-for') || '127.0.0.1',
          fileName,
        },
      });

      return NextResponse.json(
        {
          error: 'Unauthorized',
          code: 'USER_NOT_REGISTERED',
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
          message: 'Target organization does not exist.',
        },
        { status: 404, headers: corsHeaders }
      );
    }

    // CHECK 2: Multi-Tenant Isolation (Disallow uploading to a foreign organization)
    if (user.orgId !== orgId) {
      await addServiceLog({
        action: 'CROSS_ORG_VIOLATION',
        status: 'DENIED_CROSS_ORG',
        userId: user.id,
        userName: user.name,
        orgId: user.orgId,
        orgName: userOrg?.name,
        targetOrgId: orgId,
        details: {
          alert: 'CROSS-ORGANIZATION UPLOAD ATTEMPT BLOCKED',
          originOrg: userOrg?.name,
          destinationOrg: targetOrg.name,
          fileName,
          ip: req.headers.get('x-forwarded-for') || '127.0.0.1',
        },
      });

      return NextResponse.json(
        {
          error: 'Forbidden',
          code: 'FORBIDDEN_CROSS_ORGANIZATION',
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
        action: 'INSUFFICIENT_PERMISSIONS',
        status: 'DENIED_NO_PERMISSION',
        userId: user.id,
        userName: user.name,
        orgId: user.orgId,
        orgName: userOrg?.name,
        details: {
          reason: 'User has a viewer role and lacks upload authorization.',
          fileName,
        },
      });

      return NextResponse.json(
        {
          error: 'Forbidden',
          code: 'FORBIDDEN_NO_PERMISSION',
          message: `Permission Denied: User '${user.name}' is not authorized to upload files to '${userOrg?.name}'.`,
        },
        { status: 403, headers: corsHeaders }
      );
    }

    // ALL CHECKS PASSED -> Generate Ticket & S3 Keys
    const fileId = crypto.randomUUID();
    const ticketId = crypto.randomUUID();
    const timestamp = Date.now();
    const orgSlug = targetOrg.slug;

    // Resource categorization (images, documents, videos)
    let resourceType: 'images' | 'documents' | 'videos' = 'documents';
    if (fileType.startsWith('image/')) resourceType = 'images';
    else if (fileType.startsWith('video/')) resourceType = 'videos';

    // Standardized S3 Key hierarchy
    const landingZoneKey = `pending/${user.id}/${fileName}`;
    const permanentTargetKey = `organizations/${orgSlug}/${resourceType}/${visibility}/${ticketId}-${fileName}`;

    // Determine AWS S3 direct upload vs Mock fallback
    const forceMock = req.headers.get('x-mock-mode') === 'true' && !isAwsConfigured();
    let uploadUrl = '';
    let isRealS3 = false;

    if (isAwsConfigured() && !forceMock) {
      try {
        const presignedS3Url = await generatePresignedUploadUrl(landingZoneKey, fileType, 900);
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
      const { error: englishErr } = await supabase.from('files').insert({
        id: fileId,
        ticket_id: ticketId,
        user_id: user.id,
        org_id: targetOrg.id,
        original_name: fileName,
        mime_type: fileType,
        size_bytes: fileSize,
        sha256_hash: sha256Hash,
        resource_type: resourceType,
        visibility,
        s3_pending_key: landingZoneKey,
        s3_processed_key: permanentTargetKey,
        status: 'pending_upload',
        created_at: new Date(timestamp).toISOString(),
      });

      if (englishErr) {
        // Fallback to Spanish table if not yet migrated
        const spanishVisibility = visibility === 'private' ? 'privados' : 'publicos';
        const spanishType = resourceType === 'images' ? 'imagenes' : resourceType;

        await supabase.from('archivos').insert({
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
        });
      }
    } catch (dbErr: any) {
      console.error('Error inserting file in Supabase:', dbErr.message);
    }

    // 2. Record audit log event in Supabase
    await addServiceLog({
      action: 'TICKET_ISSUED',
      status: 'ALLOWED',
      userId: user.id,
      userName: user.name,
      orgId: user.orgId,
      orgName: userOrg?.name,
      targetOrgId: orgId,
      details: {
        ticketId,
        fileId,
        fileName,
        fileSize,
        resourceType,
        visibility,
        mode: isRealS3 ? 'REAL_AWS_S3' : 'MOCK_SIMULATED',
        s3Landing: landingZoneKey,
        s3Permanent: permanentTargetKey,
      },
    });

    return NextResponse.json(
      {
        ticketId,
        fileId,
        uploadUrl,
        isRealS3,
        isMultipart: fileSize > 20 * 1024 * 1024,
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
          fileSize,
          sha256Hash,
          isRealS3,
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
  const ticketId = searchParams.get('ticketId') || 'unknown';

  // 1. Update file status in Supabase
  try {
    const nowIso = new Date().toISOString();
    const { error: errFiles } = await supabase
      .from('files')
      .update({
        status: 'completed',
        completed_at: nowIso,
        updated_at: nowIso,
      })
      .eq('ticket_id', ticketId);

    if (errFiles) {
      await supabase
        .from('archivos')
        .update({
          estado: 'completado',
          completado_at: nowIso,
          updated_at: nowIso,
        })
        .eq('ticket_id', ticketId);
    }
  } catch (dbErr: any) {
    console.error('Error updating file in Supabase:', dbErr.message);
  }

  // 2. Record confirmation audit event
  await addServiceLog({
    action: 'S3_UPLOAD_CONFIRMED',
    status: 'UPLOADED_LANDING',
    details: {
      ticketId,
      message: `File confirmed in S3 landing zone for ticket ${ticketId}`,
    },
  });

  return NextResponse.json(
    {
      status: 'success',
      message: `File upload confirmed for ticket ${ticketId}`,
      ticketId,
      s3Status: 'uploaded_to_landing',
    },
    { status: 200, headers: corsHeaders }
  );
}
