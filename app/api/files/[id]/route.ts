import { NextRequest, NextResponse } from 'next/server';
import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { supabase } from '@/lib/supabase';
import { addServiceLog } from '@/lib/service-logs';
import {
  generateCloudFrontUrl,
  getBaseCloudFrontUrl,
  isCloudFrontConfigured,
} from '@/lib/cloudfront';
import {
  generatePresignedReadUrl,
  abortS3MultipartUpload,
  deleteS3Object,
  PRIVATE_NO_STORE_CACHE_CONTROL,
  PUBLIC_SHORT_TTL_CACHE_CONTROL,
} from '@/lib/s3';

// Cabeceras CORS para permitir consumo desde Postman o clientes web
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key, x-user-id',
};

// Validador de formato UUID v4
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 1. Manejador Preflight OPTIONS
export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: corsHeaders,
  });
}

// 2. GET /api/files/[id]:
// - Archivos 'private': NUNCA usan ni guardan cloudfront_url; entregan URL prefirmada de S3 (GetObject, 5 min) tras validar permisos.
// - Archivos 'public': Entregan URL de CloudFront (/static/*) con TTL corto (5 min).
export async function GET(
  req: NextRequest,
  context: { params: { id: string } | Promise<{ id: string }> }
) {
  try {
    // 1. Extraer ID del archivo por parámetro de ruta (compatible Next.js 14/15)
    const resolvedParams = await Promise.resolve(context.params);
    const fileId = resolvedParams?.id?.trim();
    const ipAddress = req.headers.get('x-forwarded-for') || '127.0.0.1';

    if (!fileId || !UUID_REGEX.test(fileId)) {
      return NextResponse.json(
        {
          error: 'Bad Request',
          code: 'INVALID_FILE_ID',
          message: `El identificador '${fileId || ''}' no tiene un formato UUID v4 válido (ejemplo: 120b2a88-aa8d-4fde-92e5-de4bb87ea550).`,
        },
        { status: 400, headers: corsHeaders }
      );
    }

    // 2. Consultar la tabla files en Supabase para obtener la clave de S3, user_id, org_id y visibility
    const { data: fileRow, error: dbError } = await supabase
      .from('files')
      .select('id, user_id, org_id, ticket_id, original_name, s3_pending_key, s3_processed_key, cloudfront_url, status, mime_type, visibility')
      .eq('id', fileId)
      .maybeSingle();

    if (dbError) {
      return NextResponse.json(
        {
          error: 'Database Error',
          code: 'DB_QUERY_FAILED',
          message: dbError.message,
        },
        { status: 500, headers: corsHeaders }
      );
    }

    if (!fileRow) {
      return NextResponse.json(
        {
          error: 'Not Found',
          code: 'FILE_NOT_FOUND',
          message: `El archivo con id '${fileId}' no existe en la base de datos.`,
        },
        { status: 404, headers: corsHeaders }
      );
    }

    const validatedOrgId = (req.headers.get('x-validated-org-id') || '').trim();
    const validatedUserId = (req.headers.get('x-validated-user-id') || '').trim();
    const queryUserId = (req.nextUrl.searchParams.get('userId') || '').trim();

    // Registrar solicitud inicial de lectura (FILE_REQUESTED)
    await addServiceLog({
      method: 'GET',
      action: 'FILE_REQUESTED',
      status: 'ALLOWED',
      userId: validatedUserId || fileRow.user_id,
      orgId: validatedOrgId || fileRow.org_id,
      fileId: fileRow.id,
      ticketId: fileRow.ticket_id,
      fileName: fileRow.original_name,
      ipAddress,
      message: `Solicitud de lectura para archivo '${fileRow.original_name}' (visibility=${fileRow.visibility || 'private'}).`,
    });

    // Determinar la ruta física en S3 (priorizar siempre s3_processed_key en static/files/ cuando existe):
    const s3Key = fileRow.s3_processed_key || fileRow.s3_pending_key;

    if (!s3Key) {
      return NextResponse.json(
        {
          error: 'Not Found',
          code: 'S3_KEY_NOT_FOUND',
          message: 'El archivo no tiene una ruta de almacenamiento asociada en S3.',
        },
        { status: 404, headers: corsHeaders }
      );
    }

    // 3. Validación defensiva Multi-Tenant: si el middleware inyectó x-validated-org-id, contrastar con org_id
    if (validatedOrgId && validatedOrgId !== fileRow.org_id) {
      await addServiceLog({
        method: 'GET',
        action: 'ACCESS_DENIED',
        status: 'DENIED_CROSS_ORG',
        userId: validatedUserId || undefined,
        orgId: validatedOrgId,
        targetOrgId: fileRow.org_id,
        fileId: fileRow.id,
        ticketId: fileRow.ticket_id,
        fileName: fileRow.original_name,
        ipAddress,
        message: `Intento bloqueado de leer archivo de otra organización (${fileRow.org_id}).`,
      });

      return NextResponse.json(
        {
          error: 'Forbidden',
          code: 'FORBIDDEN_TENANT_MISMATCH',
          message: 'Acceso Denegado: La llave API provista pertenece a una organización distinta a la del archivo.',
        },
        { status: 403, headers: corsHeaders }
      );
    }

    // 4. Bloquear discrepancia entre query ?userId y el usuario validado por el middleware
    if (validatedUserId && queryUserId && queryUserId !== validatedUserId) {
      await addServiceLog({
        method: 'GET',
        action: 'ACCESS_DENIED',
        status: 'DENIED_USER_IMPERSONATION',
        userId: validatedUserId,
        orgId: fileRow.org_id,
        fileId: fileRow.id,
        ticketId: fileRow.ticket_id,
        fileName: fileRow.original_name,
        ipAddress,
        message: `Intento de suplantación bloqueado en lectura: el contexto validado es '${validatedUserId}', pero se solicitó query userId='${queryUserId}'.`,
      });

      return NextResponse.json(
        {
          error: 'Forbidden',
          code: 'FORBIDDEN_USER_IMPERSONATION',
          message:
            'Acceso Denegado: El userId enviado no coincide con el usuario validado en la cabecera x-user-id / API Key.',
          authenticatedUserId: validatedUserId,
          attemptedUserId: queryUserId,
        },
        {
          status: 403,
          headers: {
            ...corsHeaders,
            'Cache-Control': PRIVATE_NO_STORE_CACHE_CONTROL,
            Pragma: 'no-cache',
          },
        }
      );
    }

    // 5. Control de Acceso y Entrega por Visibilidad ('private' vs 'public')
    // Solo se toma el usuario validado por el middleware (x-validated-user-id)
    const fileVisibility = (fileRow.visibility || 'private').toLowerCase() === 'public' ? 'public' : 'private';
    const requestingUserId = validatedUserId;

    if (fileVisibility === 'private') {
      if (!requestingUserId) {
        await addServiceLog({
          method: 'GET',
          action: 'ACCESS_DENIED',
          status: 'DENIED_PRIVATE_NO_USER',
          orgId: fileRow.org_id,
          fileId: fileRow.id,
          ticketId: fileRow.ticket_id,
          fileName: fileRow.original_name,
          ipAddress,
          message: `Acceso bloqueado a archivo privado '${fileRow.original_name}': no se identificó al usuario propietario.`,
        });

        return NextResponse.json(
          {
            error: 'Forbidden',
            code: 'FORBIDDEN_PRIVATE_USER_REQUIRED',
            visibility: 'private',
            fileId: fileRow.id,
            message:
              'Acceso Denegado: Este archivo tiene estado "private". Se requiere una API Key vinculada al propietario o identificar la cuenta mediante "?userId=..." / "x-user-id".',
          },
          {
            status: 403,
            headers: {
              ...corsHeaders,
              'Cache-Control': PRIVATE_NO_STORE_CACHE_CONTROL,
              Pragma: 'no-cache',
            },
          }
        );
      }

      if (requestingUserId !== fileRow.user_id) {
        let requesterName = 'Usuario No Autorizado';
        let ownerName = 'Propietario';

        const { data: involvedUsers } = await supabase
          .from('users')
          .select('id, name')
          .in('id', [requestingUserId, fileRow.user_id]);

        if (involvedUsers) {
          const reqUser = involvedUsers.find((u: any) => u.id === requestingUserId);
          const ownUser = involvedUsers.find((u: any) => u.id === fileRow.user_id);
          if (reqUser?.name) requesterName = reqUser.name;
          if (ownUser?.name) ownerName = ownUser.name;
        }

        await addServiceLog({
          method: 'GET',
          action: 'ACCESS_DENIED',
          status: 'DENIED_NOT_OWNER',
          userId: requestingUserId,
          userName: requesterName,
          orgId: fileRow.org_id,
          fileId: fileRow.id,
          ticketId: fileRow.ticket_id,
          fileName: fileRow.original_name,
          ipAddress,
          message: `Acceso bloqueado a archivo privado '${fileRow.original_name}': '${requesterName}' (${requestingUserId}) intentó leer un recurso privado perteneciente a '${ownerName}' (${fileRow.user_id}).`,
        });

        return NextResponse.json(
          {
            error: 'Forbidden',
            code: 'FORBIDDEN_PRIVATE_NOT_OWNER',
            visibility: 'private',
            fileId: fileRow.id,
            requestedByUserId: requestingUserId,
            requestedByUserName: requesterName,
            message: `Acceso Denegado: El archivo '${fileRow.original_name}' es privado ('private') y solo puede ser leído por la cuenta propietaria que lo subió.`,
          },
          {
            status: 403,
            headers: {
              ...corsHeaders,
              'Cache-Control': PRIVATE_NO_STORE_CACHE_CONTROL,
              Pragma: 'no-cache',
            },
          }
        );
      }

      // Tarea A.2: Archivo PRIVADO con permisos validados ->
      // 1) Asegurar que cloudfront_url sea NULL en la base de datos
      if (fileRow.cloudfront_url !== null) {
        await supabase
          .from('files')
          .update({
            cloudfront_url: null,
            updated_at: new Date().toISOString(),
          })
          .eq('id', fileRow.id);
      }

      // 2) Generar URL prefirmada de S3 para lectura con TTL de 5 minutos (300 segundos)
      const PRIVATE_READ_TTL_SECONDS = 300;
      const s3PresignedReadUrl = await generatePresignedReadUrl(s3Key, PRIVATE_READ_TTL_SECONDS);

      if (!s3PresignedReadUrl) {
        return NextResponse.json(
          {
            error: 'Storage Error',
            code: 'S3_PRESIGNED_READ_FAILED',
            message: 'No fue posible generar la URL prefirmada de lectura en S3 para el archivo privado.',
          },
          { status: 500, headers: corsHeaders }
        );
      }

      await addServiceLog({
        method: 'GET',
        action: 'URL_ISSUED',
        status: 'ALLOWED',
        userId: fileRow.user_id,
        orgId: fileRow.org_id,
        fileId: fileRow.id,
        ticketId: fileRow.ticket_id,
        fileName: fileRow.original_name,
        ipAddress,
        message: `URL prefirmada de S3 (TTL 300s) emitida para archivo privado '${fileRow.original_name}' al propietario (${fileRow.user_id}).`,
      });

      return NextResponse.json(
        {
          url: s3PresignedReadUrl,
          delivery: 's3_presigned',
          expiresInSeconds: PRIVATE_READ_TTL_SECONDS,
          cloudfrontUrl: null,
          fileId: fileRow.id,
          fileName: fileRow.original_name,
          orgId: fileRow.org_id,
          ownerUserId: fileRow.user_id,
          visibility: 'private',
          cacheControl: PRIVATE_NO_STORE_CACHE_CONTROL,
        },
        {
          status: 200,
          headers: {
            ...corsHeaders,
            'Cache-Control': PRIVATE_NO_STORE_CACHE_CONTROL,
            Pragma: 'no-cache',
            Expires: '0',
          },
        }
      );
    }

    // 6. Archivo PÚBLICO -> Entregar exclusivamente por Amazon CloudFront CDN con TTL corto (5 min)
    if (!isCloudFrontConfigured()) {
      return NextResponse.json(
        {
          error: 'Configuration Error',
          code: 'CLOUDFRONT_NOT_CONFIGURED',
          message:
            'El dominio de Amazon CloudFront (AWS_CLOUDFRONT_DOMAIN) no se encuentra configurado en las variables de entorno.',
        },
        { status: 500, headers: corsHeaders }
      );
    }

    const cfResult = generateCloudFrontUrl(s3Key);

    if (!cfResult) {
      return NextResponse.json(
        {
          error: 'Configuration Error',
          code: 'CLOUDFRONT_URL_GENERATION_FAILED',
          message: 'No fue posible generar la URL de entrega de CloudFront.',
        },
        { status: 500, headers: corsHeaders }
      );
    }

    // Persistir cloudfront_url en Supabase únicamente para archivos públicos
    const baseCfUrl = getBaseCloudFrontUrl(s3Key);
    if (baseCfUrl && fileRow.cloudfront_url !== baseCfUrl) {
      await supabase
        .from('files')
        .update({
          cloudfront_url: baseCfUrl,
          updated_at: new Date().toISOString(),
        })
        .eq('id', fileRow.id);
    }

    await addServiceLog({
      method: 'GET',
      action: 'URL_ISSUED',
      status: 'ALLOWED',
      userId: requestingUserId || fileRow.user_id,
      orgId: fileRow.org_id,
      fileId: fileRow.id,
      ticketId: fileRow.ticket_id,
      fileName: fileRow.original_name,
      ipAddress,
      message: `URL pública de CloudFront emitida para archivo '${fileRow.original_name}'.`,
    });

    return NextResponse.json(
      {
        url: cfResult.url,
        delivery: 'cloudfront',
        cloudfrontDomain: cfResult.domain,
        cloudfrontUrl: cfResult.url,
        fileId: fileRow.id,
        fileName: fileRow.original_name,
        orgId: fileRow.org_id,
        ownerUserId: fileRow.user_id,
        visibility: 'public',
        cacheControl: PUBLIC_SHORT_TTL_CACHE_CONTROL,
      },
      {
        status: 200,
        headers: {
          ...corsHeaders,
          'Cache-Control': PUBLIC_SHORT_TTL_CACHE_CONTROL,
        },
      }
    );
  } catch (error: any) {
    console.error('Error al generar URL de entrega:', error);
    return NextResponse.json(
      {
        error: 'Internal Server Error',
        message: error.message || 'Error inesperado al generar la URL de entrega.',
      },
      { status: 500, headers: corsHeaders }
    );
  }
}

