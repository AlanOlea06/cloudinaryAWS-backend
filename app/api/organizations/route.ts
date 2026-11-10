import { corsHeaders, handleCorsOptions } from '@/lib/cors';
import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { pgClient } from '@/lib/postgres';
import { verifyAdminSecretHeader, verifyOrgInviteCode } from '@/lib/env';
import { addServiceLog } from '@/lib/service-logs';
import { validateWebhookUrlSSRF } from '@/lib/lambda-fallback/webhook-dispatcher';
import { deriveOrgScopedUserUuid } from '@/lib/user-namespace';


const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function OPTIONS() {
  return handleCorsOptions();
}

type AuthResult =
  | { type: 'admin' }
  | { type: 'delegated'; callerKey: { id: string; org_id: string; can_manage_keys: boolean } }
  | { type: 'unauthorized'; response: NextResponse };

async function resolveCallerAuth(req: NextRequest): Promise<AuthResult> {
  const adminCheck = verifyAdminSecretHeader(req.headers);
  if (adminCheck.valid) {
    return { type: 'admin' };
  }

  const rawApiKey = req.headers.get('x-api-key')?.trim();
  if (rawApiKey) {
    const keyHash = crypto.createHash('sha256').update(rawApiKey).digest('hex');
    const { data: keyRecord } = await pgClient
      .from('api_keys')
      .select('id, org_id, user_id, can_manage_keys, is_active')
      .eq('hashed_key', keyHash)
      .eq('is_active', true)
      .maybeSingle();

    if (keyRecord) {
      if (!keyRecord.can_manage_keys) {
        return {
          type: 'unauthorized',
          response: NextResponse.json(
            {
              error: 'Forbidden',
              code: 'CANNOT_MANAGE_ORGANIZATION',
              message: 'La API Key llamante no tiene permisos de administración (can_manage_keys=false).',
            },
            { status: 403, headers: corsHeaders }
          ),
        };
      }
      return {
        type: 'delegated',
        callerKey: {
          id: keyRecord.id,
          org_id: keyRecord.org_id,
          can_manage_keys: Boolean(keyRecord.can_manage_keys),
        },
      };
    }
  }

  return {
    type: 'unauthorized',
    response: NextResponse.json(
      {
        error: 'Unauthorized',
        code: 'UNAUTHORIZED',
        message: 'Credenciales inválidas. Se requiere x-admin-secret o una API Key con can_manage_keys=true.',
      },
      { status: 401, headers: corsHeaders }
    ),
  };
}

/**
 * GET /api/organizations?id=<uuid>
 * - Admin: puede consultar cualquier organización o listar todas.
 * - Llave con can_manage_keys=true: solo puede consultar su propia organización.
 */
export async function GET(req: NextRequest) {
  const auth = await resolveCallerAuth(req);
  if (auth.type === 'unauthorized') return auth.response;

  const { searchParams } = new URL(req.url);
  const requestedId = searchParams.get('id')?.trim() || searchParams.get('orgId')?.trim();

  let targetId: string | null = null;
  if (auth.type === 'admin') {
    targetId = requestedId || null;
  } else {
    if (requestedId && requestedId !== auth.callerKey.org_id) {
      return NextResponse.json(
        {
          error: 'Forbidden',
          code: 'FORBIDDEN_CROSS_ORG',
          message: 'Aislamiento Multi-Tenant: No puedes consultar los datos de otra organización.',
        },
        { status: 403, headers: corsHeaders }
      );
    }
    targetId = auth.callerKey.org_id;
  }

  let query = pgClient.from('organizations').select('id, name, slug, webhook_url, max_storage_bytes, max_pending_tickets, max_api_keys, created_at');
  if (targetId) {
    query = query.eq('id', targetId);
  }

  const { data, error } = await query;
  if (error) {
    return NextResponse.json({ error: 'Database Error', message: error.message }, { status: 500, headers: corsHeaders });
  }

  return NextResponse.json(
    {
      status: 'success',
      count: data?.length || 0,
      organizations: targetId ? data?.[0] || null : data,
    },
    { status: 200, headers: corsHeaders }
  );
}

