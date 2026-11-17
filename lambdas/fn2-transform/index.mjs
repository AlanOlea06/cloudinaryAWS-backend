import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import sharp from 'sharp';
import postgres from 'postgres';

const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });

let sqlClient = null;
function getSql() {
  const rawUrl = (process.env.DATABASE_URL || '').trim();
  if (!rawUrl) return null;
  if (!sqlClient) {
    const connStr = rawUrl.replace(/(\.pooler\.[^:]+):6543\b/, '$1:5432');
    sqlClient = postgres(connStr, {
      max: 1,
      idle_timeout: 10,
      connect_timeout: 10,
      prepare: false,
    });
  }
  return sqlClient;
}

const ALLOWED_FITS = new Set(['cover', 'contain', 'fill', 'inside', 'outside']);
const FORMAT_MIME_MAP = {
  webp: 'image/webp',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  avif: 'image/avif',
};

function buildVariantS3Key(sourceKey, w, h, fit, format) {
  const parts = sourceKey.split('/');
  const fileName = parts.pop() || 'image';
  const dotIdx = fileName.lastIndexOf('.');
  const baseName = dotIdx > 0 ? fileName.slice(0, dotIdx) : fileName;
  const dir = parts.join('/');
  const dimTag = `${w || 'auto'}x${h || 'auto'}_${fit}`;
  return `${dir}/v/${baseName}_${dimTag}.${format}`;
}

export const handler = async (event) => {
  console.log('[practicas-alan-fn2] Transform invocation:', JSON.stringify({ ...event, base64Body: undefined }));

  const bucketName =
    event?.bucketName ||
    process.env.AWS_S3_BUCKET_NAME ||
    'practicas-alan-418272802078';
  const s3Key = String(event?.s3Key || '').trim();

  if (!s3Key || s3Key.includes('/v/')) {
    return { ok: false, error: 'INVALID_SOURCE_KEY' };
  }

  const w = event?.w ? Math.min(2000, Math.max(16, Number(event.w))) : null;
  const h = event?.h ? Math.min(2000, Math.max(16, Number(event.h))) : null;
  const fit = ALLOWED_FITS.has(event?.fit) ? event.fit : 'cover';
  const rawFormat = String(event?.format || 'webp').toLowerCase();
  const format = FORMAT_MIME_MAP[rawFormat] ? (rawFormat === 'jpg' ? 'jpeg' : rawFormat) : 'webp';
  const contentType = FORMAT_MIME_MAP[format] || 'image/webp';
  const quality = event?.quality ? Math.min(100, Math.max(20, Number(event.quality))) : 82;
  const visibility = event?.visibility === 'public' ? 'public' : 'private';

  const variantKey = buildVariantS3Key(s3Key, w, h, fit, format);

  // 1. Intentar servir desde caché de variantes en S3 (/v/) si ya existe y fue escaneada
  try {
    const cachedResp = await s3.send(
      new GetObjectCommand({ Bucket: bucketName, Key: variantKey })
    );
    const cachedBytes = Buffer.from(await cachedResp.Body.transformToByteArray());
    return {
      ok: true,
      fromCache: true,
      variantKey,
      contentType,
      sizeBytes: cachedBytes.length,
      base64Body: cachedBytes.toString('base64'),
    };
  } catch {
    // No existe aún en caché o sigue escaneándose -> transformar al vuelo desde la imagen limpia
  }

  // 2. Descargar imagen original limpia desde S3
  const sourceResp = await s3.send(
    new GetObjectCommand({ Bucket: bucketName, Key: s3Key })
  );
  const sourceBuffer = Buffer.from(await sourceResp.Body.transformToByteArray());

  // 3. Transformar al vuelo con Sharp en AWS Lambda
  let pipeline = sharp(sourceBuffer).rotate();
  if (w || h) {
    pipeline = pipeline.resize({
      width: w || undefined,
      height: h || undefined,
      fit,
      withoutEnlargement: true,
    });
  }

  if (format === 'webp') {
    pipeline = pipeline.webp({ quality });
  } else if (format === 'jpeg') {
    pipeline = pipeline.jpeg({ quality, mozjpeg: true });
  } else if (format === 'png') {
    pipeline = pipeline.png({ compressionLevel: 8 });
  } else if (format === 'avif') {
    pipeline = pipeline.avif({ quality });
  }

  const outputBuffer = await pipeline.toBuffer();

  // 4. Guardar variante en /v/ en S3 para cachear futuras lecturas
  const cacheControl =
    visibility === 'public'
      ? 'public, max-age=300, must-revalidate'
      : 'private, no-store, no-cache, max-age=0, must-revalidate';

  await s3
    .send(
      new PutObjectCommand({
        Bucket: bucketName,
        Key: variantKey,
        Body: outputBuffer,
        ContentType: contentType,
        CacheControl: cacheControl,
      })
    )
    .catch((err) => {
      console.warn('[practicas-alan-fn2] Could not cache variant in S3:', err.message);
    });

  // 5. Registrar en service_logs de PostgreSQL que practicas-alan-fn2 ejecutó la transformación
  const sql = getSql();
  if (sql && event?.fileId) {
    await sql`
      INSERT INTO service_logs (http_method, action, status, user_id, org_id, ticket_id, file_id, ip_address, message)
      VALUES ('GET', 'LAMBDA_FN2_IMAGE_TRANSFORMED', 'ALLOWED', ${event.userId || null}, ${event.orgId || null}, ${event.ticketId || null}, ${event.fileId}, 'lambda.amazonaws.com', ${`[practicas-alan-fn2] Transformación Sharp en AWS Lambda completada (${w || 'auto'}x${h || 'auto'}, fit=${fit}, format=${format}, ${outputBuffer.length} bytes) -> ${variantKey}`})
    `.catch(() => {});
  }

  return {
    ok: true,
    fromCache: false,
    variantKey,
    contentType,
    sizeBytes: outputBuffer.length,
    base64Body: outputBuffer.toString('base64'),
  };
};
