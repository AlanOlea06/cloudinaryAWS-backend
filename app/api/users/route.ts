import { corsHeaders, handleCorsOptions } from '@/lib/cors';
import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { supabase } from '@/lib/supabase';
import { verifyAdminSecretHeader } from '@/lib/env';
import {
  deriveOrgScopedUserUuid,
  isValidExternalUserId,
  buildAutoProvisionedUserMetadata,
} from '@/lib/user-namespace';

export async function OPTIONS() {
  return handleCorsOptions();
}

export async function GET(req: NextRequest) {
  const adminCheck = verifyAdminSecretHeader(req.headers);
  const validatedOrgId = (req.headers.get('x-validated-org-id') || '').trim();

  if (!adminCheck.valid && !validatedOrgId) {
    return NextResponse.json(
      {
        error: 'Unauthorized',
        code: 'AUTHENTICATION_REQUIRED',
        message: 'Se requiere x-api-key de tu organización o x-admin-secret.',
      },
      { status: 401, headers: corsHeaders }
    );
  }

  try {
    const { searchParams } = new URL(req.url);
    const requestedOrgId = searchParams.get('orgId')?.trim();

    // Si es una llamada con x-api-key, aislar estrictamente a su propia organización
    if (!adminCheck.valid) {
      if (requestedOrgId && requestedOrgId !== validatedOrgId) {
        return NextResponse.json(
          {
            error: 'Forbidden',
            code: 'FORBIDDEN_CROSS_ORG',
            message: 'Aislamiento Multi-Tenant: Solo puedes listar los usuarios de tu propia organización.',
          },
          { status: 403, headers: corsHeaders }
        );
      }

      const { data: users, error: userError } = await supabase
        .from('users')
        .select('id, org_id, name, role, can_upload, created_at')
        .eq('org_id', validatedOrgId)
        .order('created_at', { ascending: false });

      if (userError) {
        return NextResponse.json(
          { error: 'Error al consultar users', details: userError.message },
          { status: 500, headers: corsHeaders }
        );
      }

      return NextResponse.json(
        {
          status: 'success',
          orgId: validatedOrgId,
          usersCount: users?.length || 0,
          users: users || [],
        },
        { status: 200, headers: corsHeaders }
      );
    }

    // Modo Admin: devuelve organizaciones y usuarios (filtrables por orgId)
    const { data: orgs, error: orgError } = await supabase
      .from('organizations')
      .select('id, name, slug, description, max_storage_bytes, max_pending_tickets, max_api_keys, created_at')
      .order('slug', { ascending: true });

    if (orgError) {
      return NextResponse.json(
        { error: 'Error al consultar organizations', details: orgError.message },
        { status: 500, headers: corsHeaders }
      );
    }

    let userQuery = supabase
      .from('users')
      .select('id, org_id, name, email, role, can_upload, created_at')
      .order('name', { ascending: true });

    if (requestedOrgId) {
      userQuery = userQuery.eq('org_id', requestedOrgId);
    }

    const { data: users, error: userError } = await userQuery;

    if (userError) {
      return NextResponse.json(
        { error: 'Error al consultar users', details: userError.message },
        { status: 500, headers: corsHeaders }
      );
    }

    return NextResponse.json(
      {
        organizationsCount: orgs?.length || 0,
        organizations: orgs || [],
        usersCount: users?.length || 0,
        users: users || [],
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
 * POST /api/users
 * Registra o resuelve un usuario dentro de la organización autenticada mediante UUID derivado por organización:
 *   internalUserId = UUID_SHA256(org_id + ":" + externalUserId)
 * Garantiza que dos organizaciones jamás colisionen aunque usen el mismo ID ("1", "2", o un UUID).
 */
export async function POST(req: NextRequest) {
  const adminCheck = verifyAdminSecretHeader(req.headers);
  const validatedOrgId = (req.headers.get('x-validated-org-id') || '').trim();

  if (!adminCheck.valid && !validatedOrgId) {
    return NextResponse.json(
      {
        error: 'Unauthorized',
        code: 'AUTHENTICATION_REQUIRED',
        message: 'Se requiere x-api-key de tu organización.',
      },
      { status: 401, headers: corsHeaders }
    );
  }

  try {
    const body = await req.json().catch(() => ({}));
    const targetOrgId = adminCheck.valid
      ? String(body?.orgId || validatedOrgId || '').trim()
      : validatedOrgId;

    if (!targetOrgId) {
      return NextResponse.json(
        { error: 'Bad Request', code: 'MISSING_ORG_ID', message: 'Se requiere orgId.' },
        { status: 400, headers: corsHeaders }
      );
    }

    const rawExternalId = String(
      body?.externalUserId ?? body?.userId ?? body?.id ?? crypto.randomUUID()
    ).trim();

    if (!isValidExternalUserId(rawExternalId)) {
      return NextResponse.json(
        {
          error: 'Bad Request',
          code: 'INVALID_USER_ID',
          message: 'El identificador externalUserId / userId debe tener entre 1 y 128 caracteres válidos.',
        },
        { status: 400, headers: corsHeaders }
      );
    }

    const derivedUuid = await deriveOrgScopedUserUuid(targetOrgId, rawExternalId);

    // Verificar si ya existe en la organización
    const { data: existingUser } = await supabase
      .from('users')
      .select('id, org_id, name, role, can_upload, created_at')
      .eq('id', derivedUuid)
      .eq('org_id', targetOrgId)
      .maybeSingle();

    if (existingUser) {
      return NextResponse.json(
        {
          status: 'ok',
          alreadyExisted: true,
          externalUserId: rawExternalId,
          internalUserId: existingUser.id,
          user: existingUser,
        },
        { status: 200, headers: corsHeaders }
      );
    }

    const defaultMeta = buildAutoProvisionedUserMetadata(
      targetOrgId,
      rawExternalId,
      derivedUuid
    );

    const customName = body?.name ? String(body.name).trim().slice(0, 80) : defaultMeta.name;
    const canUpload = body?.canUpload !== undefined ? Boolean(body.canUpload) : true;

    const rawRole = String(body?.role || 'editor').toLowerCase().trim();
    const validRole =
      rawRole === 'admin'
        ? 'admin'
        : rawRole === 'viewer' || rawRole === 'readonly'
        ? 'viewer'
        : 'editor';

    const { data: createdUser, error: insertErr } = await supabase
      .from('users')
      .insert({
        id: derivedUuid,
        org_id: targetOrgId,
        name: customName,
        email: defaultMeta.email,
        role: validRole,
        can_upload: canUpload,
      })
      .select('id, org_id, name, role, can_upload, created_at')
      .single();

    if (insertErr) {
      return NextResponse.json(
        { error: 'Database Error', code: 'USER_CREATE_FAILED', message: insertErr.message },
        { status: 500, headers: corsHeaders }
      );
    }

    return NextResponse.json(
      {
        status: 'created',
        alreadyExisted: false,
        externalUserId: rawExternalId,
        internalUserId: createdUser.id,
        message:
          'Usuario registrado en tu organización. Puedes enviar tanto externalUserId como internalUserId en la cabecera x-user-id.',
        user: createdUser,
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