/**
 * POST /api/organizations
 * Auto-onboarding de una nueva organización/plataforma mediante código de invitación (inviteCode / x-invite-code).
 * Crea en un solo paso:
 *  1) La organización con sus cuotas por defecto (1 GB, 20 tickets pendientes, 3 API keys).
 *  2) Un usuario inicial por defecto vinculado a la organización.
 *  3) La API Key Maestra (can_manage_keys=true) devuelta por única vez (Zero-Knowledge).
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const inviteCheck = verifyOrgInviteCode(req.headers, body?.inviteCode);

    if (!inviteCheck.valid) {
      return NextResponse.json(
        {
          error: inviteCheck.status === 401 ? 'Unauthorized' : 'Forbidden',
          code: inviteCheck.code,
          message: inviteCheck.message,
        },
        { status: inviteCheck.status, headers: corsHeaders }
      );
    }

    const rawName = String(body?.name || '').trim();
    if (rawName.length < 2 || rawName.length > 80) {
      return NextResponse.json(
        {
          error: 'Bad Request',
          code: 'INVALID_ORG_NAME',
          message: 'El campo "name" de la organización es obligatorio y debe tener entre 2 y 80 caracteres.',
        },
        { status: 400, headers: corsHeaders }
      );
    }

    const baseSlug = String(body?.slug || rawName)
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || `org-${crypto.randomBytes(3).toString('hex')}`;

    // Verify if slug already exists; if so, append a short random suffix
    let finalSlug = baseSlug;
    const { data: existingSlugOrg } = await pgClient
      .from('organizations')
      .select('id')
      .eq('slug', finalSlug)
      .maybeSingle();

    if (existingSlugOrg) {
      finalSlug = `${baseSlug}-${crypto.randomBytes(2).toString('hex')}`;
    }

    let webhookUrl: string | null = null;
    if (body?.webhookUrl !== undefined && body?.webhookUrl !== null && String(body.webhookUrl).trim() !== '') {
      const candidateUrl = String(body.webhookUrl).trim();
      const ssrfCheck = await validateWebhookUrlSSRF(candidateUrl);
      if (!ssrfCheck.safe) {
        return NextResponse.json(
          {
            error: 'Bad Request',
            code: ssrfCheck.error,
            message: `La URL de webhook fue rechazada por seguridad SSRF (${ssrfCheck.error}). Solo se permiten URLs HTTPS públicas.`,
          },
          { status: 400, headers: corsHeaders }
        );
      }
      webhookUrl = candidateUrl;
    }

    const webhookSecret =
      body?.webhookSecret !== undefined && body?.webhookSecret !== null && String(body.webhookSecret).trim() !== ''
        ? String(body.webhookSecret).trim()
        : null;

    const orgId = crypto.randomUUID();
    const description = body?.description ? String(body.description).trim().slice(0, 250) : `Organización ${rawName}`;

    // 1. Insert Organization
    const { data: createdOrg, error: orgErr } = await pgClient
      .from('organizations')
      .insert({
        id: orgId,
        name: rawName,
        slug: finalSlug,
        description,
        webhook_url: webhookUrl,
        webhook_secret: webhookSecret,
        max_storage_bytes: 1073741824, // 1 GB default
        max_pending_tickets: 20,
        max_api_keys: 3,
      })
      .select('id, name, slug, description, webhook_url, max_storage_bytes, max_pending_tickets, max_api_keys, created_at')
      .single();

    if (orgErr || !createdOrg) {
      return NextResponse.json(
        { error: 'Database Error', code: 'ORG_CREATE_FAILED', message: orgErr?.message || 'Error al crear la organización.' },
        { status: 500, headers: corsHeaders }
      );
    }

    // 2. Create initial default user scoped to this organization
    const defaultExternalId = body?.defaultUserId ? String(body.defaultUserId).trim() : '1';
    const defaultUserUuid = await deriveOrgScopedUserUuid(orgId, defaultExternalId);
    const { data: createdUser } = await pgClient
      .from('users')
      .insert({
        id: defaultUserUuid,
        org_id: orgId,
        name: body?.defaultUserName ? String(body.defaultUserName).trim() : `Admin ${rawName}`,
        email: `admin-${defaultUserUuid.slice(0, 8)}@${finalSlug}.tenant.local`,
        role: 'admin',
        can_upload: true,
      })
      .select('id, org_id, name, email, role, can_upload, created_at')
      .maybeSingle();

    // 3. Create Master API Key (Zero-Knowledge)
    const rawApiKey = `sk_live_${crypto.randomBytes(32).toString('hex')}`;
    const hashedKey = crypto.createHash('sha256').update(rawApiKey).digest('hex');

    const { data: createdKey, error: keyErr } = await pgClient
      .from('api_keys')
      .insert({
        id: crypto.randomUUID(),
        org_id: orgId,
        user_id: null,
        name: `Master Key - ${rawName}`,
        hashed_key: hashedKey,
        can_read: true,
        can_upload: true,
        can_delete: true,
        can_manage_keys: true,
        is_active: true,
      })
      .select('id, org_id, user_id, name, can_read, can_upload, can_delete, can_manage_keys, is_active, created_at')
      .single();

    if (keyErr || !createdKey) {
      return NextResponse.json(
        { error: 'Database Error', code: 'MASTER_KEY_CREATE_FAILED', message: keyErr?.message || 'Error al generar la API Key maestra.' },
        { status: 500, headers: corsHeaders }
      );
    }

    await addServiceLog({
      method: 'POST',
      action: 'ORGANIZATION_CREATED',
      status: 'ALLOWED',
      orgId: orgId,
      userId: defaultUserUuid,
      ipAddress: req.headers.get('x-forwarded-for') || '127.0.0.1',
      message: `Nueva organización registrada automáticamente: '${rawName}' (slug='${finalSlug}', id=${orgId}) con su API Key Maestra.`,
    });

    return NextResponse.json(
      {
        status: 'created',
        message:
          'IMPORTANTE: Guarda tu apiKey en tu servidor en un lugar seguro. Por seguridad (Zero-Knowledge), nunca volverá a mostrarse. Para subir archivos puedes enviar cualquier ID de usuario de tu plataforma en la cabecera x-user-id (ej. "1", "user_42" o un UUID) y se registrará automáticamente en tu organización sin colisionar con otras.',
        apiKey: rawApiKey,
        organization: createdOrg,
        defaultUser: {
          ...createdUser,
          externalUserId: defaultExternalId,
        },
        keyMetadata: createdKey,
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
 * PATCH /api/organizations
 * Body: { id?: string, webhookUrl?: string | null, webhookSecret?: string | null, maxStorageBytes?: number, maxPendingTickets?: number, maxApiKeys?: number, name?: string }
 * - Admin: puede actualizar cualquier campo de cualquier organización.
 * - Llave con can_manage_keys=true: solo puede actualizar webhookUrl y webhookSecret de SU organización.
 */
