import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { supabase } from '@/lib/supabase';

// CORS Headers para permitir llamadas desde Postman, cliente local o producción
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key',
};

// 1. Manejador OPTIONS (Preflight)
export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: corsHeaders,
  });
}

// 2. GET: Listar llaves de una organización (sin exponer secretos)
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get('orgId');

    if (!orgId) {
      return NextResponse.json(
        {
          error: 'Bad Request',
          code: 'MISSING_ORG_ID',
          message: 'El parámetro "orgId" es requerido para listar las llaves.',
        },
        { status: 400, headers: corsHeaders }
      );
    }

    const { data: keys, error } = await supabase
      .from('api_keys')
      .select('id, org_id, name, can_read, can_upload, can_delete, is_active, created_at')
      .eq('org_id', orgId)
      .order('created_at', { ascending: false });

    if (error) {
      return NextResponse.json(
        { error: 'Database Error', message: error.message },
        { status: 500, headers: corsHeaders }
      );
    }

    return NextResponse.json(
      {
        status: 'success',
        orgId,
        total: keys?.length || 0,
        keys: keys || [],
      },
      { status: 200, headers: corsHeaders }
    );
  } catch (error: any) {
    return NextResponse.json(
      { error: 'Internal Server Error', message: error.message },
      { status: 500, headers: corsHeaders }
    );
  }
}

// 3. POST: Fabricar nueva API Key (Regla de negocio: máx 3 activas por org)
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const {
      orgId,
      name,
      can_read = false,
      can_upload = false,
      can_delete = false,
      canRead,
      canUpload,
      canDelete,
    } = body;

    // Validaciones básicas de entrada
    if (!orgId) {
      return NextResponse.json(
        {
          error: 'Bad Request',
          code: 'MISSING_ORG_ID',
          message: 'El campo "orgId" es obligatorio para asociar la llave.',
        },
        { status: 400, headers: corsHeaders }
      );
    }

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return NextResponse.json(
        {
          error: 'Bad Request',
          code: 'MISSING_KEY_NAME',
          message: 'El campo "name" es obligatorio para identificar el propósito de la llave.',
        },
        { status: 400, headers: corsHeaders }
      );
    }

    // Verificar que la organización exista en Supabase
    const { data: orgData, error: orgErr } = await supabase
      .from('organizations')
      .select('id, name, slug')
      .eq('id', orgId)
      .maybeSingle();

    if (orgErr || !orgData) {
      return NextResponse.json(
        {
          error: 'Not Found',
          code: 'ORGANIZATION_NOT_FOUND',
          message: `La organización con ID "${orgId}" no existe en la base de datos.`,
        },
        { status: 404, headers: corsHeaders }
      );
    }

    // REGLA 1: LÍMITE DE CANTIDAD (Máximo 3 llaves activas por organización)
    const { count, error: countErr } = await supabase
      .from('api_keys')
      .select('*', { count: 'exact', head: true })
      .eq('org_id', orgId)
      .eq('is_active', true);

    if (countErr) {
      return NextResponse.json(
        {
          error: 'Database Error',
          code: 'COUNT_QUERY_FAILED',
          message: `Error al consultar cuota de llaves: ${countErr.message}`,
        },
        { status: 500, headers: corsHeaders }
      );
    }

    if (count !== null && count >= 3) {
      return NextResponse.json(
        {
          error: 'Bad Request',
          code: 'API_KEY_LIMIT_REACHED',
          message: `Límite alcanzado: La organización "${orgData.name}" ya cuenta con el máximo permitido de 3 llaves API activas. Revoca o desactiva una llave existente para generar una nueva.`,
          currentActiveKeys: count,
          maxAllowed: 3,
        },
        { status: 400, headers: corsHeaders }
      );
    }

    // REGLA 2: GENERACIÓN SEGURA (Llave plana con prefijo sk_live_ y 32 bytes de entropía)
    const rawEntropy = crypto.randomBytes(32).toString('hex');
    const plainApiKey = `sk_live_${rawEntropy}`;

    // REGLA 3: ALMACENAMIENTO SEGURO (Hashear con SHA-256; solo almacenar el digest)
    const hashedKey = crypto.createHash('sha256').update(plainApiKey).digest('hex');

    const effectiveCanRead = Boolean(can_read ?? canRead);
    const effectiveCanUpload = Boolean(can_upload ?? canUpload);
    const effectiveCanDelete = Boolean(can_delete ?? canDelete);

    const { data: insertedKey, error: insertErr } = await supabase
      .from('api_keys')
      .insert({
        org_id: orgId,
        name: name.trim(),
        hashed_key: hashedKey,
        can_read: effectiveCanRead,
        can_upload: effectiveCanUpload,
        can_delete: effectiveCanDelete,
        is_active: true,
      })
      .select('id, org_id, name, can_read, can_upload, can_delete, is_active, created_at')
      .single();

    if (insertErr || !insertedKey) {
      return NextResponse.json(
        {
          error: 'Database Error',
          code: 'KEY_INSERTION_FAILED',
          message: `No se pudo persistir la llave API: ${insertErr?.message}`,
        },
        { status: 500, headers: corsHeaders }
      );
    }

    // REGLA 4: RESPUESTA (Devolver la llave plana UNA SOLA VEZ)
    return NextResponse.json(
      {
        status: 'success',
        message: 'Llave API generada con éxito. Cópiala y guárdala en un lugar seguro; no se volverá a mostrar.',
        apiKey: plainApiKey,
        key: {
          id: insertedKey.id,
          orgId: insertedKey.org_id,
          organizationName: orgData.name,
          organizationSlug: orgData.slug,
          name: insertedKey.name,
          permissions: {
            can_read: insertedKey.can_read,
            can_upload: insertedKey.can_upload,
            can_delete: insertedKey.can_delete,
          },
          isActive: insertedKey.is_active,
          createdAt: insertedKey.created_at,
        },
      },
      { status: 201, headers: corsHeaders }
    );
  } catch (error: any) {
    return NextResponse.json(
      { error: 'Internal Server Error', message: error.message },
      { status: 500, headers: corsHeaders }
    );
  }
}

// 4. DELETE: Revocación de llave (Soft delete: is_active = false)
export async function DELETE(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const keyId = searchParams.get('keyId');

    if (!keyId) {
      return NextResponse.json(
        {
          error: 'Bad Request',
          code: 'MISSING_KEY_ID',
          message: 'El parámetro "keyId" es requerido para revocar la llave.',
        },
        { status: 400, headers: corsHeaders }
      );
    }

    const { data: revoked, error } = await supabase
      .from('api_keys')
      .update({ is_active: false })
      .eq('id', keyId)
      .select('id, name, org_id, is_active')
      .single();

    if (error) {
      return NextResponse.json(
        { error: 'Database Error', message: error.message },
        { status: 500, headers: corsHeaders }
      );
    }

    return NextResponse.json(
      {
        status: 'success',
        message: `La llave API "${revoked.name}" (${revoked.id}) ha sido revocada exitosamente.`,
        key: revoked,
      },
      { status: 200, headers: corsHeaders }
    );
  } catch (error: any) {
    return NextResponse.json(
      { error: 'Internal Server Error', message: error.message },
      { status: 500, headers: corsHeaders }
    );
  }
}
