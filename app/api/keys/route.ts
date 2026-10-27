import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { supabase } from '@/lib/supabase';
import { verifyAdminSecretHeader } from '@/lib/env';
import { addServiceLog } from '@/lib/service-logs';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_MAX_KEYS_PER_ORG = 3;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-admin-secret, x-api-key',
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'private, no-store, no-cache, max-age=0, must-revalidate',
  'Pragma': 'no-cache',
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

function hashApiKey(rawKey: string): string {
  return crypto.createHash('sha256').update(rawKey).digest('hex');
}

interface AdminCaller {
  type: 'admin';
}

interface DelegatedCaller {
  type: 'delegated';
  callerKey: {
    id: string;
    org_id: string;
    user_id: string | null;
    name: string;
    can_read: boolean;
    can_upload: boolean;
    can_delete: boolean;
    can_manage_keys: boolean;
    is_active: boolean;
  };
}

type CallerAuthResult =
  | { success: true; auth: AdminCaller | DelegatedCaller }
  | { success: false; response: NextResponse };

/**
 * Resolves and independently validates caller authentication.
 * Condition 1: Never trusts forwarded headers; always re-reads caller state from the database.
 * Condition 2: Only organization keys (user_id IS NULL) can have can_manage_keys=true.
 */
async function resolveCallerAuth(req: NextRequest): Promise<CallerAuthResult> {
  // 1. Check for platform administration secret
  const adminCheck = verifyAdminSecretHeader(req.headers);
  if (adminCheck.valid) {
    return { success: true, auth: { type: 'admin' } };
  }

  // 2. Check for delegated organization API key
  const rawApiKey = req.headers.get('x-api-key')?.trim();
  if (!rawApiKey) {
    return {
      success: false,
      response: NextResponse.json(
        {
          error: 'Unauthorized',
          code: 'AUTHENTICATION_REQUIRED',
          message: 'Se requiere la cabecera x-admin-secret o una x-api-key con permisos de administración.',
        },
        { status: 401, headers: corsHeaders }
      ),
    };
  }

  // Re-read directly from Supabase (defense-in-depth against header tampering)
  const hashed = hashApiKey(rawApiKey);
  const { data: keyRecord, error } = await supabase
    .from('api_keys')
    .select('id, org_id, user_id, name, can_read, can_upload, can_delete, can_manage_keys, is_active')
    .eq('hashed_key', hashed)
    .maybeSingle();

  if (error || !keyRecord || !keyRecord.is_active) {
    return {
      success: false,
      response: NextResponse.json(
        {
          error: 'Forbidden',
          code: 'INVALID_OR_INACTIVE_API_KEY',
          message: 'Acceso denegado: la API Key no existe o ha sido desactivada.',
        },
        { status: 403, headers: corsHeaders }
      ),
    };
  }

  // Rule 2: A key bound to a specific user can never manage keys
  if (keyRecord.user_id !== null) {
    return {
      success: false,
      response: NextResponse.json(
        {
          error: 'Forbidden',
          code: 'USER_KEY_CANNOT_MANAGE_KEYS',
          message: 'Las API Keys vinculadas a un usuario específico no tienen autorización para gestionar llaves.',
        },
        { status: 403, headers: corsHeaders }
      ),
    };
  }

  // Check can_manage_keys privilege
  if (!keyRecord.can_manage_keys) {
    return {
      success: false,
      response: NextResponse.json(
        {
          error: 'Forbidden',
          code: 'CANNOT_MANAGE_KEYS',
          message: `La API Key '${keyRecord.name}' no tiene permisos de administración de llaves (can_manage_keys=false).`,
        },
        { status: 403, headers: corsHeaders }
      ),
    };
  }

  return {
    success: true,
    auth: {
      type: 'delegated',
      callerKey: keyRecord as DelegatedCaller['callerKey'],
    },
  };
}

