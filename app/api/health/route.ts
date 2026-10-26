import { NextResponse } from 'next/server';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'X-Content-Type-Options': 'nosniff',
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

export async function HEAD() {
  return new NextResponse(null, { status: 200, headers: corsHeaders });
}

/**
 * GET /api/health
 * Public healthcheck endpoint. Exposes zero sensitive data (no bucket names, no secrets, no internal URLs).
 */
export async function GET() {
  return NextResponse.json(
    {
      status: 'ok',
      service: 'cloudinary-aws-backend',
      timestamp: new Date().toISOString(),
    },
    { status: 200, headers: corsHeaders }
  );
}
