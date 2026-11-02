import { corsHeaders, handleCorsOptions } from '@/lib/cors';
import { NextResponse } from 'next/server';

export async function OPTIONS() {
  return handleCorsOptions();
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
