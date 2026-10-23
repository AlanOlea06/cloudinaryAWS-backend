import { NextRequest, NextResponse } from 'next/server';
import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { supabase } from '@/lib/supabase';
import { addServiceLog } from '@/lib/service-logs';
import {
  generateCloudFrontUrl,
  getBaseCloudFrontUrl,
  isCloudFrontConfigured,
} from '@/lib/cloudfront';

// Cabeceras CORS para permitir consumo desde Postman o clientes web
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key',
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

// 2. GET /api/files/[id]: Genera URL de consumo a través de la CDN Amazon CloudFront
export async function GET(
  req: NextRequest,
  context: { params: { id: string } | Promise<{ id: string }> }
) {
  try {
    // 1. Extraer ID del archivo por parámetro de ruta (compatible Next.js 14/15)
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

    // 2. Consultar la tabla files en Supabase para obtener la clave de S3 y org_id
    const { data: fileRow, error: dbError } = await supabase
      .from('files')
      .select('id, org_id, original_name, s3_pending_key, s3_processed_key, cloudfront_url, status, mime_type, visibility')
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

    // Determinar la ruta física en S3 que servirá como origen para CloudFront:
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

    // 3. Verificar configuración de Amazon CloudFront
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

    // 4. Generar URL de entrega por CloudFront bajo el Behavior /static/*
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

    // 5. Persistir cloudfront_url en Supabase si aún estaba vacío
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

    // 6. Devolver al cliente el JSON con la URL de CloudFront
    return NextResponse.json(
      {
        url: cfResult.url,
        delivery: 'cloudfront',
        cloudfrontDomain: cfResult.domain,
        fileId: fileRow.id,
        fileName: fileRow.original_name,
        orgId: fileRow.org_id,
        s3Key,
      },
      {
        status: 200,
        headers: corsHeaders,
      }
    );
  } catch (error: any) {
    console.error('Error al generar URL de CloudFront:', error);
    return NextResponse.json(
      {
        error: 'Internal Server Error',
        message: error.message || 'Error inesperado al generar la URL de entrega en CloudFront.',
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

    // 3. Eliminar de AWS S3 si tiene s3_pending_key o s3_processed_key
    const region = process.env.AWS_REGION || 'us-east-1';
    const bucketName = process.env.AWS_S3_BUCKET_NAME || '';

    if (bucketName && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
      const s3Client = new S3Client({
        region,
        credentials: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID.trim(),
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY.trim(),
        },
      });

      const keysToDelete = [fileRow.s3_pending_key, fileRow.s3_processed_key].filter(Boolean);
      for (const k of keysToDelete) {
        try {
          await s3Client.send(new DeleteObjectCommand({
            Bucket: bucketName.trim(),
            Key: k,
          }));
        } catch (s3Err: any) {
          console.warn(`Error eliminando ${k} de S3:`, s3Err.message);
        }
      }
    }

    // 4. Eliminar el registro de public.files en Supabase
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

    // 5. Registrar log de auditoría en service_logs (3NF puro relacional)
    await addServiceLog({
      method: 'DELETE',
      action: 'FILE_DELETED',
      status: 'ALLOWED',
      userId: fileRow.user_id,
      orgId: fileRow.org_id,
      fileId: fileRow.id,
      ticketId: fileRow.ticket_id,
      fileName: fileRow.original_name,
      ipAddress: req.headers.get('x-forwarded-for') || '127.0.0.1',
      message: `File '${fileRow.original_name}' permanently deleted from S3 and Supabase.`,
    });

    return NextResponse.json(
      {
        status: 'success',
        message: `El archivo '${fileRow.original_name}' fue eliminado exitosamente de S3 y de Supabase.`,
        deletedFileId: fileId,
        ticketId: fileRow.ticket_id,
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

