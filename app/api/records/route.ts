import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

const corsHeaders = {
  'Access-Control-Allow-Origin': 'http://localhost:3000',
  'Access-Control-Allow-Methods': 'GET, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

export async function GET() {
  try {
    // Intentar consulta relacional pura con JOIN automático de Supabase (usuarios y organizaciones)
    let { data, error } = await supabase
      .from('archivos')
      .select('*, usuarios(nombre, email, rol), organizaciones(nombre, slug)')
      .order('created_at', { ascending: false })
      .limit(50);

    // Fallback a select simple si las llaves foráneas aún no se han aplicado en Supabase
    if (error) {
      const fallback = await supabase
        .from('archivos')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(50);

      data = fallback.data;
      error = fallback.error;
    }

    if (error) {
      return NextResponse.json({ error: error.message, records: [] }, { status: 500, headers: corsHeaders });
    }

    // Aplanar campos relacionales para conveniencia del cliente frontend/postman
    const formattedRecords = (data || []).map((row: any) => ({
      ...row,
      user_name: row.usuarios?.nombre || row.user_name || 'Desconocido',
      user_email: row.usuarios?.email || null,
      org_name: row.organizaciones?.nombre || null,
      org_slug: row.organizaciones?.slug || null,
    }));

    return NextResponse.json(
      { records: formattedRecords, count: formattedRecords.length },
      { status: 200, headers: corsHeaders }
    );
  } catch (err: any) {
    return NextResponse.json({ error: err.message, records: [] }, { status: 500, headers: corsHeaders });
  }
}

export async function DELETE() {
  try {
    const { error } = await supabase
      .from('archivos')
      .delete()
      .neq('id', '00000000-0000-0000-0000-000000000000');

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500, headers: corsHeaders });
    }

    return NextResponse.json({ message: 'Registros de archivos limpiados en Supabase' }, { status: 200, headers: corsHeaders });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500, headers: corsHeaders });
  }
}
