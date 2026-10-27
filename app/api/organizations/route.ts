import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { supabase } from '@/lib/supabase';
import { verifyAdminSecretHeader } from '@/lib/env';
import { addServiceLog } from '@/lib/service-logs';
import { validateWebhookUrlSSRF } from '@/lib/lambda-fallback/webhook-dispatcher';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PATCH, OPTIONS',
  'Access-Control-Allow-Headers':
    'Content-Type, Authorization, x-api-key, x-admin-secret, x-user-id',
  'X-Content-Type-Options': 'nosniff',
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
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
    const { data: keyRecord } = await supabase
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

  let query = supabase.from('organizations').select('id, name, slug, webhook_url, max_storage_bytes, max_pending_tickets, max_api_keys, created_at');
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

    const { data: updatedOrg, error: updateErr } = await supabase
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
