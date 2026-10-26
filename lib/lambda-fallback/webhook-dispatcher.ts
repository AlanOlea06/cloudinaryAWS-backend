// ============================================================================
// [TEMPORARY-LAMBDA-FALLBACK: TASK-B7-WEBHOOK]
// UBICACIÓN RÁPIDA PARA MIGRACIÓN O ELIMINACIÓN CUANDO EXISTA AWS LAMBDA:
// Búsqueda rápida en el proyecto: "TEMPORARY-LAMBDA-FALLBACK"
// Este módulo envía notificaciones Webhook firmadas con HMAC-SHA256 (hasta 3
// reintentos) cuando processUpload(fileId) completa o falla el procesamiento.
// Nota (Sección 2): Sin secretos por defecto ni reutilización de TICKET_SIGNING_SECRET.
// ============================================================================

import crypto from 'crypto';
import { addServiceLog } from '@/lib/service-logs';
import { supabase } from '@/lib/supabase';

export interface WebhookPayload {
  event: 'file.processed' | 'file.failed';
  timestamp: string;
  fileId: string;
  ticketId: string | null;
  orgId: string | null;
  userId: string | null;
  status: 'processed' | 'failed';
  scanStatus: string;
  visibility: 'private' | 'public';
  mimeType: string;
  sizeBytes: number;
  sha256Hash: string | null;
  cloudfrontUrl: string | null;
  errorMessage: string | null;
}

export interface WebhookDispatchResult {
  configured: boolean;
  delivered: boolean;
  attempts: number;
  lastStatusCode: number | null;
  signature: string | null;
  timestamp: string | null;
  error: string | null;
}

/**
 * Generates an HMAC-SHA256 signature over `${timestamp}.${payloadJson}` using the organization's explicit webhook_secret.
 * Throws if secret is missing or empty (no fallback secret).
 */
export function signWebhookPayload(
  payloadJson: string,
  timestamp: string,
  secret: string
): string {
  const effectiveSecret = (secret || '').trim();
  if (!effectiveSecret) {
    throw new Error(
      '[WEBHOOK_SECRET_MISSING] Se requiere un webhook_secret explícito de la organización para firmar el webhook (no existen valores por defecto).'
    );
  }
  const digest = crypto
    .createHmac('sha256', effectiveSecret)
    .update(`${timestamp}.${payloadJson}`)
    .digest('hex');
  return `sha256=${digest}`;
}

/**
 * Verifies an incoming HMAC-SHA256 webhook signature using constant-time comparison.
 * Requires an explicit secret (returns false if secret is empty).
 */
export function verifyWebhookSignature(
  payloadJson: string,
  timestamp: string,
  signatureHeader: string,
  secret: string
): boolean {
  const effectiveSecret = (secret || '').trim();
  if (!payloadJson || !timestamp || !signatureHeader || !effectiveSecret) {
    return false;
  }
  const expected = signWebhookPayload(payloadJson, timestamp, effectiveSecret);
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signatureHeader.trim(), 'utf8');
  if (a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

/**
 * Task B.7: Dispatches an HMAC-SHA256 signed webhook with up to 3 attempts.
 * Logs WEBHOOK_SENT on 2xx response, or WEBHOOK_FAILED in service_logs if all 3 attempts fail.
 */
export async function dispatchFileWebhook(params: {
  payload: WebhookPayload;
  overrideWebhookUrl?: string | null;
  overrideWebhookSecret?: string | null;
  ipAddress?: string;
}): Promise<WebhookDispatchResult> {
  const { payload, overrideWebhookUrl, overrideWebhookSecret, ipAddress = '127.0.0.1' } = params;

  let webhookUrl = overrideWebhookUrl ? overrideWebhookUrl.trim() : '';
  let webhookSecret = overrideWebhookSecret ? overrideWebhookSecret.trim() : '';

  if ((!webhookUrl || !webhookSecret) && payload.orgId) {
    const { data: orgData } = await supabase
      .from('organizations')
      .select('webhook_url, webhook_secret')
      .eq('id', payload.orgId)
      .maybeSingle();

    if (!webhookUrl && orgData?.webhook_url) {
      webhookUrl = String(orgData.webhook_url).trim();
    }
    if (!webhookSecret && orgData?.webhook_secret) {
      webhookSecret = String(orgData.webhook_secret).trim();
    }
  }

  if (!webhookUrl) {
    return {
      configured: false,
      delivered: false,
      attempts: 0,
      lastStatusCode: null,
      signature: null,
      timestamp: null,
      error: null,
    };
  }

  if (!webhookSecret) {
    await addServiceLog({
      method: 'POST',
      action: 'WEBHOOK_SKIPPED_NO_SECRET',
      status: 'BLOCKED',
      userId: payload.userId || undefined,
      orgId: payload.orgId || undefined,
      ticketId: payload.ticketId || undefined,
      fileId: payload.fileId,
      ipAddress,
      message: `Webhook omitido hacia '${webhookUrl}': la organización no tiene un webhook_secret configurado (no se permiten secretos por defecto).`,
    });

    return {
      configured: false,
      delivered: false,
      attempts: 0,
      lastStatusCode: null,
      signature: null,
      timestamp: null,
      error: 'WEBHOOK_SECRET_NOT_CONFIGURED',
    };
  }

  const timestamp = payload.timestamp || new Date().toISOString();
  const payloadJson = JSON.stringify(payload);
  const signature = signWebhookPayload(payloadJson, timestamp, webhookSecret);

  const MAX_ATTEMPTS = 3;
  let lastStatusCode: number | null = null;
  let lastError: string | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-webhook-signature': signature,
          'x-webhook-timestamp': timestamp,
          'x-webhook-event': payload.event,
          'x-webhook-attempt': String(attempt),
        },
        body: payloadJson,
        redirect: 'manual',
        signal: controller.signal,
      });

      clearTimeout(timeout);
      lastStatusCode = response.status;

      if (response.ok) {
        await addServiceLog({
          method: 'POST',
          action: 'WEBHOOK_SENT',
          status: 'DELIVERED',
          userId: payload.userId || undefined,
          orgId: payload.orgId || undefined,
          ticketId: payload.ticketId || undefined,
          fileId: payload.fileId,
          ipAddress,
          message: `Webhook '${payload.event}' entregado exitosamente a '${webhookUrl}' en el intento ${attempt}/${MAX_ATTEMPTS} (HTTP ${response.status}, firma HMAC-SHA256).`,
        });

        return {
          configured: true,
          delivered: true,
          attempts: attempt,
          lastStatusCode: response.status,
          signature,
          timestamp,
          error: null,
        };
      }

      lastError = `HTTP ${response.status} ${response.statusText}`;
    } catch (err: any) {
      lastError = err?.message || 'Network or timeout error';
    }

    if (attempt < MAX_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, attempt * 250));
    }
  }

  await addServiceLog({
    method: 'POST',
    action: 'WEBHOOK_FAILED',
    status: 'FAILED_AFTER_3_RETRIES',
    userId: payload.userId || undefined,
    orgId: payload.orgId || undefined,
    ticketId: payload.ticketId || undefined,
    fileId: payload.fileId,
    ipAddress,
    message: `Fallo definitivo de Webhook '${payload.event}' hacia '${webhookUrl}' tras ${MAX_ATTEMPTS} intentos. Último error: ${lastError}.`,
  });

  return {
    configured: true,
    delivered: false,
    attempts: MAX_ATTEMPTS,
    lastStatusCode,
    signature,
    timestamp,
    error: lastError,
  };
}
