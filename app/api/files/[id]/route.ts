import { NextRequest, NextResponse } from 'next/server';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { supabase } from '@/lib/supabase';

// Cabeceras CORS para permitir consumo desde Postman o clientes web
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key',
};

// 1. Manejador Preflight OPTIONS
export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: corsHeaders,
  });
}

// 2. GET /api/files/[id]: Genera URL prefirmada de lectura directa hacia AWS S3
export async function GET(
  req: NextRequest,
  context: { params: { id: string } | Promise<{ id: string }> }
) {
  try {
    // 1. Extraer ID del archivo por parámetro de ruta (compatible Next.js 14/15)
    const resolvedParams = await Promise.resolve(context.params);
    const fileId = resolvedParams?.id?.trim();

    if (!fileId) {
      return NextResponse.json(
        {
          error: 'Bad Request',
          code: 'MISSING_FILE_ID',
          message: 'El identificador del archivo (id) es requerido en la ruta.',
        },
        { status: 400, headers: corsHeaders }
      );
    }

    // 2. Consultar la tabla files en Supabase para obtener la clave de S3 y org_id
    const { data: fileRow, error: dbError } = await supabase
      .from('files')
      .select('id, org_id, original_name, s3_pending_key, s3_processed_key, status, mime_type')
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

    // Determinar la ruta física en S3:
    // Mientras el archivo no haya sido procesado/movido por Lambda (status !== 'processed'),
    // el archivo físico reside en s3_pending_key (zona de aterrizaje).
    let s3Key = fileRow.s3_pending_key;
    if (fileRow.status === 'processed' && fileRow.s3_processed_key) {
      s3Key = fileRow.s3_processed_key;
    } else if (!s3Key && fileRow.s3_processed_key) {
      s3Key = fileRow.s3_processed_key;
    }

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

    // Validación defensiva Multi-Tenant: si el middleware inyectó x-validated-org-id, contrastar con org_id
    const validatedOrgId = req.headers.get('x-validated-org-id');
    if (validatedOrgId && validatedOrgId !== fileRow.org_id) {
      return NextResponse.json(
        {
          error: 'Forbidden',
          code: 'FORBIDDEN_TENANT_MISMATCH',
          message: 'Acceso Denegado: La llave API provista pertenece a una organización distinta a la del archivo.',
        },
        { status: 403, headers: corsHeaders }
      );
    }

    // 3. Configurar cliente AWS S3
    const region = process.env.AWS_REGION || 'us-east-1';
    const bucketName = process.env.AWS_S3_BUCKET_NAME || '';

    if (!bucketName || !process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
      return NextResponse.json(
        {
          error: 'Configuration Error',
          code: 'AWS_S3_NOT_CONFIGURED',
          message: 'El servicio de almacenamiento AWS S3 no se encuentra configurado en las variables de entorno.',
        },
        { status: 500, headers: corsHeaders }
      );
    }

    const s3Client = new S3Client({
      region,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID.trim(),
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY.trim(),
      },
    });

    // 4. Preparar GetObjectCommand
    // Por defecto se establece 'inline' para que el navegador renderice imágenes, PDFs y texto
    // directamente en la pestaña en vez de forzar una descarga. Si se envía ?download=true se fuerza attachment.
    const isDownload = req.nextUrl.searchParams.get('download') === 'true';
    const disposition = isDownload
      ? `attachment; filename="${encodeURIComponent(fileRow.original_name)}"`
      : 'inline';

    const getCommand = new GetObjectCommand({
      Bucket: bucketName.trim(),
      Key: s3Key,
      ResponseContentType: fileRow.mime_type || undefined,
      ResponseContentDisposition: disposition,
    });

    // 5. Generar URL prefirmada temporal con expiración de 5 minutos (300 segundos)
    const EXPIRES_IN_SECONDS = 300;
    const presignedDownloadUrl = await getSignedUrl(s3Client, getCommand, {
      expiresIn: EXPIRES_IN_SECONDS,
    });

    // 6. Devolver al cliente el JSON con la propiedad { url: "la_url_generada" }
    return NextResponse.json(
      {
        url: presignedDownloadUrl,
        fileId: fileRow.id,
        fileName: fileRow.original_name,
        orgId: fileRow.org_id,
        s3Key,
        expiresInSeconds: EXPIRES_IN_SECONDS,
      },
      {
        status: 200,
        headers: corsHeaders,
      }
    );
  } catch (error: any) {
    console.error('Error al generar URL prefirmada de lectura:', error);
    return NextResponse.json(
      {
        error: 'Internal Server Error',
        message: error.message || 'Error inesperado al generar la URL de descarga.',
      },
      { status: 500, headers: corsHeaders }
    );
  }
}
