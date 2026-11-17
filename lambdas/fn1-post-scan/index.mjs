import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import sharp from 'sharp';
import postgres from 'postgres';

const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });

let sqlClient = null;
function getSql() {
  if (!sqlClient) {
    const rawUrl = (process.env.DATABASE_URL || '').trim();
    if (!rawUrl) {
      throw new Error('Missing DATABASE_URL environment variable in practicas-alan-fn1');
    }
    const connStr = rawUrl.replace(/(\.pooler\.[^:]+):6543\b/, '$1:5432');
    sqlClient = postgres(connStr, {
      max: 2,
      idle_timeout: 15,
      connect_timeout: 10,
      prepare: false,
    });
  }
  return sqlClient;
}

const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif']);

export const handler = async (event) => {
  console.log('[practicas-alan-fn1] Event received:', JSON.stringify(event));

  const detail = event?.detail || {};
  const bucketName =
    detail?.s3ObjectDetails?.bucketName ||
    detail?.bucket?.name ||
    process.env.AWS_S3_BUCKET_NAME ||
    'practicas-alan-418272802078';
  const rawKey = detail?.s3ObjectDetails?.objectKey || detail?.object?.key || '';
  const objectKey = decodeURIComponent(String(rawKey).replace(/\+/g, ' '));
  const scanStatus = detail?.scanResultDetails?.scanResultStatus || 'NO_THREATS_FOUND';

  if (!objectKey) {
    return { ok: false, skipped: 'missing_object_key' };
  }

  // 1. Filtro Anti-Bucle: ignorar variantes en /v/
  if (objectKey.includes('/v/')) {
    console.log('[practicas-alan-fn1] Ignorando variante:', objectKey);
    return { ok: true, skipped: 'variant_key', objectKey };
  }

  const sql = getSql();

  const rows = await sql`
    SELECT id, ticket_id, user_id, org_id, original_name, mime_type, visibility,
           s3_pending_key, s3_processed_key, scan_status, status
    FROM files
    WHERE s3_processed_key = ${objectKey} OR s3_pending_key = ${objectKey}
    LIMIT 1
  `;

  const fileRow = rows[0] || null;

  // 2. Rama 1: GuardDuty detectó Malware (THREATS_FOUND)
  if (scanStatus === 'THREATS_FOUND') {
    console.warn(`[practicas-alan-fn1] MALWARE DETECTADO en ${objectKey}. Eliminando de S3...`);
    await s3.send(new DeleteObjectCommand({ Bucket: bucketName, Key: objectKey })).catch(() => {});

    if (fileRow) {
      if (fileRow.s3_pending_key && fileRow.s3_pending_key !== objectKey) {
        await s3.send(new DeleteObjectCommand({ Bucket: bucketName, Key: fileRow.s3_pending_key })).catch(() => {});
      }
      if (fileRow.s3_processed_key && fileRow.s3_processed_key !== objectKey) {
        await s3.send(new DeleteObjectCommand({ Bucket: bucketName, Key: fileRow.s3_processed_key })).catch(() => {});
      }

      await sql`
        UPDATE files
        SET status = 'quarantined',
            scan_status = 'THREAT_DETECTED',
            threat_detected = true,
            cloudfront_url = null,
            error_message = 'GuardDuty Malware Protection: THREATS_FOUND',
            updated_at = NOW()
        WHERE id = ${fileRow.id}
      `;

      await sql`
        INSERT INTO service_logs (http_method, action, status, user_id, org_id, ticket_id, file_id, ip_address, message)
        VALUES ('EVENT', 'GUARDDUTY_THREAT_QUARANTINED', 'DENIED_MALWARE', ${fileRow.user_id}, ${fileRow.org_id}, ${fileRow.ticket_id}, ${fileRow.id}, 'guardduty.amazonaws.com', ${`[practicas-alan-fn1] Malware detectado por GuardDuty en ${objectKey}. Archivo eliminado de S3 y puesto en cuarentena.`})
      `;
    }

    return { ok: true, action: 'quarantined_and_deleted', objectKey, scanStatus };
  }

  // 3. Rama 2: Otros estados de GuardDuty (UNSUPPORTED, ACCESS_DENIED, FAILED)
  if (scanStatus !== 'NO_THREATS_FOUND') {
    if (fileRow) {
      await sql`
        UPDATE files
        SET scan_status = 'NOT_APPLICABLE',
            updated_at = NOW()
        WHERE id = ${fileRow.id}
      `;
    }
    return { ok: true, action: 'marked_not_applicable', objectKey, scanStatus };
  }

  // 4. Rama 3: GuardDuty certificó NO_THREATS_FOUND (100% Limpio)
  if (!fileRow) {
    console.log('[practicas-alan-fn1] Archivo limpio en S3 pero sin registro en tabla files:', objectKey);
    return { ok: true, skipped: 'no_db_record', objectKey };
  }

  // Si el evento es del archivo YA promovido en static/public/ o static/private/:
  // ¡NUNCA volver a sobrescribirlo en S3! (Si lo sobrescribiéramos le borraríamos el tag NO_THREATS_FOUND y daría 403).
  if (!objectKey.startsWith('static/pending/')) {
    await sql`
      UPDATE files
      SET status = 'uploaded',
          scan_status = 'CLEAN',
          threat_detected = false,
          s3_processed_key = ${objectKey},
          updated_at = NOW()
      WHERE id = ${fileRow.id}
    `;

    await sql`
      INSERT INTO service_logs (http_method, action, status, user_id, org_id, ticket_id, file_id, ip_address, message)
      VALUES ('EVENT', 'GUARDDUTY_FINAL_SCAN_CLEAN', 'ALLOWED', ${fileRow.user_id}, ${fileRow.org_id}, ${fileRow.ticket_id}, ${fileRow.id}, 'guardduty.amazonaws.com', ${`[practicas-alan-fn1] GuardDuty certificó NO_THREATS_FOUND en destino final ${objectKey}. Archivo desbloqueado y listo para entrega.`})
    `;

    return {
      ok: true,
      action: 'final_object_verified_clean',
      fileId: fileRow.id,
      finalKey: objectKey,
      scanStatus: 'CLEAN',
    };
  }

  // Si el archivo está en static/pending/: es la primera pasada tras el escaneo de pending.
  // Aquí (y solo aquí) limpiamos EXIF con Sharp y lo movemos a static/public/ o static/private/.
  const getResp = await s3.send(new GetObjectCommand({ Bucket: bucketName, Key: objectKey }));
  const byteArray = await getResp.Body.transformToByteArray();
  const originalBuffer = Buffer.from(byteArray);

  let finalBuffer = originalBuffer;
  let exifStripped = false;
  if (IMAGE_MIMES.has(String(fileRow.mime_type || '').toLowerCase())) {
    try {
      finalBuffer = await sharp(originalBuffer).rotate().toBuffer();
      exifStripped = true;
    } catch (sharpErr) {
      console.warn('[practicas-alan-fn1] Sharp rotate/strip warning:', sharpErr.message);
    }
  }

  const visibility = fileRow.visibility === 'public' ? 'public' : 'private';
  const fileNamePart = objectKey.split('/').pop();
  const finalKey = `static/${visibility}/${fileRow.org_id}/${fileNamePart}`;

  const cacheControl =
    visibility === 'public'
      ? 'public, max-age=300, must-revalidate'
      : 'private, no-store, no-cache, max-age=0, must-revalidate';

  const cfDomain = (process.env.AWS_CLOUDFRONT_DOMAIN || 'https://d1nuawu3owad6c.cloudfront.net').replace(/\/+$/, '');
  const cloudfrontUrl = visibility === 'public' ? `${cfDomain}/${finalKey}` : null;

  await s3.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: finalKey,
      Body: finalBuffer,
      ContentType: fileRow.mime_type || 'application/octet-stream',
      CacheControl: cacheControl,
      Metadata: {
        'exif-stripped': String(exifStripped),
        'processed-by': 'practicas-alan-fn1',
      },
    })
  );

  // Borrar el archivo temporal de static/pending/
  await s3.send(new DeleteObjectCommand({ Bucket: bucketName, Key: objectKey })).catch(() => {});

  await sql`
    UPDATE files
    SET status = 'uploaded',
        scan_status = 'CLEAN',
        threat_detected = false,
        s3_processed_key = ${finalKey},
        cloudfront_url = ${cloudfrontUrl},
        size_bytes = ${finalBuffer.length},
        completed_at = COALESCE(completed_at, NOW()),
        updated_at = NOW()
    WHERE id = ${fileRow.id}
  `;

  await sql`
    INSERT INTO service_logs (http_method, action, status, user_id, org_id, ticket_id, file_id, ip_address, message)
    VALUES ('EVENT', 'LAMBDA_FN1_EXIF_AND_PROMOTE', 'ALLOWED', ${fileRow.user_id}, ${fileRow.org_id}, ${fileRow.ticket_id}, ${fileRow.id}, 'lambda.amazonaws.com', ${`[practicas-alan-fn1] EXIF limpiado=${exifStripped} y promovido de ${objectKey} a ${finalKey}.`})
  `;

  return {
    ok: true,
    action: 'cleaned_and_promoted_from_pending',
    fileId: fileRow.id,
    finalKey,
    exifStripped,
    scanStatus: 'CLEAN',
  };
};
