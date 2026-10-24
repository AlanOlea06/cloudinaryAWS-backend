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

function extractBoundUserId(row: any): string | null {
  if (row?.user_id) return row.user_id;
  const match = typeof row?.name === 'string' ? row.name.match(/\[uid:([0-9a-f-]{36})\]/i) : null;
  return match ? match[1] : null;
}

function stripUidTag(name: string): string {
  return (name || '').replace(/\s*\[uid:[0-9a-f-]{36}\]/gi, '').trim();
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

    const { data: rawKeys, error } = await supabase
      .from('api_keys')
      .select('*')
      .eq('org_id', orgId)
      .order('created_at', { ascending: false });

    if (error) {
      return NextResponse.json(
        { error: 'Database Error', message: error.message },
        { status: 500, headers: corsHeaders }
      );
    }

    const keys = (rawKeys || []).map((k: any) => ({
      id: k.id,
      org_id: k.org_id,
      user_id: extractBoundUserId(k),
      name: stripUidTag(k.name),
      can_read: k.can_read,
      can_upload: k.can_upload,
      can_delete: k.can_delete,
      is_active: k.is_active,
      created_at: k.created_at,
    }));

    return NextResponse.json(
      {
        status: 'success',
        orgId,
        total: keys.length,
        keys,
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

// 3. POST: Fabricar nueva API Key (Regla de negocio: máx 3 activas por org + vinculación a user_id Decisión 1-A)
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const {
      orgId,
      userId: incomingUserId,
      user_id: incomingUserIdSnake,
      name,
      can_read = false,
      can_upload = false,
      can_delete = false,
      canRead,
      canUpload,
      canDelete,
    } = body;

    const requestedUserId = (incomingUserId || incomingUserIdSnake || '').trim();

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

    // Decisión 1-A: Resolver y validar el usuario propietario (user_id) de la llave API
    let boundUser: any = null;
    if (requestedUserId) {
      const { data: dbUser } = await supabase
        .from('users')
        .select('id, org_id, name, email, role, can_upload')
        .eq('id', requestedUserId)
        .maybeSingle();

      if (!dbUser) {
        return NextResponse.json(
          {
            error: 'Not Found',
            code: 'USER_NOT_FOUND',
            message: `El usuario con ID "${requestedUserId}" no existe en la base de datos.`,
          },
          { status: 404, headers: corsHeaders }
        );
      }

      if (dbUser.org_id !== orgId) {
        return NextResponse.json(
          {
            error: 'Forbidden',
            code: 'USER_ORG_MISMATCH',
            message: `El usuario "${dbUser.name}" no pertenece a la organización "${orgData.name}".`,
          },
          { status: 403, headers: corsHeaders }
        );
      }
      boundUser = dbUser;
    } else {
      // Si no se especificó userId, asociar al administrador principal de esa organización
      const { data: defaultUser } = await supabase
        .from('users')
        .select('id, org_id, name, email, role, can_upload')
        .eq('org_id', orgId)
        .order('role', { ascending: true })
        .limit(1)
        .maybeSingle();
      boundUser = defaultUser || null;
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
    const cleanKeyName = stripUidTag(name);

    let insertedKey: any = null;
    let insertErr: any = null;

    // Intentar insertar con la columna nativa user_id (Migración Fase 0)
    const primaryPayload: Record<string, any> = {
      org_id: orgId,
      user_id: boundUser?.id || null,
      name: cleanKeyName,
      hashed_key: hashedKey,
      can_read: effectiveCanRead,
      can_upload: effectiveCanUpload,
      can_delete: effectiveCanDelete,
      is_active: true,
    };

    const primaryRes = await supabase
      .from('api_keys')
      .insert(primaryPayload)
      .select('*')
      .single();

    insertedKey = primaryRes.data;
    insertErr = primaryRes.error;

    // Fallback resiliente si la migración ALTER TABLE api_keys ADD COLUMN user_id aún no se ha corrido en el SQL Editor
    if (insertErr && insertErr.message?.includes('user_id')) {
      const taggedName = boundUser?.id ? `${cleanKeyName} [uid:${boundUser.id}]` : cleanKeyName;
      const fallbackRes = await supabase
        .from('api_keys')
        .insert({
          org_id: orgId,
          name: taggedName,
          hashed_key: hashedKey,
          can_read: effectiveCanRead,
          can_upload: effectiveCanUpload,
          can_delete: effectiveCanDelete,
          is_active: true,
        })
        .select('*')
        .single();
      insertedKey = fallbackRes.data;
      insertErr = fallbackRes.error;
    }

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

    const finalBoundUserId = extractBoundUserId(insertedKey) || boundUser?.id || null;

    // REGLA 4: RESPUESTA (Devolver la llave plana UNA SOLA VEZ)
    return NextResponse.json(
      {
        status: 'success',
        message: 'Llave API generada con éxito. Cópiala y guárdala en un lugar seguro; no se volverá a mostrar.',
        apiKey: plainApiKey,
        key: {
          id: insertedKey.id,
          orgId: insertedKey.org_id,
          userId: finalBoundUserId,
          userName: boundUser?.name || null,
          organizationName: orgData.name,
          organizationSlug: orgData.slug,
          name: cleanKeyName,
          permissions: {
            can_read: insertedKey.can_read,
            can_upload: insertedKey.can_upload,
            can_delete: insertedKey.can_delete,
          },
          isActive: insertedKey.is_active,
          createdAt: insertedKey.created_at,
        },
        // Alias retrocompatible
        keyRecord: {
          id: insertedKey.id,
          orgId: insertedKey.org_id,
          userId: finalBoundUserId,
          name: cleanKeyName,
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
