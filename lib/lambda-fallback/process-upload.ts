// ============================================================================
// [TEMPORARY-LAMBDA-FALLBACK: TASK-B6-PROCESS-UPLOAD]
// UBICACIÓN RÁPIDA PARA MIGRACIÓN O ELIMINACIÓN CUANDO EXISTA AWS LAMBDA:
// Búsqueda rápida en el proyecto: "TEMPORARY-LAMBDA-FALLBACK"
//
// ¿QUÉ HACE ESTE ARCHIVO?
// Reemplaza temporalmente en Vercel el procesamiento asíncrono que haría la
// función AWS Lambda (Pasos 1.5.3 y 1.6.3 bloqueados por permisos IAM).
//
// ¿CÓMO MIGRARLO A AWS LAMBDA CUANDO EL ADMINISTRADOR HABILITE LOS PERMISOS?
// 1. Copia la función `processUpload(fileId)` y `detectMagicBytesMime(buffer)`
//    al handler de tu función Lambda (ver plantilla `lambdaHandler` al final
//    de este archivo).
// 2. En `servicio/app/api/upload/route.ts` (busca `TEMPORARY-LAMBDA-FALLBACK`),
//    elimina o comenta la llamada a `processUpload(...)` para que sea S3 Event
//    Notifications / EventBridge quien dispare la Lambda automáticamente.
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
import {
  dispatchFileWebhook,
  WebhookDispatchResult,
} from '@/lib/lambda-fallback/webhook-dispatcher';

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

/**
 * Inspects the raw binary header (magic bytes) to determine the true MIME type of the file,
 * independent of the client-declared Content-Type or file extension.
 */
export function detectMagicBytesMime(buffer: Buffer): string | null {
  if (!buffer || buffer.length < 4) {
    return null;
  }

  // 1. PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return 'image/png';
  }

  // 2. JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }

  // 3. GIF: "GIF87a" or "GIF89a" (47 49 46 38 37/39 61)
  if (
    buffer.length >= 6 &&
    buffer[0] === 0x47 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x38 &&
    (buffer[4] === 0x37 || buffer[4] === 0x39) &&
    buffer[5] === 0x61
  ) {
    return 'image/gif';
  }

  // 4. WEBP: "RIFF" (0..3) + "WEBP" (8..11)
  if (
    buffer.length >= 12 &&
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return 'image/webp';
  }

  // 5. PDF: "%PDF-" (25 50 44 46 2D)
  if (
    buffer.length >= 5 &&
    buffer[0] === 0x25 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x44 &&
    buffer[3] === 0x46 &&
    buffer[4] === 0x2d
  ) {
    return 'application/pdf';
  }

  return null;
}

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
