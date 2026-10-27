// ============================================================================
// [TEMPORARY-LAMBDA-FALLBACK: TASK-B8-CRON-MAINTENANCE]
// Búsqueda rápida: "TEMPORARY-LAMBDA-FALLBACK"
// Cron de Mantenimiento en Vercel (reemplaza S3 Lifecycle Rules y DLQ):
// 1. Borra tickets vencidos (fila en Supabase + objeto en S3 con DeleteObjectCommand).
// 2. Cancela subidas multipart abandonadas usando s3_upload_id (AbortMultipartUploadCommand).
// 3. Reintenta procesamientos pendientes o fallidos (processUpload(fileId) cuando retry_count < 3).
// ============================================================================

import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { addServiceLog, enforceIpAddressRetention } from '@/lib/service-logs';
import {
  headS3Object,
  deleteS3Object,
  abortS3MultipartUpload,
  listS3UploadedParts,
} from '@/lib/s3';
import { processUpload, ENABLE_SERVER_PROCESSING_FALLBACK } from '@/lib/lambda-fallback/process-upload';
import {
  processPendingWebhookDeliveries,
  purgeOldWebhookDeliveries,
} from '@/lib/lambda-fallback/webhook-dispatcher';
import { purgeStaleRateLimitBuckets } from '@/lib/shared-rate-limit';
import { verifyCronSecretHeader } from '@/lib/env';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'X-Content-Type-Options': 'nosniff',
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

