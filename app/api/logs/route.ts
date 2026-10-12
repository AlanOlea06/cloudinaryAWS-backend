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
  const logs = getServiceLogs();
  return NextResponse.json({ logs, count: logs.length }, { status: 200, headers: corsHeaders });
}

export async function DELETE() {
  clearServiceLogs();
  return NextResponse.json({ message: 'Logs de servicio reiniciados con éxito' }, { status: 200, headers: corsHeaders });
}
