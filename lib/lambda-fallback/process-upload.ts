// ============================================================================
// [TEST-ONLY: TASK-B6-PROCESS-UPLOAD]
// AVISO ARQUITECTÓNICO IMPORTANTE:
// Este módulo descarga el archivo completo a Vercel para procesarlo con Sharp.
// Por regla arquitectónica general ("Ningún archivo pasa por Vercel"), este
// procesamiento está DESACTIVADO POR DEFECTO mediante el interruptor
// `ENABLE_SERVER_PROCESSING_FALLBACK`.
//
// EN PRODUCCIÓN:
// Los archivos van directo de Cliente a S3 / CloudFront sin pasar por Vercel.
//
// LIMITACIONES CONOCIDAS AL NO PROCESAR EN VERCEL (Pendientes de AWS Lambda):
// 1. NO se limpia la metadata EXIF (las imágenes conservan su metadata original).
// 2. NO se realiza escaneo antivirus/malware profundo (`scan_status = 'not_scanned'`).
// 3. El archivo permanece en su clave original sin promoción.
//
// ¿CÓMO RETIRARLO CUANDO EXISTA AWS LAMBDA?
// Ver documentación completa en PENDIENTE_AWS.md (Sección B).
// ============================================================================

import crypto from 'crypto';
import sharp from 'sharp';
import { supabase } from '@/lib/supabase';
import { addServiceLog } from '@/lib/service-logs';
import {
  generateOpaqueS3Key,
  getCacheControlForVisibility,
  getS3ObjectBuffer,
  putS3ObjectBuffer,
  deleteS3Object,
} from '@/lib/s3';
import { getBaseCloudFrontUrl } from '@/lib/cloudfront';
import { detectMagicBytesMime } from '@/lib/magic-bytes';
import {
  dispatchFileWebhook,
  WebhookDispatchResult,
} from '@/lib/lambda-fallback/webhook-dispatcher';

/**
 * [TEST-ONLY] Interruptor de pruebas locales. Desactivado por defecto.
 * En producción debe ser 'false' para garantizar que ningún archivo pase por Vercel.
 */
export const ENABLE_SERVER_PROCESSING_FALLBACK =
  process.env.ENABLE_SERVER_PROCESSING_FALLBACK === 'true';

export interface ProcessUploadOptions {
  webhookUrl?: string | null;
  webhookSecret?: string | null;
  ipAddress?: string;
  triggerSource?: 'put_confirm' | 'cron_retry' | 'manual_status_endpoint' | 'multipart_complete';
}

export interface ProcessUploadResult {
  success: boolean;
  fileId: string;
  status: 'processed' | 'failed' | 'not_found';
  scanStatus: string;
  code?: string;
  message: string;
  cloudfrontUrl: string | null;
  originalSizeBytes: number | null;
  processedSizeBytes: number | null;
  detectedMimeType: string | null;
  exifStripped: boolean;
  sha256Hash: string | null;
  webhook: WebhookDispatchResult | null;
}

export { detectMagicBytesMime };

/**
 * Task B.6: Trigger-independent file processor (`processUpload(fileId)`).
 * - Downloads object from `static/pending/<rand128_A>.<ext>`
 * - Validates real file type via binary magic bytes against declared MIME type
 * - Strips EXIF/IPTC/XMP metadata on images using `sharp(buffer).rotate()`
 * - Writes sanitized object to `static/files/<rand128_B>.<ext>` with a new 128-bit opaque key
 * - Deletes original object from `static/pending/` (`DeleteObjectCommand`)
 * - Updates DB row: `status = 'processed'`, `scan_status = 'not_scanned'`
 * - If any step fails: deletes the pending object from S3 and marks `status = 'failed'`
 */
