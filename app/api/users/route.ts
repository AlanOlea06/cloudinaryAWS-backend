import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

const corsHeaders = {
  'Access-Control-Allow-Origin': 'http://localhost:3000',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

export async function GET() {
  try {
    // 1. Query users with their organization relation from Supabase
    let users: any[] = [];
    const { data: dbUsers, error: usersErr } = await supabase
      .from('users')
      .select('id, name, email, role, can_upload, org_id, organizations(id, name, slug)')
      .order('name');

    if (!usersErr && dbUsers) {
      users = dbUsers.map((u: any) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        role: u.role,
        canUpload: Boolean(u.can_upload),
        orgId: u.org_id,
        orgName: u.organizations?.name || 'Unknown Org',
        orgSlug: u.organizations?.slug || '',
      }));
    } else {
      // Fallback to legacy usuarios table if migration not completed
      const { data: dbUsuarios } = await supabase
        .from('usuarios')
        .select('id, nombre, email, rol, puede_subir, org_id, organizaciones(id, nombre, slug)')
        .order('nombre');

      if (dbUsuarios) {
        users = dbUsuarios.map((u: any) => ({
          id: u.id,
          name: u.nombre,
          email: u.email,
          role: u.rol,
          canUpload: Boolean(u.puede_subir),
          orgId: u.org_id,
          orgName: u.organizaciones?.nombre || 'Unknown Org',
          orgSlug: u.organizaciones?.slug || '',
        }));
      }
    }

    // 2. Query organizations from Supabase
    let organizations: any[] = [];
    const { data: dbOrgs, error: orgsErr } = await supabase
      .from('organizations')
      .select('id, name, slug, description')
      .order('name');

    if (!orgsErr && dbOrgs) {
      organizations = dbOrgs;
    } else {
      const { data: dbLegacyOrgs } = await supabase
        .from('organizaciones')
        .select('id, nombre, slug')
        .order('nombre');

      if (dbLegacyOrgs) {
        organizations = dbLegacyOrgs.map((o: any) => ({
          id: o.id,
          name: o.nombre,
          slug: o.slug,
        }));
      }
    }

    return NextResponse.json(
      {
        status: 'success',
        users,
        organizations,
        source: 'supabase_database_live',
        count: {
          users: users.length,
          organizations: organizations.length,
        },
      },
      { status: 200, headers: corsHeaders }
    );
  } catch (error: any) {
    return NextResponse.json(
      {
        status: 'error',
        message: error.message,
      },
      { status: 500, headers: corsHeaders }
    );
  }
}
