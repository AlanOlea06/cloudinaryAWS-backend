import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { supabase } from '@/lib/supabase';
import { verifyAdminSecretHeader } from '@/lib/env';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_MAX_KEYS_PER_ORG = 3;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-admin-secret',
  'X-Content-Type-Options': 'nosniff',
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

function hashApiKey(rawKey: string): string {
  return crypto.createHash('sha256').update(rawKey).digest('hex');
}

function enforceAdminAuth(req: NextRequest): NextResponse | null {
  const check = verifyAdminSecretHeader(req.headers);
  if (!check.valid) {
    return NextResponse.json(
      {
        error: check.status === 401 ? 'Unauthorized' : 'Forbidden',
        code: check.code,
        message: check.message,
      },
      { status: check.status, headers: corsHeaders }
    );
  }
  return null;
}

/**
 * GET /api/keys?org_id=<uuid>
 * Lists API keys (never exposing hashed_key or plaintext key).
 * Requires ADMIN_API_SECRET.
 */
export async function GET(req: NextRequest) {
  const authError = enforceAdminAuth(req);
  if (authError) return authError;

  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get('org_id')?.trim();

    if (orgId && !UUID_REGEX.test(orgId)) {
      return NextResponse.json(
        { error: 'Bad Request', code: 'INVALID_ORG_ID', message: 'El parámetro org_id debe ser un UUID válido.' },
        { status: 400, headers: corsHeaders }
      );
    }

    let query = supabase
      .from('api_keys')
      .select('id, org_id, user_id, name, can_read, can_upload, can_delete, is_active, created_at')
      .order('created_at', { ascending: false });

    if (orgId) {
      query = query.eq('org_id', orgId);
    }

    const { data, error } = await query;

    if (error) {
      return NextResponse.json(
        { error: 'Database Error', message: error.message },
        { status: 500, headers: corsHeaders }
      );
    }

    return NextResponse.json(
      {
        status: 'success',
        count: data?.length || 0,
        keys: data || [],
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
 * POST /api/keys
 * Creates a new API Key for an organization.
 * Requires ADMIN_API_SECRET.
 *
 * Section 3 (Option A):
 * - Keys are bound to the organization (`org_id`) for backend-to-backend usage.
 * - `user_id` (`user_id` or `userId`) is OPTIONAL (nullable). If omitted or null,
 *   the key is an organization-level key and the client backend sends the end-user
 *   via the `x-user-id` header on each request.
 * - Active keys limit per organization is read from `organizations.max_api_keys` (default 3).
 */
export async function POST(req: NextRequest) {
  const authError = enforceAdminAuth(req);
  if (authError) return authError;

  try {
    const body = await req.json().catch(() => ({}));
    const {
      org_id,
      orgId,
      user_id,
      userId,
      name,
      can_read,
      canRead,
      can_upload,
      canUpload,
      can_delete,
      canDelete,
    } = body;

    const rawOrgId = orgId !== undefined ? orgId : org_id;
    const cleanOrgId = typeof rawOrgId === 'string' ? rawOrgId.trim() : '';

    const rawUserId = userId !== undefined ? userId : user_id;
    const cleanUserId =
      typeof rawUserId === 'string' && rawUserId.trim().length > 0
        ? rawUserId.trim()
        : null;

    const cleanName = typeof name === 'string' ? name.trim() : '';

    const effectiveCanRead = canRead !== undefined ? Boolean(canRead) : Boolean(can_read);
    const effectiveCanUpload = canUpload !== undefined ? Boolean(canUpload) : Boolean(can_upload);
    const effectiveCanDelete = canDelete !== undefined ? Boolean(canDelete) : Boolean(can_delete);

    if (!cleanOrgId || !UUID_REGEX.test(cleanOrgId)) {
      return NextResponse.json(
        {
          error: 'Bad Request',
          code: 'INVALID_ORG_ID',
          message: 'El campo org_id (u orgId) es obligatorio y debe ser un UUID v4 válido.',
        },
        { status: 400, headers: corsHeaders }
      );
    }

    if (cleanUserId !== null && !UUID_REGEX.test(cleanUserId)) {
      return NextResponse.json(
        {
          error: 'Bad Request',
          code: 'INVALID_USER_ID',
          message: 'Si se proporciona user_id, debe ser un UUID v4 válido (o null para llave de organización).',
        },
        { status: 400, headers: corsHeaders }
      );
    }

    if (!cleanName || cleanName.length < 2 || cleanName.length > 80) {
      return NextResponse.json(
        {
          error: 'Bad Request',
          code: 'INVALID_KEY_NAME',
          message: 'El campo name es obligatorio y debe tener entre 2 y 80 caracteres.',
        },
        { status: 400, headers: corsHeaders }
      );
    }

    // 1. Verify organization exists and read configurable max_api_keys (default 3)
    const { data: orgData, error: orgError } = await supabase
      .from('organizations')
      .select('*')
      .eq('id', cleanOrgId)
      .maybeSingle();

    if (orgError || !orgData) {
      return NextResponse.json(
        {
          error: 'Not Found',
          code: 'ORGANIZATION_NOT_FOUND',
          message: `La organización '${cleanOrgId}' no existe.`,
        },
        { status: 404, headers: corsHeaders }
      );
    }

    const maxKeysForOrg =
      typeof orgData.max_api_keys === 'number' && orgData.max_api_keys >= 1
        ? orgData.max_api_keys
        : DEFAULT_MAX_KEYS_PER_ORG;

    // 2. If an optional user_id was provided, verify it exists and belongs to cleanOrgId
    if (cleanUserId !== null) {
      const { data: userData, error: userError } = await supabase
        .from('users')
        .select('id, org_id, name, email')
        .eq('id', cleanUserId)
        .maybeSingle();

      if (userError || !userData) {
        return NextResponse.json(
          {
            error: 'Not Found',
            code: 'USER_NOT_FOUND',
            message: `El usuario '${cleanUserId}' no existe.`,
          },
          { status: 404, headers: corsHeaders }
        );
      }

      if (userData.org_id !== cleanOrgId) {
        return NextResponse.json(
          {
            error: 'Forbidden',
            code: 'USER_ORG_MISMATCH',
            message: `El usuario '${cleanUserId}' no pertenece a la organización '${cleanOrgId}'.`,
          },
          { status: 403, headers: corsHeaders }
        );
      }
    }

    // 3. Enforce per-organization active key limit (configurable via organizations.max_api_keys)
    const { count: activeKeyCount, error: countError } = await supabase
      .from('api_keys')
      .select('id', { count: 'exact', head: true })
      .eq('org_id', cleanOrgId)
      .eq('is_active', true);

    if (countError) {
      return NextResponse.json(
        { error: 'Database Error', message: countError.message },
        { status: 500, headers: corsHeaders }
      );
    }

    if ((activeKeyCount ?? 0) >= maxKeysForOrg) {
      return NextResponse.json(
        {
          error: 'Conflict',
          code: 'MAX_API_KEYS_LIMIT_REACHED',
          message: `Límite alcanzado: la organización '${orgData.name}' ya cuenta con el máximo permitido de ${maxKeysForOrg} API Keys activas. Revoca o elimina una llave antes de emitir una nueva, o incrementa max_api_keys en la organización.`,
          details: {
            orgId: cleanOrgId,
            activeKeys: activeKeyCount,
            maxAllowed: maxKeysForOrg,
          },
        },
        { status: 409, headers: corsHeaders }
      );
    }

    // 4. Generate 256-bit (32-byte) secret key with sk_live_ prefix
    const randomHex = crypto.randomBytes(32).toString('hex');
    const rawApiKey = `sk_live_${randomHex}`;
    const hashedKey = hashApiKey(rawApiKey);

    // 5. Persist only the SHA-256 hash in DB (user_id is null for org-level keys)
    const insertPayload: Record<string, any> = {
      org_id: cleanOrgId,
      user_id: cleanUserId,
      name: cleanName,
      hashed_key: hashedKey,
      can_read: effectiveCanRead,
      can_upload: effectiveCanUpload,
      can_delete: effectiveCanDelete,
      is_active: true,
    };

    const { data: insertedKey, error: insertError } = await supabase
      .from('api_keys')
      .insert(insertPayload)
      .select('id, org_id, user_id, name, can_read, can_upload, can_delete, is_active, created_at')
      .single();

    if (insertError) {
      return NextResponse.json(
        { error: 'Database Error', message: insertError.message },
        { status: 500, headers: corsHeaders }
      );
    }

    return NextResponse.json(
      {
        status: 'created',
        message:
          'IMPORTANTE: Guarda esta API Key en el backend en un lugar seguro. Por razones de seguridad (Zero-Knowledge), nunca volverá a mostrarse.',
        apiKey: rawApiKey,
        keyMetadata: {
          ...insertedKey,
          scope: cleanUserId ? 'user_bound' : 'organization_backend',
          maxAllowedForOrg: maxKeysForOrg,
        },
      },
      { status: 201, headers: corsHeaders }
    );
  } catch (err: any) {
    return NextResponse.json(
      { error: 'Internal Server Error', message: err.message },
      { status: 500, headers: corsHeaders }
    );
  }
}

/**
 * DELETE /api/keys?id=<uuid>
 * Revokes or permanently deletes an API Key.
 * Requires ADMIN_API_SECRET.
 */
export async function DELETE(req: NextRequest) {
  const authError = enforceAdminAuth(req);
  if (authError) return authError;

  try {
    const { searchParams } = new URL(req.url);
    let keyId = searchParams.get('id')?.trim() || searchParams.get('keyId')?.trim();
    let mode = searchParams.get('mode') || 'delete';

    if (!keyId) {
      try {
        const body = await req.json();
        keyId = (body.id || body.keyId || body.apiKeyId)?.trim();
        if (body.mode) mode = body.mode;
      } catch {}
    }

    if (!keyId || !UUID_REGEX.test(keyId)) {
      return NextResponse.json(
        { error: 'Bad Request', code: 'INVALID_KEY_ID', message: 'El parámetro id (o keyId) debe ser un UUID v4 válido.' },
        { status: 400, headers: corsHeaders }
      );
    }

    if (mode === 'revoke') {
      const { data, error } = await supabase
        .from('api_keys')
        .update({ is_active: false })
        .eq('id', keyId)
        .select('id, org_id, user_id, name, is_active')
        .maybeSingle();

      if (error) {
        return NextResponse.json({ error: 'Database Error', message: error.message }, { status: 500, headers: corsHeaders });
      }
      if (!data) {
        return NextResponse.json({ error: 'Not Found', message: 'API Key no encontrada.' }, { status: 404, headers: corsHeaders });
      }

      return NextResponse.json(
        { status: 'revoked', message: 'API Key desactivada exitosamente.', key: data },
        { status: 200, headers: corsHeaders }
      );
    }

    const { data, error } = await supabase
      .from('api_keys')
      .delete()
      .eq('id', keyId)
      .select('id, org_id, user_id, name')
      .maybeSingle();

    if (error) {
      return NextResponse.json({ error: 'Database Error', message: error.message }, { status: 500, headers: corsHeaders });
    }
    if (!data) {
      return NextResponse.json({ error: 'Not Found', message: 'API Key no encontrada.' }, { status: 404, headers: corsHeaders });
    }

    return NextResponse.json(
      { status: 'deleted', message: 'API Key eliminada permanentemente.', key: data },
      { status: 200, headers: corsHeaders }
    );
  } catch (err: any) {
    return NextResponse.json(
      { error: 'Internal Server Error', message: err.message },
      { status: 500, headers: corsHeaders }
    );
  }
}