// 3. DELETE /api/files/[id]: Elimina físicamente el archivo en AWS S3, borra la fila en public.files y registra auditoría
export async function DELETE(
  req: NextRequest,
  context: { params: { id: string } | Promise<{ id: string }> }
) {
  try {
    const resolvedParams = await Promise.resolve(context.params);
    const fileId = resolvedParams?.id?.trim();

    if (!fileId || !UUID_REGEX.test(fileId)) {
      return NextResponse.json(
        {
          error: 'Bad Request',
          code: 'INVALID_FILE_ID',
          message: `El identificador '${fileId || ''}' no tiene un formato UUID v4 válido (ejemplo: 120b2a88-aa8d-4fde-92e5-de4bb87ea550).`,
        },
        { status: 400, headers: corsHeaders }
      );
    }

    // 1. Consultar el archivo en Supabase
    const { data: fileRow, error: dbError } = await supabase
      .from('files')
      .select('*')
      .eq('id', fileId)
      .maybeSingle();

    if (dbError) {
      return NextResponse.json(
        { error: 'Database Error', message: dbError.message },
        { status: 500, headers: corsHeaders }
      );
    }

    if (!fileRow) {
      return NextResponse.json(
        {
          error: 'Not Found',
          code: 'FILE_NOT_FOUND',
          message: `El archivo con id '${fileId}' no existe en la base de datos.`,
        },
        { status: 404, headers: corsHeaders }
      );
    }

    // 2. Validación Multi-Tenant defensiva (Edge Middleware inyecta x-validated-org-id si se usó API Key)
    const validatedOrgId = req.headers.get('x-validated-org-id');
    if (validatedOrgId && validatedOrgId !== fileRow.org_id) {
      return NextResponse.json(
        {
          error: 'Forbidden',
          code: 'FORBIDDEN_TENANT_MISMATCH',
          message: 'Acceso Denegado: La llave API provista no pertenece a la organización del archivo.',
        },
        { status: 403, headers: corsHeaders }
      );
    }

    // 3. Task B.10: Si tiene un multipart upload activo (s3_upload_id), abortarlo primero
    let multipartAborted = false;
    if (fileRow.s3_upload_id && fileRow.s3_pending_key) {
      try {
        await abortS3MultipartUpload(fileRow.s3_pending_key, fileRow.s3_upload_id);
        multipartAborted = true;
      } catch (abortErr: any) {
        console.warn(`Error abortando multipart ${fileRow.s3_upload_id}:`, abortErr.message);
      }
    }

    // 4. Task B.10: Eliminar de AWS S3 TANTO la clave pendiente (s3_pending_key) COMO la clave final (s3_processed_key)
    const keysToDelete = Array.from(
      new Set([fileRow.s3_pending_key, fileRow.s3_processed_key].filter(Boolean))
    ) as string[];
    const deletedS3Keys: string[] = [];

    for (const k of keysToDelete) {
      try {
        await deleteS3Object(k);
        deletedS3Keys.push(k);
      } catch (s3Err: any) {
        console.warn(`Error eliminando ${k} de S3:`, s3Err.message);
      }
    }

    // 5. Eliminar el registro de public.files en Supabase
    const { error: delError } = await supabase
      .from('files')
      .delete()
      .eq('id', fileId);

    if (delError) {
      return NextResponse.json(
        { error: 'Database Error', message: delError.message },
        { status: 500, headers: corsHeaders }
      );
    }

    // 6. Registrar log de auditoría en service_logs (3NF puro relacional)
    await addServiceLog({
      method: 'DELETE',
      action: 'FILE_DELETED',
      status: 'ALLOWED',
      userId: fileRow.user_id,
      orgId: fileRow.org_id,
      ticketId: fileRow.ticket_id,
      fileName: fileRow.original_name,
      ipAddress: req.headers.get('x-forwarded-for') || '127.0.0.1',
      message: `File '${fileRow.original_name}' permanently deleted from S3 (keys: ${deletedS3Keys.join(', ')}) and Supabase.`,
    });

    return NextResponse.json(
      {
        status: 'success',
        message: `El archivo '${fileRow.original_name}' fue eliminado exitosamente de S3 y de Supabase.`,
        deletedFileId: fileId,
        ticketId: fileRow.ticket_id,
        deletedS3Keys,
        pendingKeyDeleted: Boolean(fileRow.s3_pending_key),
        processedKeyDeleted: Boolean(fileRow.s3_processed_key),
        multipartAborted,
      },
      { status: 200, headers: corsHeaders }
    );
  } catch (error: any) {
    console.error('Error al eliminar archivo:', error);
    return NextResponse.json(
      {
        error: 'Internal Server Error',
        message: error.message || 'Error inesperado al eliminar el archivo.',
      },
      { status: 500, headers: corsHeaders }
    );
  }
}

