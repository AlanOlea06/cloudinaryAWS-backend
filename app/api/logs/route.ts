import { NextResponse } from 'next/server';
import { getServiceLogs, clearServiceLogs } from '@/lib/service-logs';

const corsHeaders = {
  'Access-Control-Allow-Origin': 'http://localhost:3000',
  'Access-Control-Allow-Methods': 'GET, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

export async function GET() {
  const logs = await getServiceLogs();
  return NextResponse.json({ logs, count: logs.length }, { status: 200, headers: corsHeaders });
}

export async function DELETE() {
  await clearServiceLogs();
  return NextResponse.json({ message: 'Service logs cleared successfully' }, { status: 200, headers: corsHeaders });
}
