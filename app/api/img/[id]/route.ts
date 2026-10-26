// ============================================================================
// [TEMPORARY-LAMBDA-FALLBACK: TASK-B12-IMG-ENDPOINT]
// Búsqueda rápida: "TEMPORARY-LAMBDA-FALLBACK"
// Endpoint: GET & POST /api/img/[id]?w=&h=&fit=&format=&exp=&sig=
// Rediseño del Paso 2.4: Transformación dinámica de imágenes con `sharp`,
// parámetros firmados con HMAC-SHA256 + expiración, límites de dimensiones
// (16..2000 px), cabeceras de caché diferenciadas y límite de 4 MB de Vercel.
// ============================================================================

import { NextRequest, NextResponse } from 'next/server';
import sharp from 'sharp';
import { supabase } from '@/lib/supabase';
import { addServiceLog } from '@/lib/service-logs';
import {
  getS3ObjectBuffer,
  PRIVATE_NO_STORE_CACHE_CONTROL,
  PUBLIC_SHORT_TTL_CACHE_CONTROL,
} from '@/lib/s3';
import {
  MIN_TRANSFORM_DIMENSION,
  MAX_TRANSFORM_DIMENSION,
  MAX_VERCEL_RESPONSE_BYTES,
  ALLOWED_TRANSFORM_FITS,
  ALLOWED_TRANSFORM_FORMATS,
  signImageTransformParams,
  verifyImageTransformSignature,
} from '@/lib/lambda-fallback/image-transform';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key, x-user-id',
  'X-Content-Type-Options': 'nosniff',
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

/**
 * POST /api/img/[id]
 * Generates a signed transformation URL with HMAC-SHA256 + expiration (`exp` & `sig`)
 * after verifying organization and owner permissions.
 */
