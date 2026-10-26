import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { addServiceLog } from '@/lib/service-logs';
import { getS3ObjectBuffer, PRIVATE_NO_STORE_CACHE_CONTROL } from '@/lib/s3';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Proxy size ceiling: 4 MB (Vercel Serverless payload ceiling safe margin)
const MAX_PROXY_STREAM_BYTES = 4 * 1024 * 1024;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers':
    'Content-Type, Authorization, x-api-key, x-user-id',
  'X-Content-Type-Options': 'nosniff',
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

/**
 * GET /api/files/[id]/content
 * Serves private files (up to 4 MB) directly through the server without exposing
 * internal S3 keys or bucket URLs to the client or browser.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const fileId = (params?.id || '').trim();
    const ipAddress = req.headers.get('x-forwarded-for') || '127.0.0.1';

    if (!fileId || !UUID_REGEX.test(fileId)) {
      return NextResponse.json(
        {
          error: 'Bad Request',
          code: 'INVALID_FILE_ID',
          message: `El identificador '${fileId || ''}' no tiene un formato UUID v4 válido.`,
        },
        { status: 400, headers: corsHeaders }
      );
    }

    const { data: fileRow, error: dbError } = await supabase
      .from('files')
      .select('id, user_id, org_id, ticket_id, original_name, s3_pending_key, s3_processed_key, mime_type, size_bytes, visibility, status')
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

    // Multi-tenant isolation: cannot access file belonging to another organization
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
        message: `Intento bloqueado de descargar contenido de otra organización (${fileRow.org_id}).`,
      });

      return NextResponse.json(
        {
          error: 'Forbidden',
          code: 'FORBIDDEN_TENANT_MISMATCH',
          message: 'Acceso Denegado: La API Key provista pertenece a una organización distinta a la del archivo.',
        },
        { status: 403, headers: corsHeaders }
      );
    }

    // Privacy verification: private files require matching owner user_id when specified
    const fileVisibility = (fileRow.visibility || 'private').toLowerCase() === 'public' ? 'public' : 'private';
    if (fileVisibility === 'private' && validatedUserId && fileRow.user_id && validatedUserId !== fileRow.user_id) {
      await addServiceLog({
        method: 'GET',
        action: 'ACCESS_DENIED',
        status: 'DENIED_NOT_OWNER',
        userId: validatedUserId,
        orgId: fileRow.org_id,
        fileId: fileRow.id,
        ticketId: fileRow.ticket_id,
        fileName: fileRow.original_name,
        ipAddress,
        message: `Acceso denegado a contenido privado: usuario '${validatedUserId}' no es dueño de '${fileRow.original_name}'.`,
      });

      return NextResponse.json(
        {
          error: 'Forbidden',
          code: 'FORBIDDEN_PRIVATE_NOT_OWNER',
          message: `Acceso Denegado: El archivo es privado y solo puede ser descargado por su propietario.`,
        },
        { status: 403, headers: corsHeaders }
      );
    }

    // Size limit check: enforce 4 MB limit for proxy streaming
    const fileSize = Number(fileRow.size_bytes || 0);
    if (fileSize > MAX_PROXY_STREAM_BYTES) {
      return NextResponse.json(
        {
          error: 'Payload Too Large',
          code: 'PROXY_SIZE_EXCEEDED',
          message:
            'El archivo supera el límite de 4 MB para entrega directa vía proxy. Utilice GET /api/files/[id] para obtener una URL prefirmada de S3.',
          fileSizeBytes: fileSize,
          maxProxyBytes: MAX_PROXY_STREAM_BYTES,
        },
        { status: 413, headers: corsHeaders }
      );
    }

    // Fetch binary object from S3
    const s3Key = fileRow.s3_processed_key || fileRow.s3_pending_key;
    if (!s3Key) {
      return NextResponse.json(
        {
          error: 'Not Found',
          code: 'S3_KEY_NOT_FOUND',
          message: 'El archivo no tiene una ruta de almacenamiento física en S3.',
        },
        { status: 404, headers: corsHeaders }
      );
    }

    const buffer = await getS3ObjectBuffer(s3Key);
    if (!buffer || buffer.length === 0) {
      return NextResponse.json(
        {
          error: 'Storage Error',
          code: 'S3_DOWNLOAD_FAILED',
          message: 'No fue posible descargar los bytes del archivo desde el almacenamiento interno.',
        },
        { status: 500, headers: corsHeaders }
      );
    }

    await addServiceLog({
      method: 'GET',
      action: 'FILE_STREAMED_VIA_PROXY',
      status: 'ALLOWED',
      userId: validatedUserId || fileRow.user_id,
      orgId: fileRow.org_id,
      fileId: fileRow.id,
      ticketId: fileRow.ticket_id,
      fileName: fileRow.original_name,
      ipAddress,
      message: `Contenido descargado vía proxy seguro (${buffer.length} bytes, mime=${fileRow.mime_type}).`,
    });

    const isDocument = String(fileRow.mime_type || '').toLowerCase() === 'application/pdf';
    const dispositionType = isDocument ? 'attachment' : 'inline';
    const safeFileName = (fileRow.original_name || 'file').replace(/["\r\n]/g, '_');

    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        'Content-Type': fileRow.mime_type || 'application/octet-stream',
        'Content-Length': String(buffer.length),
        'Content-Disposition': `${dispositionType}; filename="${safeFileName}"`,
        'Cache-Control': PRIVATE_NO_STORE_CACHE_CONTROL,
        Pragma: 'no-cache',
        Expires: '0',
        'X-Content-Type-Options': 'nosniff',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key, x-user-id',
      },
    });
  } catch (err: any) {
    console.error('Error in proxy file content delivery:', err);
    return NextResponse.json(
      { error: 'Internal Server Error', message: err.message },
      { status: 500, headers: corsHeaders }
    );
  }
}
