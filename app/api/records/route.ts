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
    // 1. Query standardized English table: files
    let { data, error } = await supabase
      .from('files')
      .select('*, users(name, email, role), organizations(name, slug)')
      .order('created_at', { ascending: false })
      .limit(50);

    // 2. If relational query on files failed, try simple files query
    if (error) {
      const simpleFiles = await supabase
        .from('files')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(50);

      if (!simpleFiles.error && simpleFiles.data) {
        data = simpleFiles.data;
        error = null;
      }
    }

    if (error) {
      return NextResponse.json({ error: error.message, records: [] }, { status: 500, headers: corsHeaders });
    }

    // Format output with unified English fields
    const formattedRecords = (data || []).map((row: any) => {
      const fileName = row.original_name || 'unknown';
      const extension = row.extension || (fileName.includes('.') ? fileName.slice(fileName.lastIndexOf('.')).toLowerCase() : '');
      return {
        ...row,
        fileName,
        extension,
        mimeType: row.mime_type,
        sizeBytes: row.size_bytes,
        sha256Hash: row.sha256_hash,
        userName: row.users?.name || 'Unknown',
        userEmail: row.users?.email || null,
        orgName: row.organizations?.name || null,
        orgSlug: row.organizations?.slug || null,
      };
    });

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
    await supabase.from('files').delete().neq('id', '00000000-0000-0000-0000-000000000000');

    return NextResponse.json({ message: 'File records cleared successfully' }, { status: 200, headers: corsHeaders });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500, headers: corsHeaders });
  }
}
