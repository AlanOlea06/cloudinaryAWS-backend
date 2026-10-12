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
    const { data, error } = await supabase
      .from('archivos')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) {
      return NextResponse.json({ error: error.message, records: [] }, { status: 500, headers: corsHeaders });
    }

    return NextResponse.json({ records: data || [], count: data?.length || 0 }, { status: 200, headers: corsHeaders });
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