async function runMaintenanceCron(req: NextRequest) {
  const cronCheck = verifyCronSecretHeader(req.headers);
  if (!cronCheck.valid) {
    return NextResponse.json(
      {
        error: cronCheck.status === 401 ? 'Unauthorized' : 'Forbidden',
        code: cronCheck.code,
        message: cronCheck.message,
      },
      { status: cronCheck.status, headers: corsHeaders }
    );
  }

  const { searchParams } = new URL(req.url);
  const targetTicketId = searchParams.get('ticketId') || null;
  const expiredMinutesParam = searchParams.get('expiredMinutes');
  const multipartMinutesParam = searchParams.get('multipartMinutes');

  const expiredCutoffMinutes =
    expiredMinutesParam !== null ? Math.max(0, Number(expiredMinutesParam)) : 7;
  // Default to 75 minutes: 60-minute multipart ticket confirmation window + 15-minute grace margin
  const multipartCutoffMinutes =
    multipartMinutesParam !== null ? Math.max(0, Number(multipartMinutesParam)) : 75;

  const nowMs = Date.now();
  const expiredCutoffIso = new Date(nowMs - expiredCutoffMinutes * 60 * 1000).toISOString();
  const multipartCutoffIso = new Date(nowMs - multipartCutoffMinutes * 60 * 1000).toISOString();
  const clientIp = req.headers.get('x-forwarded-for') || '127.0.0.1';

  const summary = {
    executedAt: new Date(nowMs).toISOString(),
    expiredTicketsDeleted: [] as Array<{ fileId: string; ticketId: string; storageCleaned: boolean }>,
    abandonedMultipartAborted: [] as Array<{
      fileId: string;
      ticketId: string;
      aborted: boolean;
      skippedDueToActiveUpload?: boolean;
    }>,
    retriedProcessings: [] as Array<{
      fileId: string;
      ticketId: string;
      success: boolean;
      newStatus: string;
    }>,
    retriedWebhooks: null as any,
    webhookRetention: null as any,
    rateLimitCleanup: null as any,
  };

  // ==========================================================================
  // 1. BORRAR TICKETS VENCIDOS (fila en BD + objeto en S3 con DeleteObjectCommand)
  // ==========================================================================
  let expiredQuery = supabase
    .from('files')
    .select('*')
    .in('status', ['pending_upload', 'expired'])
    .is('s3_upload_id', null)
    .lte('created_at', expiredCutoffIso);

  if (targetTicketId) {
    expiredQuery = expiredQuery.eq('ticket_id', targetTicketId);
  }

  const { data: expiredRows } = await expiredQuery;

  for (const row of expiredRows || []) {
    let deletedKey: string | null = null;
    if (row.s3_pending_key) {
      try {
        await deleteS3Object(row.s3_pending_key);
        deletedKey = row.s3_pending_key;
      } catch (err: any) {
        console.warn('Error deleting expired S3 pending object:', err.message);
      }
    }

    // Delete expired ticket row from public.files
    await supabase.from('files').delete().eq('id', row.id);

    await addServiceLog({
      method: req.method,
      action: 'CRON_EXPIRED_TICKET_DELETED',
      status: 'CLEANED',
      userId: row.user_id || undefined,
      orgId: row.org_id || undefined,
      ticketId: row.ticket_id || undefined,
      fileName: row.original_name || undefined,
      ipAddress: clientIp,
      message: `Cron de mantenimiento eliminó ticket vencido '${row.ticket_id}' (fileId=${row.id}).`,
    });

    summary.expiredTicketsDeleted.push({
      fileId: row.id,
      ticketId: row.ticket_id,
      storageCleaned: Boolean(deletedKey),
    });
  }

  // ==========================================================================
  // 2. [TEMPORARY-LAMBDA-FALLBACK: CRON-MULTIPART-ABORT]
  // CANCELAR MULTIPART ABANDONADOS (AbortMultipartUploadCommand + borrado)
  // Reemplaza temporalmente la regla S3 Lifecycle: AbortIncompleteMultipartUpload
  // Aborta solo si el ticket venció más un margen y ListParts no muestra partes nuevas.
  // NO borra la fila si falla el abort en S3.
  // ==========================================================================
  let multipartQuery = supabase
    .from('files')
    .select('*')
    .not('s3_upload_id', 'is', null)
    .in('status', ['pending_upload', 'uploading_multipart', 'expired', 'failed'])
    .lte('created_at', multipartCutoffIso);

  if (targetTicketId) {
    multipartQuery = multipartQuery.eq('ticket_id', targetTicketId);
  }

  const { data: multipartRows } = await multipartQuery;

  for (const row of multipartRows || []) {
    const s3Key = row.s3_pending_key;
    const uploadId = row.s3_upload_id;

    if (!s3Key || !uploadId) continue;

    let partsCount = 0;
    let hasRecentParts = false;
    try {
      const parts = await listS3UploadedParts(s3Key, uploadId);
      partsCount = parts.length;
      // If any part was uploaded within the last 15 minutes, the upload is active -> do not abort
      const fifteenMinutesAgo = Date.now() - 15 * 60 * 1000;
      hasRecentParts = parts.some(
        (p) => p.LastModified && new Date(p.LastModified).getTime() > fifteenMinutesAgo
      );
    } catch {}

    if (hasRecentParts) {
      summary.abandonedMultipartAborted.push({
        fileId: row.id,
        ticketId: row.ticket_id,
        aborted: false,
        skippedDueToActiveUpload: true,
      });
      continue;
    }

    let abortedSuccessfully = false;
    try {
      await abortS3MultipartUpload(s3Key, uploadId);
      abortedSuccessfully = true;
    } catch (abortErr: any) {
      console.warn(`[TEMPORARY-LAMBDA-FALLBACK] AbortMultipartUpload warning para ticket ${row.ticket_id}:`, abortErr.message);
    }

    if (abortedSuccessfully) {
      try {
        await deleteS3Object(s3Key);
      } catch {
        // Ignore if not materialized
      }

      // No borres la fila si falla el abort en S3 (requisito explícito)
      await supabase.from('files').delete().eq('id', row.id);

      await addServiceLog({
        method: req.method,
        action: 'CRON_MULTIPART_ABORTED',
        status: 'ABORTED',
        userId: row.user_id || undefined,
        orgId: row.org_id || undefined,
        ticketId: row.ticket_id || undefined,
        fileName: row.original_name || undefined,
        ipAddress: clientIp,
        message: `Cron de mantenimiento abortó subida Multipart abandonada para ticket '${row.ticket_id}' (${partsCount} partes huérfanas en S3).`,
      });

      summary.abandonedMultipartAborted.push({
        fileId: row.id,
        ticketId: row.ticket_id,
        aborted: true,
      });
    } else {
      summary.abandonedMultipartAborted.push({
        fileId: row.id,
        ticketId: row.ticket_id,
        aborted: false,
      });
    }
  }

  // ==========================================================================
  // 3. [TEST-ONLY: CRON-RETRY-PROCESSING]
  // REINTENTAR PROCESAMIENTOS PENDIENTES O FALLIDOS
  // Respeta estrictamente ENABLE_SERVER_PROCESSING_FALLBACK:
  // Si está apagado (por defecto en producción), NUNCA procesa archivos en Vercel
  // y NUNCA marca 'failed' un archivo 'uploaded' por no estar procesado.
  // ==========================================================================
  if (ENABLE_SERVER_PROCESSING_FALLBACK) {
    let retryQuery: any = supabase
      .from('files')
      .select('*')
      .in('status', ['completed', 'failed'])
      .is('s3_processed_key', null)
      .not('s3_pending_key', 'is', null)
      .lt('retry_count', 3);

    if (targetTicketId) {
      retryQuery = retryQuery.eq('ticket_id', targetTicketId);
    }

    const { data: retryRows } = await retryQuery;

    for (const row of retryRows || []) {
      if (!row.s3_pending_key) continue;

      const head = await headS3Object(row.s3_pending_key);
      if (!head.exists) {
        // Object no longer in pending -> mark failed
        await supabase
          .from('files')
          .update({
            status: 'failed',
            retry_count: Number(row.retry_count || 0) + 1,
            error_message: 'Objeto pendiente ya no existe en S3 durante reintento de Cron.',
            updated_at: new Date().toISOString(),
          })
          .eq('id', row.id);
        continue;
      }

      const procRes = await processUpload(row.id, {
        ipAddress: clientIp,
        triggerSource: 'cron_retry',
      });

      summary.retriedProcessings.push({
        fileId: row.id,
        ticketId: row.ticket_id,
        success: procRes.success,
        newStatus: procRes.status,
      });
    }
  }

  // --------------------------------------------------------------------------
  // 4. Atomic Webhook Processing with SKIP LOCKED & Backoff (Task C)
  // --------------------------------------------------------------------------
  try {
    const webhooksSummary = await processPendingWebhookDeliveries();
    summary.retriedWebhooks = webhooksSummary;
  } catch (webhookCronErr: any) {
    console.warn('[CRON_MAINTENANCE] Error processing pending webhooks:', webhookCronErr?.message);
    summary.retriedWebhooks = { error: webhookCronErr?.message };
  }

  // --------------------------------------------------------------------------
  // 5. Webhook Deliveries Retention (Delivered > 30d, Failed > 90d)
  // --------------------------------------------------------------------------
  try {
    const webhookPurge = await purgeOldWebhookDeliveries();
    summary.webhookRetention = webhookPurge;
  } catch (purgeErr: any) {
    summary.webhookRetention = { error: purgeErr?.message };
  }

  // --------------------------------------------------------------------------
  // 6. [TEMPORARY-LAMBDA-FALLBACK: RATE-LIMIT-BUCKETS-CLEANUP]
  // Purge stale rate limit buckets older than 1 day
  // --------------------------------------------------------------------------
  try {
    const rateLimitPurge = await purgeStaleRateLimitBuckets();
    summary.rateLimitCleanup = rateLimitPurge;
  } catch (rlErr: any) {
    summary.rateLimitCleanup = { error: rlErr?.message };
  }

  // --------------------------------------------------------------------------
  // 7. Task B.11: Enforce IP address retention policy in service_logs (default 30 days)
  // --------------------------------------------------------------------------
  const ipRetentionDays = Number(searchParams.get('ipRetentionDays') ?? 30);
  const ipRetentionMinutesParam = searchParams.get('ipRetentionMinutes');
  const ipRetentionResult = await enforceIpAddressRetention({
    retentionDays: ipRetentionDays,
    retentionMinutes:
      ipRetentionMinutesParam !== null ? Number(ipRetentionMinutesParam) : undefined,
  });

  return NextResponse.json(
    {
      status: 'success',
      tasks: summary,
      ipRetention: ipRetentionResult,
      ...summary,
    },
    { status: 200, headers: corsHeaders }
  );
}

export async function GET(req: NextRequest) {
  return runMaintenanceCron(req);
}

export async function POST(req: NextRequest) {
  return runMaintenanceCron(req);
}