export async function PATCH(req: NextRequest) {
  const auth = await resolveCallerAuth(req);
  if (auth.type === 'unauthorized') return auth.response;

  try {
    const body = await req.json().catch(() => ({}));
    const { searchParams } = new URL(req.url);
    const requestedId = body.id?.trim() || body.orgId?.trim() || searchParams.get('id')?.trim() || searchParams.get('orgId')?.trim();

    let targetId: string;
    if (auth.type === 'admin') {
      if (!requestedId || !UUID_RE.test(requestedId)) {
        return NextResponse.json(
          { error: 'Bad Request', code: 'INVALID_ORG_ID', message: 'Se requiere id de organización válido (UUID).' },
          { status: 400, headers: corsHeaders }
        );
      }
      targetId = requestedId;
    } else {
      if (requestedId && requestedId !== auth.callerKey.org_id) {
        return NextResponse.json(
          {
            error: 'Forbidden',
            code: 'FORBIDDEN_CROSS_ORG',
            message: 'Aislamiento Multi-Tenant: No puedes modificar la configuración de otra organización.',
          },
          { status: 403, headers: corsHeaders }
        );
      }
      targetId = auth.callerKey.org_id;
    }

    const updates: Record<string, any> = {};

    // Webhook configuration (allowed for both Admin and Delegated Master Key)
    if (body.webhookUrl !== undefined || body.webhook_url !== undefined) {
      const rawUrl = body.webhookUrl !== undefined ? body.webhookUrl : body.webhook_url;
      if (rawUrl === null || rawUrl === '') {
        updates.webhook_url = null;
      } else {
        const u = String(rawUrl).trim();
        const ssrfCheck = await validateWebhookUrlSSRF(u);
        if (!ssrfCheck.safe) {
          return NextResponse.json(
            {
              error: 'Bad Request',
              code: ssrfCheck.error,
              message: `La URL de webhook fue rechazada por seguridad SSRF (${ssrfCheck.error}). Solo se permiten URLs HTTPS públicas.`,
            },
            { status: 400, headers: corsHeaders }
          );
        }
        updates.webhook_url = u;
      }
    }

    if (body.webhookSecret !== undefined || body.webhook_secret !== undefined) {
      const s = body.webhookSecret !== undefined ? body.webhookSecret : body.webhook_secret;
      updates.webhook_secret = s === null || s === '' ? null : String(s).trim();
    }

    // Quotas and metadata (ADMIN ONLY)
    if (auth.type === 'admin') {
      if (body.name !== undefined) updates.name = String(body.name).trim();
      if (body.maxStorageBytes !== undefined) updates.max_storage_bytes = Number(body.maxStorageBytes);
      if (body.max_storage_bytes !== undefined) updates.max_storage_bytes = Number(body.max_storage_bytes);
      if (body.maxPendingTickets !== undefined) updates.max_pending_tickets = Number(body.maxPendingTickets);
      if (body.max_pending_tickets !== undefined) updates.max_pending_tickets = Number(body.max_pending_tickets);
      if (body.maxApiKeys !== undefined) updates.max_api_keys = Number(body.maxApiKeys);
      if (body.max_api_keys !== undefined) updates.max_api_keys = Number(body.max_api_keys);
    } else {
      if (body.maxStorageBytes !== undefined || body.maxPendingTickets !== undefined || body.maxApiKeys !== undefined || body.name !== undefined) {
        return NextResponse.json(
          {
            error: 'Forbidden',
            code: 'FORBIDDEN_QUOTA_MODIFICATION',
            message: 'Solo el administrador de plataforma (x-admin-secret) puede modificar cuotas y nombres de organización.',
          },
          { status: 403, headers: corsHeaders }
        );
      }
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json(
        { error: 'Bad Request', code: 'NO_CHANGES_PROVIDED', message: 'No se enviaron campos válidos para actualizar.' },
        { status: 400, headers: corsHeaders }
      );
    }

    const { data: updatedOrg, error: updateErr } = await pgClient
      .from('organizations')
      .update(updates)
      .eq('id', targetId)
      .select('id, name, slug, webhook_url, max_storage_bytes, max_pending_tickets, max_api_keys')
      .single();

    if (updateErr) {
      return NextResponse.json({ error: 'Database Error', message: updateErr.message }, { status: 500, headers: corsHeaders });
    }

    await addServiceLog({
      action: 'ORGANIZATION_UPDATED',
      status: 'ALLOWED',
      method: 'PATCH',
      orgId: targetId,
      message: `Configuración de organización actualizada id=${targetId}. Campos: ${Object.keys(updates).join(', ')}.`,
    });

    return NextResponse.json(
      {
        status: 'updated',
        message: 'Organización actualizada exitosamente.',
        organization: updatedOrg,
      },
      { status: 200, headers: corsHeaders }
    );
  } catch (err: any) {
    return NextResponse.json({ error: 'Internal Error', message: err.message }, { status: 500, headers: corsHeaders });
  }
}