/**
 * GET /api/keys?org_id=<uuid>
 * Lists API keys for an organization.
 * - Admin (x-admin-secret): Can query any organization or list all.
 * - Delegated key (x-api-key with can_manage_keys=true): Can ONLY list keys belonging to its own organization.
 */
export async function GET(req: NextRequest) {
  const authResult = await resolveCallerAuth(req);
  if (!authResult.success) return authResult.response;

  try {
    const { searchParams } = new URL(req.url);
    const requestedOrgId = searchParams.get('org_id')?.trim() || searchParams.get('orgId')?.trim();

    if (requestedOrgId && !UUID_REGEX.test(requestedOrgId)) {
      return NextResponse.json(
        { error: 'Bad Request', code: 'INVALID_ORG_ID', message: 'El parámetro org_id debe ser un UUID válido.' },
        { status: 400, headers: corsHeaders }
      );
    }

    let targetOrgId: string | null = null;

    if (authResult.auth.type === 'admin') {
      targetOrgId = requestedOrgId || null;
    } else {
      // Delegated: strictly enforce caller's org_id
      const callerOrgId = authResult.auth.callerKey.org_id;
      if (requestedOrgId && requestedOrgId !== callerOrgId) {
        return NextResponse.json(
          {
            error: 'Forbidden',
            code: 'FORBIDDEN_CROSS_ORG',
            message: 'Aislamiento Multi-Tenant: No puedes consultar las llaves de otra organización.',
          },
          { status: 403, headers: corsHeaders }
        );
      }
      targetOrgId = callerOrgId;
    }

    let query = supabase
      .from('api_keys')
      .select('id, org_id, user_id, name, can_read, can_upload, can_delete, can_manage_keys, is_active, created_at')
      .order('created_at', { ascending: false });

    if (targetOrgId) {
      query = query.eq('org_id', targetOrgId);
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
 * Creates a new API Key.
 *
 * Rules:
 * 1. Admin (x-admin-secret): Can create for any org, can explicitly set canManageKeys=true (only for org keys).
 * 2. Delegated key (can_manage_keys=true):
 *    - Always creates keys for its own organization (body orgId is ignored or enforced to caller's org).
 *    - Always creates keys with can_manage_keys=false (Condition 4).
 *    - Anti-escalation (Condition 6): cannot grant can_read, can_upload, or can_delete if caller doesn't have them.
 * 3. Atomic Quota (Condition 3): Enforced atomically in DB via FOR UPDATE trigger on organizations.
 * 4. Cache-Control (Condition 7): private, no-store.
 * 5. Audit (Condition 8): Audited in service_logs without logging raw keys or full hashes.
 */
export async function POST(req: NextRequest) {
  const authResult = await resolveCallerAuth(req);
  if (!authResult.success) return authResult.response;

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
      can_manage_keys,
      canManageKeys,
    } = body;

    // 1. Resolve Organization ID
    let effectiveOrgId: string;
    if (authResult.auth.type === 'admin') {
      const rawOrgId = orgId !== undefined ? orgId : org_id;
      effectiveOrgId = typeof rawOrgId === 'string' ? rawOrgId.trim() : '';
      if (!effectiveOrgId || !UUID_REGEX.test(effectiveOrgId)) {
        return NextResponse.json(
          {
            error: 'Bad Request',
            code: 'INVALID_ORG_ID',
            message: 'El campo org_id (u orgId) es obligatorio y debe ser un UUID v4 válido.',
          },
          { status: 400, headers: corsHeaders }
        );
      }
    } else {
      // Delegated: orgId always originates from the caller's verified key
      effectiveOrgId = authResult.auth.callerKey.org_id;
    }

    // 2. Resolve User ID (optional)
    const rawUserId = userId !== undefined ? userId : user_id;
    const cleanUserId =
      typeof rawUserId === 'string' && rawUserId.trim().length > 0
        ? rawUserId.trim()
        : null;

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

    // 3. Resolve Key Name
    const cleanName = typeof name === 'string' ? name.trim() : '';
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

    // 4. Resolve Permissions
    const effectiveCanRead = canRead !== undefined ? Boolean(canRead) : Boolean(can_read ?? true);
    const effectiveCanUpload = canUpload !== undefined ? Boolean(canUpload) : Boolean(can_upload ?? true);
    const effectiveCanDelete = canDelete !== undefined ? Boolean(canDelete) : Boolean(can_delete ?? false);

    // 5. Anti-Escalation Check (Condition 6)
    if (authResult.auth.type === 'delegated') {
      const caller = authResult.auth.callerKey;
      const isEscalation =
        (effectiveCanRead && !caller.can_read) ||
        (effectiveCanUpload && !caller.can_upload) ||
        (effectiveCanDelete && !caller.can_delete);

      if (isEscalation) {
        // Audit escalation attempt in service_logs (Condition 8)
        await addServiceLog({
          action: 'PRIVILEGE_ESCALATION_BLOCKED',
          status: 'DENIED',
          method: 'POST',
          orgId: caller.org_id,
          userId: cleanUserId || undefined,
          message: `Intento de escalada de privilegios bloqueado para la llave '${caller.name}' (${caller.id}). Solicitó (read=${effectiveCanRead}, upload=${effectiveCanUpload}, delete=${effectiveCanDelete}) pero la llave solo posee (read=${caller.can_read}, upload=${caller.can_upload}, delete=${caller.can_delete}).`,
        });

        return NextResponse.json(
          {
            error: 'Forbidden',
            code: 'PRIVILEGE_ESCALATION_BLOCKED',
            message: 'Violación de seguridad: No puedes crear una API Key con privilegios superiores a los de tu propia llave.',
          },
          { status: 403, headers: corsHeaders }
        );
      }
    }

    // 6. Resolve can_manage_keys (Condition 4)
    let targetCanManageKeys = false;
    if (authResult.auth.type === 'admin') {
      const requestedManage = canManageKeys !== undefined ? Boolean(canManageKeys) : (can_manage_keys !== undefined ? Boolean(can_manage_keys) : false);
      if (requestedManage) {
        // Condition 2: user-bound keys can NEVER manage keys
        if (cleanUserId !== null) {
          return NextResponse.json(
            {
              error: 'Bad Request',
              code: 'INVALID_KEY_CONFIG',
              message: 'Una llave vinculada a un usuario específico (user_id no nulo) no puede tener can_manage_keys=true. Solo las llaves de organización pueden gestionar llaves.',
            },
            { status: 400, headers: corsHeaders }
          );
        }
        targetCanManageKeys = true;
      }
    } else {
      // Condition 4: Delegated keys always create with false, without exception
      targetCanManageKeys = false;
    }

    // 7. Verify organization exists and read max_api_keys
    const { data: orgData, error: orgError } = await supabase
      .from('organizations')
      .select('id, name, max_api_keys')
      .eq('id', effectiveOrgId)
      .maybeSingle();

    if (orgError || !orgData) {
      return NextResponse.json(
        {
          error: 'Not Found',
          code: 'ORGANIZATION_NOT_FOUND',
          message: `La organización '${effectiveOrgId}' no existe.`,
        },
        { status: 404, headers: corsHeaders }
      );
    }

    const maxKeysForOrg =
      typeof orgData.max_api_keys === 'number' && orgData.max_api_keys >= 1
        ? orgData.max_api_keys
        : DEFAULT_MAX_KEYS_PER_ORG;

    // 8. If cleanUserId was provided, verify user exists and belongs to effectiveOrgId
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

      if (userData.org_id !== effectiveOrgId) {
        return NextResponse.json(
          {
            error: 'Forbidden',
            code: 'USER_ORG_MISMATCH',
            message: `El usuario '${cleanUserId}' no pertenece a la organización '${effectiveOrgId}'.`,
          },
          { status: 403, headers: corsHeaders }
        );
      }
    }

    // 9. Generate 256-bit (32-byte) secret key with sk_live_ prefix
    const randomHex = crypto.randomBytes(32).toString('hex');
    const rawApiKey = `sk_live_${randomHex}`;
    const hashedKey = hashApiKey(rawApiKey);

    // 10. Persist to database (Atomic quota enforced by trigger_check_api_keys_quota)
    const insertPayload: Record<string, any> = {
      org_id: effectiveOrgId,
      user_id: cleanUserId,
      name: cleanName,
      hashed_key: hashedKey,
      can_read: effectiveCanRead,
      can_upload: effectiveCanUpload,
      can_delete: effectiveCanDelete,
      can_manage_keys: targetCanManageKeys,
      is_active: true,
    };

    const { data: insertedKey, error: insertError } = await supabase
      .from('api_keys')
      .insert(insertPayload)
      .select('id, org_id, user_id, name, can_read, can_upload, can_delete, can_manage_keys, is_active, created_at')
      .single();

    if (insertError) {
      // Condition 3: Catch atomic quota limit from trigger
      if (
        insertError.message.includes('MAX_API_KEYS_LIMIT_REACHED') ||
        (insertError as any).code === 'P0001'
      ) {
        return NextResponse.json(
          {
            error: 'Conflict',
            code: 'MAX_API_KEYS_LIMIT_REACHED',
            message: `Cupo de llaves activas alcanzado: la organización ya cuenta con el máximo permitido de ${maxKeysForOrg} API Keys activas. Revoca o elimina una llave antes de crear una nueva.`,
            details: {
              orgId: effectiveOrgId,
              maxAllowed: maxKeysForOrg,
            },
          },
          { status: 409, headers: corsHeaders }
        );
      }

      // Integrity constraint check
      if (insertError.message.includes('api_keys_manage_only_org_check')) {
        return NextResponse.json(
          {
            error: 'Bad Request',
            code: 'INVALID_KEY_CONFIG',
            message: 'Violación de integridad: Solo las llaves de organización (user_id nulo) pueden gestionar llaves.',
          },
          { status: 400, headers: corsHeaders }
        );
      }

      return NextResponse.json(
        { error: 'Database Error', message: insertError.message },
        { status: 500, headers: corsHeaders }
      );
    }

    // 11. Condition 8: Audit in service_logs (without logging raw key or full hash)
    await addServiceLog({
      action: 'API_KEY_CREATED',
      status: 'ALLOWED',
      method: 'POST',
      orgId: effectiveOrgId,
      userId: cleanUserId || undefined,
      message: `API Key creada exitosamente: id=${insertedKey.id}, name='${insertedKey.name}', can_manage_keys=${insertedKey.can_manage_keys}, scope=${cleanUserId ? 'user_bound' : 'organization_backend'}. Creador: ${authResult.auth.type === 'admin' ? 'admin' : `key:${authResult.auth.callerKey.id}`}.`,
    });

    // 12. Return credentials once (Zero-Knowledge)
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
 * PATCH /api/keys
 * Allows platform admin (x-admin-secret) to update an existing key's attributes or promote it to can_manage_keys=true.
 * Condition 4: Con x-admin-secret se puede fijar canManageKeys explícitamente y convertir una existente (UPDATE controlado).
 */
export async function PATCH(req: NextRequest) {
  const authResult = await resolveCallerAuth(req);
  if (!authResult.success) return authResult.response;

  // Modifying key permissions and roles is strictly reserved for platform admins
  if (authResult.auth.type !== 'admin') {
    return NextResponse.json(
      {
        error: 'Forbidden',
        code: 'ADMIN_ONLY_OPERATION',
        message: 'Solo el administrador con x-admin-secret puede modificar privilegios o promover llaves existentes.',
      },
      { status: 403, headers: corsHeaders }
    );
  }

  try {
    const body = await req.json().catch(() => ({}));
    const keyId = (body.id || body.keyId || body.apiKeyId)?.trim();

    if (!keyId || !UUID_REGEX.test(keyId)) {
      return NextResponse.json(
        { error: 'Bad Request', code: 'INVALID_KEY_ID', message: 'El campo id (o keyId) debe ser un UUID v4 válido.' },
        { status: 400, headers: corsHeaders }
      );
    }

    const { data: existingKey, error: fetchError } = await supabase
      .from('api_keys')
      .select('id, org_id, user_id, name, can_read, can_upload, can_delete, can_manage_keys, is_active')
      .eq('id', keyId)
      .maybeSingle();

    if (fetchError || !existingKey) {
      return NextResponse.json(
        { error: 'Not Found', code: 'API_KEY_NOT_FOUND', message: 'API Key no encontrada.' },
        { status: 404, headers: corsHeaders }
      );
    }

    const updatePayload: Record<string, any> = {};

    if (typeof body.name === 'string' && body.name.trim().length >= 2) {
      updatePayload.name = body.name.trim();
    }

    const newManage = body.canManageKeys !== undefined ? body.canManageKeys : body.can_manage_keys;
    if (newManage !== undefined) {
      const boolManage = Boolean(newManage);
      if (boolManage && existingKey.user_id !== null) {
        return NextResponse.json(
          {
            error: 'Bad Request',
            code: 'INVALID_KEY_CONVERSION',
            message: 'Una llave vinculada a un usuario específico no puede convertirse en administradora de llaves (can_manage_keys=true).',
          },
          { status: 400, headers: corsHeaders }
        );
      }
      updatePayload.can_manage_keys = boolManage;
    }

    if (body.canRead !== undefined || body.can_read !== undefined) {
      updatePayload.can_read = Boolean(body.canRead !== undefined ? body.canRead : body.can_read);
    }
    if (body.canUpload !== undefined || body.can_upload !== undefined) {
      updatePayload.can_upload = Boolean(body.canUpload !== undefined ? body.canUpload : body.can_upload);
    }
    if (body.canDelete !== undefined || body.can_delete !== undefined) {
      updatePayload.can_delete = Boolean(body.canDelete !== undefined ? body.canDelete : body.can_delete);
    }

    if (Object.keys(updatePayload).length === 0) {
      return NextResponse.json(
        { error: 'Bad Request', code: 'NO_CHANGES_PROVIDED', message: 'No se proporcionaron campos válidos para actualizar.' },
        { status: 400, headers: corsHeaders }
      );
    }

    const { data: updatedKey, error: updateError } = await supabase
      .from('api_keys')
      .update(updatePayload)
      .eq('id', keyId)
      .select('id, org_id, user_id, name, can_read, can_upload, can_delete, can_manage_keys, is_active, created_at')
      .single();

    if (updateError) {
      return NextResponse.json(
        { error: 'Database Error', message: updateError.message },
        { status: 500, headers: corsHeaders }
      );
    }

    await addServiceLog({
      action: 'API_KEY_UPDATED',
      status: 'ALLOWED',
      method: 'PATCH',
      orgId: existingKey.org_id,
      message: `API Key actualizada id=${keyId}. Atributos modificados: ${Object.keys(updatePayload).join(', ')}.`,
    });

    return NextResponse.json(
      {
        status: 'updated',
        message: 'API Key actualizada exitosamente.',
        key: updatedKey,
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
 * DELETE /api/keys?id=<uuid>&mode=delete|revoke
 * Revokes (is_active=false) or permanently deletes an API Key.
 *
 * Rules:
 * - Admin (x-admin-secret): Can revoke or delete any key.
 * - Delegated key:
 *   - Only within its own org.
 *   - Condition 5: Cannot delete itself (CANNOT_DELETE_SELF).
 *   - Condition 5: Cannot delete the last key with can_manage_keys=true without x-admin-secret (CANNOT_DELETE_LAST_MANAGE_KEY).
 * - Condition 8: Audited in service_logs.
 */
export async function DELETE(req: NextRequest) {
  const authResult = await resolveCallerAuth(req);
  if (!authResult.success) return authResult.response;

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

    // 1. Fetch target key
    const { data: targetKey, error: fetchError } = await supabase
      .from('api_keys')
      .select('id, org_id, user_id, name, can_manage_keys, is_active')
      .eq('id', keyId)
      .maybeSingle();

    if (fetchError || !targetKey) {
      return NextResponse.json(
        { error: 'Not Found', code: 'API_KEY_NOT_FOUND', message: 'API Key no encontrada.' },
        { status: 404, headers: corsHeaders }
      );
    }

    // 2. Security checks for delegated callers
    if (authResult.auth.type === 'delegated') {
      const caller = authResult.auth.callerKey;

      // Multi-tenant isolation: hide keys from other organizations
      if (targetKey.org_id !== caller.org_id) {
        return NextResponse.json(
          { error: 'Not Found', code: 'API_KEY_NOT_FOUND', message: 'API Key no encontrada.' },
          { status: 404, headers: corsHeaders }
        );
      }

      // Condition 5: A key cannot delete itself
      if (targetKey.id === caller.id) {
        return NextResponse.json(
          {
            error: 'Forbidden',
            code: 'CANNOT_DELETE_SELF',
            message: 'Una API Key no puede eliminarse ni revocarse a sí misma. Utiliza otra llave administradora o solicita al administrador con x-admin-secret.',
          },
          { status: 403, headers: corsHeaders }
        );
      }

      // Condition 5: If it is the last key with can_manage_keys of the organization, deleting requires x-admin-secret
      if (targetKey.can_manage_keys && targetKey.is_active) {
        const { count: manageKeyCount, error: countErr } = await supabase
          .from('api_keys')
          .select('id', { count: 'exact', head: true })
          .eq('org_id', caller.org_id)
          .eq('can_manage_keys', true)
          .eq('is_active', true);

        if (!countErr && (manageKeyCount ?? 0) <= 1) {
          return NextResponse.json(
            {
              error: 'Forbidden',
              code: 'CANNOT_DELETE_LAST_MANAGE_KEY',
              message: 'No es posible revocar o eliminar la última API Key con permisos de administración (can_manage_keys=true) de la organización sin x-admin-secret.',
            },
            { status: 403, headers: corsHeaders }
          );
        }
      }
    }

    // 3. Revoke or Delete
    const callerDescription = authResult.auth.type === 'admin' ? 'admin' : `key:${authResult.auth.callerKey.id}`;

    if (mode === 'revoke') {
      const { data, error } = await supabase
        .from('api_keys')
        .update({ is_active: false })
        .eq('id', keyId)
        .select('id, org_id, user_id, name, can_manage_keys, is_active')
        .maybeSingle();

      if (error) {
        return NextResponse.json({ error: 'Database Error', message: error.message }, { status: 500, headers: corsHeaders });
      }

      // Condition 8: Audit revocation
      await addServiceLog({
        action: 'API_KEY_REVOKED',
        status: 'ALLOWED',
        method: 'DELETE',
        orgId: targetKey.org_id,
        message: `API Key revocada (is_active=false): id=${targetKey.id}, name='${targetKey.name}'. Actor: ${callerDescription}.`,
      });

      return NextResponse.json(
        { status: 'revoked', message: 'API Key desactivada exitosamente.', key: data },
        { status: 200, headers: corsHeaders }
      );
    }

    const { data, error } = await supabase
      .from('api_keys')
      .delete()
      .eq('id', keyId)
      .select('id, org_id, user_id, name, can_manage_keys')
      .maybeSingle();

    if (error) {
      return NextResponse.json({ error: 'Database Error', message: error.message }, { status: 500, headers: corsHeaders });
    }

    // Condition 8: Audit deletion
    await addServiceLog({
      action: 'API_KEY_DELETED',
      status: 'ALLOWED',
      method: 'DELETE',
      orgId: targetKey.org_id,
      message: `API Key eliminada permanentemente: id=${targetKey.id}, name='${targetKey.name}'. Actor: ${callerDescription}.`,
    });

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