export async function POST(
  req: NextRequest,
  context: { params: { id: string } | Promise<{ id: string }> }
) {
  try {
    const resolvedParams = await Promise.resolve(context.params);
    const fileId = resolvedParams?.id?.trim();

    if (!fileId || !UUID_REGEX.test(fileId)) {
      return NextResponse.json(
        { error: 'Bad Request', code: 'INVALID_FILE_ID', message: 'El id del archivo no es un UUID v4 válido.' },
        { status: 400, headers: corsHeaders }
      );
    }

    const body = await req.json();
    const {
      w = null,
      h = null,
      fit = 'cover',
      format = 'webp',
      expiresInSeconds = 300,
    } = body;

    // Validate dimensions before signing
    if (w !== null && w !== undefined && w !== '') {
      const wNum = Number(w);
      if (!Number.isInteger(wNum) || wNum < MIN_TRANSFORM_DIMENSION || wNum > MAX_TRANSFORM_DIMENSION) {
        return NextResponse.json(
          {
            error: 'Bad Request',
            code: 'INVALID_TRANSFORM_DIMENSIONS',
            message: `El ancho (w=${w}) debe ser un entero entre ${MIN_TRANSFORM_DIMENSION} y ${MAX_TRANSFORM_DIMENSION} px.`,
          },
          { status: 400, headers: corsHeaders }
        );
      }
    }

    if (h !== null && h !== undefined && h !== '') {
      const hNum = Number(h);
      if (!Number.isInteger(hNum) || hNum < MIN_TRANSFORM_DIMENSION || hNum > MAX_TRANSFORM_DIMENSION) {
        return NextResponse.json(
          {
            error: 'Bad Request',
            code: 'INVALID_TRANSFORM_DIMENSIONS',
            message: `El alto (h=${h}) debe ser un entero entre ${MIN_TRANSFORM_DIMENSION} y ${MAX_TRANSFORM_DIMENSION} px.`,
          },
          { status: 400, headers: corsHeaders }
        );
      }
    }

    const fitNorm = String(fit || 'cover').toLowerCase().trim();
    if (!ALLOWED_TRANSFORM_FITS.has(fitNorm)) {
      return NextResponse.json(
        {
          error: 'Bad Request',
          code: 'INVALID_TRANSFORM_FIT',
          message: `El modo fit '${fitNorm}' no es válido. Permitidos: ${Array.from(ALLOWED_TRANSFORM_FITS).join(', ')}.`,
        },
        { status: 400, headers: corsHeaders }
      );
    }

    const fmtNorm = String(format || 'webp').toLowerCase().trim();
    if (!ALLOWED_TRANSFORM_FORMATS.has(fmtNorm)) {
      return NextResponse.json(
        {
          error: 'Bad Request',
          code: 'INVALID_TRANSFORM_FORMAT',
          message: `El formato '${fmtNorm}' no es válido. Permitidos: ${Array.from(ALLOWED_TRANSFORM_FORMATS).join(', ')}.`,
        },
        { status: 400, headers: corsHeaders }
      );
    }

    const { data: fileRow, error: dbErr } = await supabase
      .from('files')
      .select('*')
      .eq('id', fileId)
      .maybeSingle();

    if (dbErr || !fileRow) {
      return NextResponse.json(
        { error: 'Not Found', code: 'FILE_NOT_FOUND', message: 'Archivo no encontrado.' },
        { status: 404, headers: corsHeaders }
      );
    }

    const validatedOrgId = req.headers.get('x-validated-org-id');
    const validatedUserId = req.headers.get('x-validated-user-id');

    if (validatedOrgId && fileRow.org_id !== validatedOrgId) {
      return NextResponse.json(
        { error: 'Forbidden', code: 'FORBIDDEN_TENANT_MISMATCH', message: 'El archivo pertenece a otra organización.' },
        { status: 403, headers: corsHeaders }
      );
    }

    if (fileRow.visibility === 'private' && validatedUserId && fileRow.user_id !== validatedUserId) {
      return NextResponse.json(
        {
          error: 'Forbidden',
          code: 'FORBIDDEN_PRIVATE_NOT_OWNER',
          message: 'Solo el propietario de un archivo privado puede firmar URLs de transformación.',
        },
        { status: 403, headers: corsHeaders }
      );
    }

    const ttl = Math.max(10, Math.min(3600, Number(expiresInSeconds) || 300));
    const exp = Math.floor(Date.now() / 1000) + ttl;

    const signed = signImageTransformParams({
      fileId,
      w,
      h,
      fit: fitNorm,
      format: fmtNorm,
      exp,
    });

    const origin = new URL(req.url).origin;
    const transformUrl = `${origin}/api/img/${fileId}?${signed.queryString}`;

    return NextResponse.json(
      {
        status: 'success',
        fileId,
        visibility: fileRow.visibility,
        transformUrl,
        params: {
          w: w !== null && w !== undefined && w !== '' ? Number(w) : null,
          h: h !== null && h !== undefined && h !== '' ? Number(h) : null,
          fit: fitNorm,
          format: fmtNorm,
          exp,
          sig: signed.sig,
        },
        expiresInSeconds: ttl,
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
 * GET /api/img/[id]?w=&h=&fit=&format=&exp=&sig=
 * Task B.12: Verifies HMAC-SHA256 signature & expiration, enforces dimension bounds (16..2000 px),
 * transforms the image with `sharp`, enforces Vercel's 4 MB response ceiling, and serves with
 * visibility-aware Cache-Control headers.
 */
export async function GET(
  req: NextRequest,
  context: { params: { id: string } | Promise<{ id: string }> }
) {
  try {
    const resolvedParams = await Promise.resolve(context.params);
    const fileId = resolvedParams?.id?.trim();

    if (!fileId || !UUID_REGEX.test(fileId)) {
      return NextResponse.json(
        { error: 'Bad Request', code: 'INVALID_FILE_ID', message: 'El id del archivo no es un UUID v4 válido.' },
        { status: 400, headers: corsHeaders }
      );
    }

    const { searchParams } = new URL(req.url);
    const wRaw = searchParams.get('w');
    const hRaw = searchParams.get('h');
    const fitRaw = (searchParams.get('fit') || 'cover').toLowerCase().trim();
    const formatRaw = (searchParams.get('format') || 'webp').toLowerCase().trim();
    const expRaw = searchParams.get('exp') || '';
    const sigRaw = searchParams.get('sig') || '';

    // 1. Verify HMAC-SHA256 signature and expiration first
    const sigCheck = verifyImageTransformSignature({
      fileId,
      w: wRaw,
      h: hRaw,
      fit: fitRaw,
      format: formatRaw,
      exp: expRaw,
      sig: sigRaw,
    });

    if (!sigCheck.valid) {
      const status =
        sigCheck.code === 'TRANSFORM_URL_EXPIRED'
          ? 410
          : sigCheck.code === 'MISSING_TRANSFORM_SIGNATURE'
          ? 400
          : 403;
      return NextResponse.json(
        {
          error: status === 410 ? 'Gone' : status === 400 ? 'Bad Request' : 'Forbidden',
          code: sigCheck.code,
          message: sigCheck.message,
        },
        { status, headers: corsHeaders }
      );
    }

    // 2. Validate dimensions (16..2000 px)
    let width: number | undefined;
    let height: number | undefined;

    if (wRaw !== null && wRaw !== '') {
      width = Number(wRaw);
      if (!Number.isInteger(width) || width < MIN_TRANSFORM_DIMENSION || width > MAX_TRANSFORM_DIMENSION) {
        return NextResponse.json(
          {
            error: 'Bad Request',
            code: 'INVALID_TRANSFORM_DIMENSIONS',
            message: `El ancho solicitado (w=${wRaw}) está fuera del rango permitido (${MIN_TRANSFORM_DIMENSION}..${MAX_TRANSFORM_DIMENSION} px).`,
          },
          { status: 400, headers: corsHeaders }
        );
      }
    }

    if (hRaw !== null && hRaw !== '') {
      height = Number(hRaw);
      if (!Number.isInteger(height) || height < MIN_TRANSFORM_DIMENSION || height > MAX_TRANSFORM_DIMENSION) {
        return NextResponse.json(
          {
            error: 'Bad Request',
            code: 'INVALID_TRANSFORM_DIMENSIONS',
            message: `El alto solicitado (h=${hRaw}) está fuera del rango permitido (${MIN_TRANSFORM_DIMENSION}..${MAX_TRANSFORM_DIMENSION} px).`,
          },
          { status: 400, headers: corsHeaders }
        );
      }
    }

    if (!ALLOWED_TRANSFORM_FITS.has(fitRaw)) {
      return NextResponse.json(
        { error: 'Bad Request', code: 'INVALID_TRANSFORM_FIT', message: `Modo fit '${fitRaw}' no permitido.` },
        { status: 400, headers: corsHeaders }
      );
    }

    if (!ALLOWED_TRANSFORM_FORMATS.has(formatRaw)) {
      return NextResponse.json(
        { error: 'Bad Request', code: 'INVALID_TRANSFORM_FORMAT', message: `Formato '${formatRaw}' no permitido.` },
        { status: 400, headers: corsHeaders }
      );
    }

    // 3. Query file record
    const { data: fileRow, error: dbErr } = await supabase
      .from('files')
      .select('*')
      .eq('id', fileId)
      .maybeSingle();

    if (dbErr || !fileRow) {
      return NextResponse.json(
        { error: 'Not Found', code: 'FILE_NOT_FOUND', message: 'El archivo no existe.' },
        { status: 404, headers: corsHeaders }
      );
    }

    if (!String(fileRow.mime_type || '').startsWith('image/')) {
      return NextResponse.json(
        {
          error: 'Bad Request',
          code: 'NOT_AN_IMAGE',
          message: `El archivo '${fileRow.original_name}' (${fileRow.mime_type}) no es una imagen transformable.`,
        },
        { status: 400, headers: corsHeaders }
      );
    }

    const s3Key =
      fileRow.status === 'processed' && fileRow.s3_processed_key
        ? fileRow.s3_processed_key
        : fileRow.s3_processed_key || fileRow.s3_pending_key;

    if (!s3Key) {
      return NextResponse.json(
        { error: 'Not Found', code: 'S3_KEY_NOT_FOUND', message: 'El archivo no tiene clave en S3.' },
        { status: 404, headers: corsHeaders }
      );
    }

    const sourceBuffer = await getS3ObjectBuffer(s3Key);
    if (!sourceBuffer || sourceBuffer.length === 0) {
      return NextResponse.json(
        { error: 'Not Found', code: 'S3_OBJECT_EMPTY', message: 'No se pudo leer el objeto binario desde S3.' },
        { status: 404, headers: corsHeaders }
      );
    }

    // 4. Transform image with sharp (.rotate() first to strip EXIF and preserve orientation)
    let pipeline = sharp(sourceBuffer).rotate();
    if (width || height) {
      pipeline = pipeline.resize({
        width,
        height,
        fit: fitRaw as any,
        withoutEnlargement: false,
      });
    }

    let contentType = 'image/webp';
    if (formatRaw === 'webp') {
      pipeline = pipeline.webp({ quality: 85 });
      contentType = 'image/webp';
    } else if (formatRaw === 'jpeg' || formatRaw === 'jpg') {
      pipeline = pipeline.jpeg({ quality: 88, mozjpeg: true });
      contentType = 'image/jpeg';
    } else if (formatRaw === 'png') {
      pipeline = pipeline.png({ compressionLevel: 9 });
      contentType = 'image/png';
    } else if (formatRaw === 'avif') {
      pipeline = pipeline.avif({ quality: 75 });
      contentType = 'image/avif';
    }

    const outputBuffer = await pipeline.toBuffer();

    // 5. Enforce Vercel 4 MB response limit
    if (outputBuffer.length > MAX_VERCEL_RESPONSE_BYTES) {
      return NextResponse.json(
        {
          error: 'Payload Too Large',
          code: 'TRANSFORM_OUTPUT_TOO_LARGE',
          message: `La imagen resultante (${outputBuffer.length} bytes) supera el límite seguro de respuesta de Vercel (${MAX_VERCEL_RESPONSE_BYTES} bytes). Reduce w/h o usa formato webp/avif.`,
        },
        { status: 413, headers: corsHeaders }
      );
    }

    const cacheControl =
      fileRow.visibility === 'public'
        ? PUBLIC_SHORT_TTL_CACHE_CONTROL
        : PRIVATE_NO_STORE_CACHE_CONTROL;

    await addServiceLog({
      method: 'GET',
      action: 'IMAGE_TRANSFORMED',
      status: 'ALLOWED',
      userId: fileRow.user_id,
      orgId: fileRow.org_id,
      fileId: fileRow.id,
      ticketId: fileRow.ticket_id,
      fileName: fileRow.original_name,
      ipAddress: req.headers.get('x-forwarded-for') || '127.0.0.1',
      message: `Transformación sharp ejecutada (w=${width || 'auto'}, h=${height || 'auto'}, fit=${fitRaw}, format=${formatRaw}, out=${outputBuffer.length} bytes).`,
    });

    return new NextResponse(new Uint8Array(outputBuffer), {
      status: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': contentType,
        'Content-Length': String(outputBuffer.length),
        'Cache-Control': cacheControl,
        'X-Transform-Format': formatRaw,
        'X-Transform-Bytes': String(outputBuffer.length),
      },
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: 'Internal Server Error', code: 'IMAGE_TRANSFORM_ERROR', message: err.message },
      { status: 500, headers: corsHeaders }
    );
  }
}
