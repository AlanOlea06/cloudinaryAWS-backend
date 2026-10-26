import { NextRequest, NextResponse } from 'next/server';
import {
  getServiceLogs,
  clearServiceLogs,
  enforceIpAddressRetention,
} from '@/lib/service-logs';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key',
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const filterAction = searchParams.get('action')?.trim().toUpperCase();
  const filterFileId = searchParams.get('fileId')?.trim();

  let logs = await getServiceLogs();
  if (filterAction) {
    logs = logs.filter((l) => String(l.action || '').toUpperCase() === filterAction);
  }
  if (filterFileId) {
    logs = logs.filter((l) => l.fileId === filterFileId);
  }

  const actionCounts: Record<string, number> = {};
  for (const l of logs) {
    const act = l.action || 'UNKNOWN';
    actionCounts[act] = (actionCounts[act] || 0) + 1;
  }

  return NextResponse.json(
    {
      logs,
      count: logs.length,
      actionCounts,
      ipRetentionPolicy: {
        defaultRetentionDays: 30,
        mechanism: 'Sets ip_address = NULL in public.service_logs after retention window via Cron or PATCH /api/logs',
      },
    },
    { status: 200, headers: corsHeaders }
  );
}

/**
 * PATCH /api/logs (or POST /api/logs)
 * Task B.11: Executes the IP address retention policy (`ip_address = NULL` on logs older than retention window).
 */
export async function PATCH(req: NextRequest) {
  return handleIpRetention(req);
}

export async function POST(req: NextRequest) {
  return handleIpRetention(req);
}

async function handleIpRetention(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  let body: any = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const retentionDays =
    body.retentionDays !== undefined
      ? Number(body.retentionDays)
      : searchParams.get('retentionDays') !== null
      ? Number(searchParams.get('retentionDays'))
      : 30;

  const retentionMinutes =
    body.retentionMinutes !== undefined
      ? Number(body.retentionMinutes)
      : searchParams.get('retentionMinutes') !== null
      ? Number(searchParams.get('retentionMinutes'))
      : undefined;

  const logId = body.logId ?? searchParams.get('logId') ?? undefined;

  const result = await enforceIpAddressRetention({
    retentionDays,
    retentionMinutes,
    logId,
  });

  return NextResponse.json(
    {
      status: 'success',
      policy: 'ip_address_retention_anonymization',
      ...result,
    },
    { status: 200, headers: corsHeaders }
  );
}

export async function DELETE() {
  await clearServiceLogs();
  return NextResponse.json(
    { message: 'Service logs cleared successfully' },
    { status: 200, headers: corsHeaders }
  );
}
