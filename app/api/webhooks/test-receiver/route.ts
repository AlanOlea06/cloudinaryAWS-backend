// ============================================================================
// [TEMPORARY-LAMBDA-FALLBACK: TASK-B11-WEBHOOK-TEST-RECEIVER]
// Búsqueda rápida: "TEMPORARY-LAMBDA-FALLBACK"
// Endpoint: POST, GET, PUT /api/webhooks/test-receiver
// Nota (Sección 2): Protegido con ADMIN_API_SECRET; PUT deshabilitado en producción;
// sin secretos por defecto.
// ============================================================================

import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { verifyWebhookSignature } from '@/lib/lambda-fallback/webhook-dispatcher';
import { verifyAdminSecretHeader } from '@/lib/env';

interface ReceivedWebhookEntry {
  receivedAt: string;
  validSignature: boolean;
  reason?: string;
  event: string | null;
  eventId: string | null;
  timestampHeader: string;
  signatureHeader: string;
  attemptHeader: string | null;
  payload: any;
}

const receivedWebhooksStore: ReceivedWebhookEntry[] =
  (globalThis as any).__antigravityReceivedWebhooks || [];
(globalThis as any).__antigravityReceivedWebhooks = receivedWebhooksStore;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
  'Access-Control-Allow-Headers':
    'Content-Type, Authorization, x-admin-secret, X-Webhook-Event, X-Webhook-Id, X-Webhook-Timestamp, X-Webhook-Signature-256, X-Webhook-Attempt, x-webhook-secret-test',
  'X-Content-Type-Options': 'nosniff',
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

function enforceAdminAuth(req: NextRequest): NextResponse | null {
  const check = verifyAdminSecretHeader(req.headers);
  if (!check.valid) {
    return NextResponse.json(
      {
        error: check.status === 401 ? 'Unauthorized' : 'Forbidden',
        code: check.code,
        message: check.message,
      },
      { status: check.status, headers: corsHeaders }
    );
  }
  return null;
}

export async function GET(req: NextRequest) {
  const authError = enforceAdminAuth(req);
  if (authError) return authError;

  return NextResponse.json(
    {
      status: 'success',
      count: receivedWebhooksStore.length,
      events: receivedWebhooksStore.slice(0, 25),
    },
    { status: 200, headers: corsHeaders }
  );
}

/**
 * PUT /api/webhooks/test-receiver
 * Disabled in production. In development, requires ADMIN_API_SECRET.
 */
export async function PUT(req: NextRequest) {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json(
      {
        error: 'Forbidden',
        code: 'ENDPOINT_DISABLED_IN_PRODUCTION',
        message: 'PUT /api/webhooks/test-receiver está deshabilitado en producción.',
      },
      { status: 403, headers: corsHeaders }
    );
  }

  const authError = enforceAdminAuth(req);
  if (authError) return authError;

  try {
    const body = await req.json();
    const { orgId, webhookUrl = null, webhookSecret = null } = body;

    if (!orgId) {
      return NextResponse.json(
        { error: 'Bad Request', code: 'MISSING_ORG_ID', message: 'El campo orgId es obligatorio.' },
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
        { error: 'Database Error', code: 'DB_UPDATE_ERROR', message: error.message },
        { status: 500, headers: corsHeaders }
      );
    }

    return NextResponse.json(
      {
        status: 'updated',
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

export async function POST(req: NextRequest) {
  try {
    const rawBody = await req.text();
    const timestampHeader = req.headers.get('x-webhook-timestamp') || '';
    const signatureHeader =
      req.headers.get('x-webhook-signature') ||
      req.headers.get('x-webhook-signature-256') ||
      '';
    const eventHeader = req.headers.get('x-webhook-event');
    const eventIdHeader = req.headers.get('x-webhook-id') || req.headers.get('x-webhook-delivery-id');
    const attemptHeader = req.headers.get('x-webhook-attempt');

    let parsedPayload: any = null;
    try {
      parsedPayload = rawBody ? JSON.parse(rawBody) : null;
    } catch {
      parsedPayload = rawBody;
    }

    let secretToVerify = req.headers.get('x-webhook-secret-test')?.trim() || '';
    const adminCheck = verifyAdminSecretHeader(req.headers);

    // If no manual secret header provided, look up the organization's webhook_secret from DB
    if (!secretToVerify && parsedPayload?.orgId) {
      const { data: org } = await supabase
        .from('organizations')
        .select('webhook_secret')
        .eq('id', parsedPayload.orgId)
        .maybeSingle();
      if (org?.webhook_secret) {
        secretToVerify = org.webhook_secret;
      }
    }

    const isValidSig =
      Boolean(secretToVerify &&
      signatureHeader &&
      timestampHeader &&
      verifyWebhookSignature(rawBody, timestampHeader, signatureHeader, secretToVerify));

    // Must either be a valid signed webhook or have valid admin credentials
    if (!isValidSig && !adminCheck.valid) {
      return NextResponse.json(
        {
          error: 'Unauthorized',
          code: 'INVALID_WEBHOOK_SIGNATURE_OR_AUTH',
          message: 'Firma HMAC-SHA256 del webhook inválida o falta autenticación administrativa.',
        },
        { status: 401, headers: corsHeaders }
      );
    }

    const entry: ReceivedWebhookEntry = {
      receivedAt: new Date().toISOString(),
      validSignature: isValidSig || adminCheck.valid,
      event: eventHeader || parsedPayload?.event || null,
      eventId: eventIdHeader || parsedPayload?.eventId || parsedPayload?.deliveryId || null,
      timestampHeader,
      signatureHeader,
      attemptHeader,
      payload: parsedPayload,
    };

    receivedWebhooksStore.unshift(entry);
    if (receivedWebhooksStore.length > 50) {
      receivedWebhooksStore.pop();
    }

    return NextResponse.json(
      {
        status: 'success',
        message: 'Webhook recibido y validado exitosamente por test-receiver.',
        validSignature: isValidSig,
        receivedEvent: entry.event,
        deliveryId: entry.eventId,
      },
      { status: 200, headers: corsHeaders }
    );
  } catch (err: any) {
    return NextResponse.json({ error: 'Internal Error', message: err.message }, { status: 500, headers: corsHeaders });
  }
}