export async function processUpload(
  fileId: string,
  options: ProcessUploadOptions = {}
): Promise<ProcessUploadResult> {
  const ipAddress = options.ipAddress || '127.0.0.1';
  const triggerSource = options.triggerSource || 'put_confirm';

  // [TEST-ONLY] Guard: Prevent execution in production when switch is disabled
  if (!ENABLE_SERVER_PROCESSING_FALLBACK) {
    return {
      success: false,
      fileId,
      status: 'failed',
      scanStatus: 'not_scanned',
      code: 'SERVER_PROCESSING_DISABLED',
      message:
        '[TEST-ONLY] El procesamiento completo en Vercel está desactivado por diseño ("Ningún archivo pasa por Vercel").',
      cloudfrontUrl: null,
      originalSizeBytes: null,
      processedSizeBytes: null,
      detectedMimeType: null,
      exifStripped: false,
      sha256Hash: null,
      webhook: null,
    };
  }

  // 1. Fetch file record from Supabase
  const { data: fileRow, error: fetchErr } = await supabase
    .from('files')
    .select('*')
    .eq('id', fileId)
    .maybeSingle();

  if (fetchErr || !fileRow) {
    return {
      success: false,
      fileId,
      status: 'not_found',
      scanStatus: 'not_scanned',
      code: 'FILE_NOT_FOUND',
      message: `El archivo '${fileId}' no existe en la base de datos.`,
      cloudfrontUrl: null,
      originalSizeBytes: null,
      processedSizeBytes: null,
      detectedMimeType: null,
      exifStripped: false,
      sha256Hash: null,
      webhook: null,
    };
  }

  // Idempotency: if already processed and has s3_processed_key
  if (fileRow.s3_processed_key && (fileRow.status === 'completed' || fileRow.status === 'processed')) {
    return {
      success: true,
      fileId,
      status: 'processed',
      scanStatus: fileRow.scan_status || 'not_scanned',
      message: `El archivo '${fileId}' ya había sido procesado previamente.`,
      cloudfrontUrl: fileRow.visibility === 'public' ? fileRow.cloudfront_url : null,
      originalSizeBytes: Number(fileRow.size_bytes),
      processedSizeBytes: Number(fileRow.size_bytes),
      detectedMimeType: fileRow.mime_type,
      exifStripped: String(fileRow.mime_type || '').startsWith('image/'),
      sha256Hash: fileRow.sha256_hash || null,
      webhook: null,
    };
  }

  const pendingKey: string | null = fileRow.s3_pending_key;
  const declaredMime = String(fileRow.mime_type || '').toLowerCase().trim();
  const visibility: 'private' | 'public' =
    String(fileRow.visibility || 'private').toLowerCase() === 'public' ? 'public' : 'private';
  const extension = String(fileRow.extension || '').toLowerCase().trim();

  if (!pendingKey) {
    const errMsg = 'El registro no cuenta con archivo pendiente para procesar.';
    await supabase
      .from('files')
      .update({
        status: 'failed',
        error_message: errMsg,
        retry_count: Number(fileRow.retry_count || 0) + 1,
        updated_at: new Date().toISOString(),
      })
      .eq('id', fileId);

    return {
      success: false,
      fileId,
      status: 'failed',
      scanStatus: 'not_scanned',
      code: 'MISSING_PENDING_KEY',
      message: errMsg,
      cloudfrontUrl: null,
      originalSizeBytes: null,
      processedSizeBytes: null,
      detectedMimeType: null,
      exifStripped: false,
      sha256Hash: null,
      webhook: null,
    };
  }

  try {
    // 2. Download raw object from static/pending/
    const rawBuffer = await getS3ObjectBuffer(pendingKey);
    if (!rawBuffer || rawBuffer.length === 0) {
      throw new Error(`No se pudo descargar el objeto '${pendingKey}' desde S3 o está vacío.`);
    }

    const originalSizeBytes = rawBuffer.length;

    // 3. Validate real file type using binary Magic Bytes
    const detectedMime = detectMagicBytesMime(rawBuffer);
    if (!detectedMime) {
      throw new Error(
        `Firma binaria (magic bytes) desconocida o inválida. El archivo no es una imagen válida (.png, .jpg, .webp, .gif) ni un documento .pdf real.`
      );
    }

    if (detectedMime !== declaredMime) {
      throw new Error(
        `Falsificación de tipo detectada por magic bytes: el ticket declaró '${declaredMime}', pero el contenido binario real es '${detectedMime}'.`
      );
    }

    // 4. Strip EXIF / metadata on images using sharp(buffer).rotate()
    let processedBuffer: Buffer = rawBuffer;
    let exifStripped = false;

    if (detectedMime.startsWith('image/')) {
      const pipeline = sharp(rawBuffer, { animated: detectedMime === 'image/gif' }).rotate();

      if (detectedMime === 'image/png') {
        processedBuffer = await pipeline.png({ compressionLevel: 9 }).toBuffer();
      } else if (detectedMime === 'image/jpeg') {
        processedBuffer = await pipeline.jpeg({ quality: 92, mozjpeg: true }).toBuffer();
      } else if (detectedMime === 'image/webp') {
        processedBuffer = await pipeline.webp({ quality: 90 }).toBuffer();
      } else if (detectedMime === 'image/gif') {
        processedBuffer = await pipeline.gif().toBuffer();
      }
      exifStripped = true;
    }

    const processedSizeBytes = processedBuffer.length;
    const sha256Hash = crypto.createHash('sha256').update(processedBuffer).digest('hex');

    // 5. Write processed file to final destination with a NEW 128-bit opaque key: static/files/<rand128_B>.<ext>
    const finalKey = generateOpaqueS3Key('static/files', extension);
    const finalCacheControl = getCacheControlForVisibility(visibility, false);
    const contentDisposition: 'inline' | 'attachment' =
      extension === '.pdf' || detectedMime === 'application/pdf' ? 'attachment' : 'inline';

    await putS3ObjectBuffer(
      finalKey,
      processedBuffer,
      detectedMime,
      finalCacheControl,
      contentDisposition
    );

    // 6. Delete original object from static/pending/
    await deleteS3Object(pendingKey);

    // 7. Update database record: status = 'completed' (files_status_check enum), s3_processed_key = finalKey, scan_status = 'not_scanned'
    // Private files NEVER store or return cloudfront_url.
    const publicCfUrl = visibility === 'public' ? getBaseCloudFrontUrl(finalKey) : null;
    const nowIso = new Date().toISOString();

    const { error: updateErr } = await supabase
      .from('files')
      .update({
        s3_processed_key: finalKey,
        size_bytes: processedSizeBytes,
        sha256_hash: sha256Hash,
        cloudfront_url: publicCfUrl,
        status: 'completed',
        scan_status: 'not_scanned',
        error_message: null,
        completed_at: fileRow.completed_at || nowIso,
        updated_at: nowIso,
      })
      .eq('id', fileId);

    if (updateErr) {
      try {
        await deleteS3Object(finalKey);
      } catch {}
      throw new Error(`Error actualizando registro procesado en Supabase: ${updateErr.message}`);
    }

    await addServiceLog({
      method: 'POST',
      action: 'FILE_PROCESSED',
      status: 'PROCESSED',
      userId: fileRow.user_id || undefined,
      orgId: fileRow.org_id || undefined,
      ticketId: fileRow.ticket_id || undefined,
      fileId,
      fileName: fileRow.original_name || undefined,
      ipAddress,
      message: `processUpload(${triggerSource}): Archivo procesado (${detectedMime}, EXIF limpiado=${exifStripped}, ${originalSizeBytes}->${processedSizeBytes} bytes). Movido de '${pendingKey}' a '${finalKey}' y original eliminado de pending.`,
    });

    // 8. Dispatch HMAC-SHA256 Webhook if configured for the organization or request
    const webhookRes = await dispatchFileWebhook({
      payload: {
        event: 'file.processed',
        timestamp: nowIso,
        fileId,
        ticketId: fileRow.ticket_id || null,
        orgId: fileRow.org_id || null,
        userId: fileRow.user_id || null,
        status: 'processed',
        scanStatus: 'not_scanned',
        visibility,
        mimeType: detectedMime,
        sizeBytes: processedSizeBytes,
        sha256Hash,
        cloudfrontUrl: publicCfUrl,
        errorMessage: null,
      },
      overrideWebhookUrl: options.webhookUrl,
      overrideWebhookSecret: options.webhookSecret,
      ipAddress,
    });

    return {
      success: true,
      fileId,
      status: 'processed',
      scanStatus: 'not_scanned',
      message: 'Archivo procesado exitosamente.',
      cloudfrontUrl: publicCfUrl,
      originalSizeBytes,
      processedSizeBytes,
      detectedMimeType: detectedMime,
      exifStripped,
      sha256Hash,
      webhook: webhookRes,
    };
  } catch (err: any) {
    const errorMessage = err?.message || 'Error desconocido durante processUpload';

    // Task B.6 Requirement: "Si falla: borra el original y marca failed."
    let deletedPending: string | null = null;
    if (pendingKey) {
      try {
        await deleteS3Object(pendingKey);
        deletedPending = pendingKey;
      } catch (delErr: any) {
        console.error('Error borrando objeto pendiente tras fallo de processUpload:', delErr.message);
      }
    }

    const failNowIso = new Date().toISOString();
    const newRetryCount = Number(fileRow.retry_count || 0) + 1;

    await supabase
      .from('files')
      .update({
        status: 'failed',
        scan_status: 'not_scanned',
        cloudfront_url: null,
        retry_count: newRetryCount,
        error_message: errorMessage,
        updated_at: failNowIso,
      })
      .eq('id', fileId);

    await addServiceLog({
      method: 'POST',
      action: 'PROCESS_UPLOAD_FAILED',
      status: 'FAILED',
      userId: fileRow.user_id || undefined,
      orgId: fileRow.org_id || undefined,
      ticketId: fileRow.ticket_id || undefined,
      fileId,
      fileName: fileRow.original_name || undefined,
      ipAddress,
      message: `processUpload(${triggerSource}) falló: ${errorMessage}. Objeto '${pendingKey}' eliminado de S3 y estado marcado como 'failed'.`,
    });

    const webhookRes = await dispatchFileWebhook({
      payload: {
        event: 'file.failed',
        timestamp: failNowIso,
        fileId,
        ticketId: fileRow.ticket_id || null,
        orgId: fileRow.org_id || null,
        userId: fileRow.user_id || null,
        status: 'failed',
        scanStatus: 'not_scanned',
        visibility,
        mimeType: declaredMime,
        sizeBytes: Number(fileRow.size_bytes || 0),
        sha256Hash: null,
        cloudfrontUrl: null,
        errorMessage,
      },
      overrideWebhookUrl: options.webhookUrl,
      overrideWebhookSecret: options.webhookSecret,
      ipAddress,
    });

    return {
      success: false,
      fileId,
      status: 'failed',
      scanStatus: 'not_scanned',
      code: 'PROCESS_UPLOAD_FAILED',
      message: errorMessage,
      cloudfrontUrl: null,
      originalSizeBytes: Number(fileRow.size_bytes || 0),
      processedSizeBytes: null,
      detectedMimeType: null,
      exifStripped: false,
      sha256Hash: null,
      webhook: webhookRes,
    };
  }
}

/* ============================================================================
 * [PLANTILLA LISTA PARA AWS LAMBDA CUANDO SE HABILITEN PERMISOS IAM]
 * Cuando el administrador otorgue `lambda:CreateFunction` y `s3:PutBucketNotification`,
 * puedes usar directamente este handler en tu función AWS Lambda:
 *
 * export const handler = async (event: any) => {
 *   for (const record of event.Records || []) {
 *     const s3Key = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));
 *     const { data: fileRow } = await supabase
 *       .from('files')
 *       .select('id')
 *       .eq('s3_pending_key', s3Key)
 *       .maybeSingle();
 *     if (fileRow?.id) {
 *       await processUpload(fileRow.id, { triggerSource: 'lambda_s3_event' as any });
 *     }
 *   }
 * };
 * ============================================================================ */
