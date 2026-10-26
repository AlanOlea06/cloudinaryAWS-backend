// ============================================================================
// [TEMPORARY-LAMBDA-FALLBACK: TASK-B7-WEBHOOK-RECEIVER-AND-CONFIG]
// Búsqueda rápida: "TEMPORARY-LAMBDA-FALLBACK"
// Endpoint receptor de prueba y configurador de Webhooks firmados con HMAC-SHA256.
// ============================================================================

import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { verifyWebhookSignature } from '@/lib/lambda-fallback/webhook-dispatcher';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, PUT, OPTIONS',
  'Access-Control-Allow-Headers':
    'Content-Type, x-webhook-signature, x-webhook-timestamp, x-webhook-event, x-webhook-attempt',
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

/**
 * POST /api/webhooks/test-receiver
 * Validates HMAC-SHA256 signature on incoming webhook notifications.
 * Supports `?simulateFail=true` to force HTTP 500 and verify the 3-attempt retry logic.
 */
export async function POST(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const simulateFail = searchParams.get('simulateFail') === 'true';
  const customSecret = searchParams.get('secret') || undefined;

  const signature = req.headers.get('x-webhook-signature') || '';
  const timestamp = req.headers.get('x-webhook-timestamp') || '';
  const eventType = req.headers.get('x-webhook-event') || '';
  const attempt = req.headers.get('x-webhook-attempt') || '1';

  const rawBody = await req.text();

  if (simulateFail) {
    return NextResponse.json(
      {
        received: false,
        simulatedFailure: true,
        attempt: Number(attempt),
        message: `Fallo simulado en el receptor de Webhook (intento ${attempt}).`,
      },
      { status: 500, headers: corsHeaders }
    );
  }

  const isValidSignature = verifyWebhookSignature(rawBody, timestamp, signature, customSecret);
  if (!isValidSignature) {
    return NextResponse.json(
      {
        received: false,
        hmacVerified: false,
        error: 'INVALID_WEBHOOK_SIGNATURE',
        message: 'La firma HMAC-SHA256 del Webhook es inválida o no coincide.',
      },
      { status: 401, headers: corsHeaders }
    );
  }

  let parsedBody: any = null;
  try {
    parsedBody = JSON.parse(rawBody);
  } catch {
    parsedBody = rawBody;
  }

  return NextResponse.json(
    {
      received: true,
      hmacVerified: true,
      event: eventType,
      attempt: Number(attempt),
      timestamp,
      payload: parsedBody,
    },
    { status: 200, headers: corsHeaders }
  );
}

/**
 * PUT /api/webhooks/test-receiver
 * Updates an organization's webhook_url and webhook_secret in public.organizations.
 */
export async function PUT(req: NextRequest) {
  try {
    const body = await req.json();
    const { orgId, webhookUrl = null, webhookSecret = null } = body;

    if (!orgId) {
      return NextResponse.json(
        { error: 'Bad Request', code: 'MISSING_ORG_ID', message: 'Se requiere orgId.' },
        { status: 400, headers: corsHeaders }
      );
    }

    const { data, error } = await supabase
      .from('organizations')
      .update({
        webhook_url: webhookUrl,
        webhook_secret: webhookSecret,
      })
      .eq('id', orgId)
      .select('id, name, slug, webhook_url')
      .maybeSingle();

    if (error) {
      return NextResponse.json(
        { error: 'Database Error', message: error.message },
        { status: 500, headers: corsHeaders }
      );
    }

    return NextResponse.json(
      {
        status: 'success',
        organization: data,
        webhookSecretConfigured: Boolean(webhookSecret),
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
