// ============================================================================
// [TEMPORARY-LAMBDA-FALLBACK: TASK-B7-STATUS-ENDPOINT]
// Búsqueda rápida: "TEMPORARY-LAMBDA-FALLBACK"
// Endpoint de consulta de estado de procesamiento (GET) y disparo manual de
// processUpload / Webhook firmado con HMAC-SHA256 (POST).
// ============================================================================

import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { processUpload, ENABLE_SERVER_PROCESSING_FALLBACK } from '@/lib/lambda-fallback/process-upload';
import { dispatchFileWebhook } from '@/lib/lambda-fallback/webhook-dispatcher';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key, x-user-id',
};

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

/**
 * Task B.7: GET /api/files/[id]/status
 * Returns the full processing and scan status of a file.
 * Private files never expose cloudfrontUrl.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const fileId = (params?.id || '').trim();
    if (!fileId || !UUID_REGEX.test(fileId)) {
      return NextResponse.json(
        {
          error: 'Bad Request',
          code: 'INVALID_FILE_ID',
          message: `El identificador '${fileId}' no tiene un formato UUID v4 válido.`,
        },
        { status: 400, headers: corsHeaders }
      );
    }

    const validatedOrgId = req.headers.get('x-validated-org-id');
    const validatedUserId = req.headers.get('x-validated-user-id');

    const { data: fileRow, error: fetchErr } = await supabase
      .from('files')
      .select('*')
      .eq('id', fileId)
      .maybeSingle();

    if (fetchErr || !fileRow) {
      return NextResponse.json(
        {
          error: 'Not Found',
          code: 'FILE_NOT_FOUND',
          message: `No se encontró el archivo con ID '${fileId}'.`,
        },
        { status: 404, headers: corsHeaders }
      );
    }

    if (validatedOrgId && fileRow.org_id && fileRow.org_id !== validatedOrgId) {
      return NextResponse.json(
        {
          error: 'Forbidden',
          code: 'FORBIDDEN_CROSS_ORGANIZATION',
          message: 'No tienes permiso para consultar el estado de archivos de otra organización.',
        },
        { status: 403, headers: corsHeaders }
      );
    }

    const visibility = String(fileRow.visibility || 'private').toLowerCase() === 'public' ? 'public' : 'private';

    if (visibility === 'private' && validatedUserId && fileRow.user_id && fileRow.user_id !== validatedUserId) {
      return NextResponse.json(
        {
          error: 'Forbidden',
          code: 'FORBIDDEN_PRIVATE_NOT_OWNER',
          message: 'El archivo es privado y solo su propietario puede consultar su estado.',
        },
        { status: 403, headers: corsHeaders }
      );
    }

    return NextResponse.json(
      {
        status: 'success',
        fileId: fileRow.id,
        ticketId: fileRow.ticket_id,
        orgId: fileRow.org_id,
        ownerUserId: fileRow.user_id,
        originalName: fileRow.original_name,
        extension: fileRow.extension,
        mimeType: fileRow.mime_type,
        sizeBytes: Number(fileRow.size_bytes),
        sha256Hash: fileRow.sha256_hash || null,
        visibility,
        fileStatus: fileRow.status,
        dbStatus: fileRow.status,
        sha256Verified: Boolean(fileRow.sha256_verified),
        scanStatus: fileRow.scan_status || 'not_scanned',
        cloudfrontUrl: visibility === 'public' ? fileRow.cloudfront_url : null,
        retryCount: Number(fileRow.retry_count || 0),
        errorMessage: fileRow.error_message || null,
        createdAt: fileRow.created_at,
        updatedAt: fileRow.updated_at || null,
        completedAt: fileRow.completed_at || null,
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

/**
 * Task B.6 & B.7: POST /api/files/[id]/status
 * Triggers or retries `processUpload(fileId)` on demand, or dispatches an HMAC-SHA256 webhook.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const fileId = (params?.id || '').trim();
    if (!fileId || !UUID_REGEX.test(fileId)) {
      return NextResponse.json(
        {
          error: 'Bad Request',
          code: 'INVALID_FILE_ID',
          message: `El identificador '${fileId}' no tiene un formato UUID v4 válido.`,
        },
        { status: 400, headers: corsHeaders }
      );
    }

    const body = await req.json().catch(() => ({}));
    const webhookUrl = body?.webhookUrl || null;
    const webhookSecret = body?.webhookSecret || null;
    const clientIp = req.headers.get('x-forwarded-for') || '127.0.0.1';

    const { data: fileRow } = await supabase
      .from('files')
      .select('*')
      .eq('id', fileId)
      .maybeSingle();

    if (!fileRow) {
      return NextResponse.json(
        {
          error: 'Not Found',
          code: 'FILE_NOT_FOUND',
          message: `No se encontró el archivo '${fileId}'.`,
        },
        { status: 404, headers: corsHeaders }
      );
    }

    const validatedOrgId = req.headers.get('x-validated-org-id');
    if (validatedOrgId && fileRow.org_id && fileRow.org_id !== validatedOrgId) {
      return NextResponse.json(
        {
          error: 'Forbidden',
          code: 'FORBIDDEN_CROSS_ORGANIZATION',
          message: 'No tienes permiso para operar sobre archivos de otra organización.',
        },
        { status: 403, headers: corsHeaders }
      );
    }

    // If already processed and caller provided a webhookUrl, dispatch the HMAC-SHA256 webhook directly
    if (fileRow.s3_processed_key && webhookUrl) {
      const visibility =
        String(fileRow.visibility || 'private').toLowerCase() === 'public' ? 'public' : 'private';
      const webhookRes = await dispatchFileWebhook({
        payload: {
          event: 'file.processed',
          timestamp: new Date().toISOString(),
          fileId: fileRow.id,
          ticketId: fileRow.ticket_id || null,
          orgId: fileRow.org_id || null,
          userId: fileRow.user_id || null,
          status: 'processed',
          scanStatus: fileRow.scan_status || 'not_scanned',
          visibility,
          mimeType: fileRow.mime_type,
          sizeBytes: Number(fileRow.size_bytes),
          sha256Hash: fileRow.sha256_hash || null,
          cloudfrontUrl: visibility === 'public' ? fileRow.cloudfront_url : null,
          errorMessage: null,
        },
        overrideWebhookUrl: webhookUrl,
        overrideWebhookSecret: webhookSecret,
        ipAddress: clientIp,
      });

      return NextResponse.json(
        {
          status: webhookRes.delivered ? 'success' : 'webhook_failed',
          fileId: fileRow.id,
          processingStatus: 'processed',
          dbStatus: fileRow.status,
          scanStatus: fileRow.scan_status || 'not_scanned',
          webhook: webhookRes,
        },
        { status: webhookRes.delivered ? 200 : 502, headers: corsHeaders }
      );
    }

    if (!ENABLE_SERVER_PROCESSING_FALLBACK) {
      return NextResponse.json(
        {
          error: 'Bad Request',
          code: 'SERVER_PROCESSING_DISABLED',
          message:
            '[TEST-ONLY] El procesamiento completo en Vercel está desactivado por diseño ("Ningún archivo pasa por Vercel"). Las transformaciones profundas y escaneo quedan diferidas a AWS Lambda.',
          fileId: fileRow.id,
          fileStatus: fileRow.status,
          scanStatus: fileRow.scan_status || 'not_scanned',
        },
        { status: 400, headers: corsHeaders }
      );
    }

    const procResult = await processUpload(fileId, {
      webhookUrl,
      webhookSecret,
      ipAddress: clientIp,
      triggerSource: 'manual_status_endpoint',
    });

    return NextResponse.json(
      {
        ...procResult,
      },
      { status: procResult.success ? 200 : 400, headers: corsHeaders }
    );
  } catch (err: any) {
    return NextResponse.json(
      { error: 'Internal Server Error', message: err.message },
      { status: 500, headers: corsHeaders }
    );
  }
}
