import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { verifyAdminSecretHeader } from '@/lib/env';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-admin-secret',
  'X-Content-Type-Options': 'nosniff',
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

export async function GET(req: NextRequest) {
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

  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get('orgId');

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

    if (orgId) {
      userQuery = userQuery.eq('org_id', orgId);
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
