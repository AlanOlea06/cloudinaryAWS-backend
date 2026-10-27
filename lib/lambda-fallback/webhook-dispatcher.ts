// ============================================================================
// [TEMPORARY-LAMBDA-FALLBACK: WEBHOOK-DISPATCHER]
// UBICACIÓN RÁPIDA PARA MIGRACIÓN O ELIMINACIÓN CUANDO EXISTA AWS LAMBDA:
// Búsqueda rápida en el proyecto: "TEMPORARY-LAMBDA-FALLBACK"
//
// Este módulo gestiona:
// 1. Envío seguro de Webhooks con firma criptográfica HMAC-SHA256.
// 2. Protección estricta contra SSRF (Server-Side Request Forgery):
//    - Solo protocolo HTTPS.
//    - Resolución DNS previa con bloqueo de IPs privadas (RFC 1918), loopback,
//      link-local, CGNAT (RFC 6598), multicast/reservadas y metadata de AWS.
//    - Prohibición de redirecciones HTTP (redirect: 'error').
//    - Timeout corto (3.5 segundos).
// 3. Destino y Secreto tomados EXCLUSIVAMENTE de la configuración de la organización
//    (public.organizations.webhook_url y webhook_secret). Nunca de parámetros del cliente.
// 4. Persistencia en base de datos (public.webhook_deliveries) con reintentos
//    programados mediante backoff exponencial real.
// ============================================================================

import crypto from 'crypto';
import dns from 'dns';
import { supabase } from '@/lib/supabase';
import { addServiceLog } from '@/lib/service-logs';

export type WebhookEventName = 'file.uploaded' | 'file.processed' | 'file.failed';

export interface WebhookPayload {
  event: WebhookEventName;
  timestamp: string;
  fileId: string;
  ticketId: string | null;
  orgId: string | null;
  userId: string | null;
  status: 'uploaded' | 'processed' | 'failed';
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
  deliveryId?: string | null;
  attempts: number;
  lastStatusCode: number | null;
  signature: string | null;
  timestamp: string | null;
  error: string | null;
}

// ============================================================================
// 1. SSRF PROTECTION HELPERS
// ============================================================================

/**
 * Converts an IPv4 dotted string to a 32-bit unsigned integer.
 */
function ipv4ToLong(ip: string): number {
  return ip
    .split('.')
    .reduce((acc, octet) => ((acc << 8) + parseInt(octet, 10)) >>> 0, 0);
}

/**
 * Checks whether an IPv4 address falls within a given CIDR block.
 */
function isIpv4InCidr(ip: string, cidr: string): boolean {
  const [range, bitsStr] = cidr.split('/');
  const bits = parseInt(bitsStr, 10);
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  const ipLong = ipv4ToLong(ip);
  const rangeLong = ipv4ToLong(range);
  return (ipLong & mask) === (rangeLong & mask);
}

/**
 * Validates an IP address against forbidden ranges (private, loopback, link-local,
 * AWS metadata, CGNAT, multicast, broadcast).
 */
export function isIpBlocked(ip: string): boolean {
  const trimmed = ip.trim().toLowerCase();

  // IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1)
  if (trimmed.startsWith('::ffff:')) {
    const mappedIpv4 = trimmed.substring(7);
    return isIpBlocked(mappedIpv4);
  }

  // IPv4 Checks
  if (trimmed.includes('.')) {
    const forbiddenCidrs = [
      '0.0.0.0/8', // Current network (RFC 1122)
      '10.0.0.0/8', // Private network (RFC 1918)
      '100.64.0.0/10', // Carrier-Grade NAT (RFC 6598)
      '127.0.0.0/8', // Loopback (RFC 1122)
      '169.254.0.0/16', // Link-local + AWS Metadata (169.254.169.254) (RFC 3927)
      '172.16.0.0/12', // Private network (RFC 1918)
      '192.0.0.0/24', // IETF Protocol Assignments
      '192.0.2.0/24', // TEST-NET-1 (RFC 5737)
      '192.88.99.0/24', // 6to4 Relay Anycast (RFC 7526)
      '192.168.0.0/16', // Private network (RFC 1918)
      '198.18.0.0/15', // Network benchmark tests (RFC 2544)
      '198.51.100.0/24', // TEST-NET-2 (RFC 5737)
      '203.0.113.0/24', // TEST-NET-3 (RFC 5737)
      '224.0.0.0/4', // Multicast (RFC 5771)
      '240.0.0.0/4', // Reserved for future use (RFC 1112)
      '255.255.255.255/32', // Broadcast
    ];

    for (const cidr of forbiddenCidrs) {
      if (isIpv4InCidr(trimmed, cidr)) {
        return true;
      }
    }
    return false;
  }

  // IPv6 Checks
  if (trimmed.includes(':')) {
    if (trimmed === '::' || trimmed === '::1') return true; // Unspecified / Loopback
    if (trimmed.startsWith('fe80:') || trimmed.startsWith('fe8') || trimmed.startsWith('fe9') || trimmed.startsWith('fea') || trimmed.startsWith('feb')) {
      return true; // Link-local (fe80::/10)
    }
    if (trimmed.startsWith('fc00:') || trimmed.startsWith('fd')) {
      return true; // Unique local (fc00::/7)
    }
    if (trimmed.startsWith('fd00:ec2:')) {
      return true; // AWS IPv6 metadata
    }
    if (trimmed.startsWith('ff')) {
      return true; // Multicast
    }
    return false;
  }

  return true; // Unknown IP format -> block by default
}

/**
 * Validates a Webhook URL against SSRF threats:
 * 1. Must use HTTPS scheme exclusively.
 * 2. Resolves DNS hostname to all IP addresses.
 * 3. Rejects if any resolved address belongs to a blocked/internal range.
 */
export async function validateWebhookUrlSSRF(rawUrl: string): Promise<{ valid: boolean; error?: string }> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { valid: false, error: 'URL_MALFORMED: La URL del webhook no es válida.' };
  }

  // Enforce HTTPS
  if (parsed.protocol.toLowerCase() !== 'https:') {
    return {
      valid: false,
      error: 'SSRF_BLOCKED_PROTOCOL: Solo se permiten Webhooks sobre HTTPS por razones de seguridad.',
    };
  }

  const hostname = parsed.hostname.toLowerCase();

  // Direct IP literal in URL hostname check
  if (isIpBlocked(hostname)) {
    return {
      valid: false,
      error: `SSRF_BLOCKED_HOST: La dirección '${hostname}' pertenece a un rango de red privado o reservado no permitido.`,
    };
  }

  // Resolve hostname via DNS
  try {
    const addresses = await dns.promises.lookup(hostname, { all: true });
    if (!addresses || addresses.length === 0) {
      return {
        valid: false,
        error: `SSRF_DNS_FAILED: No se pudo resolver la dirección DNS del host '${hostname}'.`,
      };
    }

    for (const addr of addresses) {
      if (isIpBlocked(addr.address)) {
        return {
          valid: false,
          error: `SSRF_BLOCKED_IP: La dirección IP resuelta '${addr.address}' para el host '${hostname}' pertenece a un rango de red prohibido (privado, loopback o metadata).`,
        };
      }
    }
  } catch (dnsErr: any) {
    return {
      valid: false,
      error: `SSRF_DNS_ERROR: Error al resolver DNS para '${hostname}': ${dnsErr?.message || dnsErr}`,
    };
  }

  return { valid: true };
}

// ============================================================================
// 2. HMAC-SHA256 SIGNATURE HELPERS
// ============================================================================

export function signWebhookPayload(payloadJson: string, timestamp: string, secret: string): string {
  const effectiveSecret = (secret || '').trim();
  if (!effectiveSecret) {
    throw new Error(
      '[WEBHOOK_SECRET_MISSING] Se requiere un webhook_secret explícito de la organización para firmar el webhook.'
    );
  }
  const digest = crypto
    .createHmac('sha256', effectiveSecret)
    .update(`${timestamp}.${payloadJson}`)
    .digest('hex');
  return `sha256=${digest}`;
}

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

// ============================================================================
// 3. PERSISTENT RETRIES WITH REAL BACKOFF
// ============================================================================

/**
 * Calculates exponential backoff in seconds for webhook delivery retries.
 * Attempt 1: +60s (1 min)
 * Attempt 2: +300s (5 min)
 * Attempt 3: +1800s (30 min)
 * Attempt 4: +7200s (2 hr)
 */
export function getNextRetryDate(attemptNumber: number): Date {
  const now = Date.now();
  let delaySeconds = 60;
  if (attemptNumber === 1) delaySeconds = 60;
  else if (attemptNumber === 2) delaySeconds = 300;
  else if (attemptNumber === 3) delaySeconds = 1800;
  else delaySeconds = 7200;

  return new Date(now + delaySeconds * 1000);
}

// ============================================================================
// 4. MAIN DISPATCHER FUNCTION
// ============================================================================

/**
 * Dispatches an HMAC-SHA256 signed webhook using strict organization configuration:
 * - Reads webhook_url and webhook_secret STRICTLY from public.organizations (never client parameters).
 * - Validates SSRF rules (HTTPS only, private IP blocks, no redirects).
 * - Enforces short timeout (3500ms).
 * - Records persistent delivery in public.webhook_deliveries with real backoff.
 */
export async function dispatchFileWebhook(params: {
  payload: WebhookPayload;
  ipAddress?: string;
}): Promise<WebhookDispatchResult> {
  const { payload, ipAddress = '127.0.0.1' } = params;

  if (!payload.orgId) {
    return {
      configured: false,
      delivered: false,
      attempts: 0,
      lastStatusCode: null,
      signature: null,
      timestamp: null,
      error: 'NO_ORG_ID_IN_PAYLOAD',
    };
  }

  // 1. Fetch organization webhook configuration strictly from DB
  const { data: orgData, error: orgErr } = await supabase
    .from('organizations')
    .select('id, name, webhook_url, webhook_secret')
    .eq('id', payload.orgId)
    .maybeSingle();

  if (orgErr || !orgData) {
    return {
      configured: false,
      delivered: false,
      attempts: 0,
      lastStatusCode: null,
      signature: null,
      timestamp: null,
      error: 'ORGANIZATION_NOT_FOUND',
    };
  }

  const webhookUrl = (orgData.webhook_url || '').trim();
  const webhookSecret = (orgData.webhook_secret || '').trim();

  // If organization has not configured a webhook URL, exit cleanly
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

  // If organization configured a URL but no secret, block delivery
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
      message: `Webhook omitido hacia '${webhookUrl}': la organización no tiene un webhook_secret configurado.`,
    });

    return {
      configured: true,
      delivered: false,
      attempts: 0,
      lastStatusCode: null,
      signature: null,
      timestamp: null,
      error: 'WEBHOOK_SECRET_NOT_CONFIGURED',
    };
  }

  // 2. SSRF Protection Validation
  const ssrfCheck = await validateWebhookUrlSSRF(webhookUrl);
  if (!ssrfCheck.valid) {
    await addServiceLog({
      method: 'POST',
      action: 'WEBHOOK_SSRF_BLOCKED',
      status: 'BLOCKED',
      userId: payload.userId || undefined,
      orgId: payload.orgId || undefined,
      ticketId: payload.ticketId || undefined,
      fileId: payload.fileId,
      ipAddress,
      message: `Intento de entrega de Webhook bloqueado por protección SSRF: ${ssrfCheck.error}. URL solicitada: '${webhookUrl}'.`,
    });

    return {
      configured: true,
      delivered: false,
      attempts: 0,
      lastStatusCode: null,
      signature: null,
      timestamp: null,
      error: ssrfCheck.error || null,
    };
  }

  // 3. Prepare payload and signature
  const timestamp = payload.timestamp || new Date().toISOString();
  const payloadJson = JSON.stringify(payload);
  const signature = signWebhookPayload(payloadJson, timestamp, webhookSecret);

  // 4. Register delivery attempt in public.webhook_deliveries
  let deliveryId: string | null = null;
  try {
    const { data: deliveryRow } = await supabase
      .from('webhook_deliveries')
      .insert({
        org_id: payload.orgId,
        file_id: payload.fileId,
        event: payload.event,
        target_url: webhookUrl,
        payload: payload,
        status: 'pending',
        attempts: 1,
        max_attempts: 5,
        next_retry_at: getNextRetryDate(1).toISOString(),
      })
      .select('id')
      .maybeSingle();

    if (deliveryRow?.id) {
      deliveryId = deliveryRow.id;
    }
  } catch (dbErr: any) {
    // If webhook_deliveries table migration hasn't run yet, gracefully log and continue
    console.warn('[WEBHOOK_DISPATCHER] webhook_deliveries table not yet initialized:', dbErr?.message);
  }

  // 5. Attempt Immediate HTTP Delivery
  let delivered = false;
  let lastStatusCode: number | null = null;
  let lastError: string | null = null;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3500); // 3.5s timeout

    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-webhook-signature': signature,
        'x-webhook-timestamp': timestamp,
        'x-webhook-event': payload.event,
        'x-webhook-attempt': '1',
      },
      body: payloadJson,
      redirect: 'error', // Strict SSRF: Never follow HTTP redirects
      signal: controller.signal,
    });

    clearTimeout(timeout);
    lastStatusCode = response.status;

    if (response.ok) {
      delivered = true;
    } else {
      lastError = `HTTP ${response.status} ${response.statusText}`;
    }
  } catch (err: any) {
    lastError = err?.message || 'Network, timeout or redirect error';
  }

  // 6. Update database record and write service_log
  const nowIso = new Date().toISOString();

  if (delivered) {
    if (deliveryId) {
      try {
        await supabase
          .from('webhook_deliveries')
          .update({
            status: 'delivered',
            last_status_code: lastStatusCode,
            last_error: null,
            updated_at: nowIso,
          })
          .eq('id', deliveryId);
      } catch {}
    }

    await addServiceLog({
      method: 'POST',
      action: 'WEBHOOK_SENT',
      status: 'DELIVERED',
      userId: payload.userId || undefined,
      orgId: payload.orgId || undefined,
      ticketId: payload.ticketId || undefined,
      fileId: payload.fileId,
      ipAddress,
      message: `Webhook '${payload.event}' entregado exitosamente a '${webhookUrl}' (HTTP ${lastStatusCode}, firma HMAC-SHA256).`,
    });
  } else {
    const nextRetryIso = getNextRetryDate(1).toISOString();
    if (deliveryId) {
      try {
        await supabase
          .from('webhook_deliveries')
          .update({
            status: 'pending',
            last_status_code: lastStatusCode,
            last_error: lastError,
            next_retry_at: nextRetryIso,
            updated_at: nowIso,
          })
          .eq('id', deliveryId);
      } catch {}
    }

    await addServiceLog({
      method: 'POST',
      action: 'WEBHOOK_FAILED',
      status: 'RETRY_SCHEDULED',
      userId: payload.userId || undefined,
      orgId: payload.orgId || undefined,
      ticketId: payload.ticketId || undefined,
      fileId: payload.fileId,
      ipAddress,
      message: `Fallo de entrega de Webhook '${payload.event}' hacia '${webhookUrl}'. Error: ${lastError}. Reintento programado para ${nextRetryIso}.`,
    });
  }

  return {
    configured: true,
    delivered,
    deliveryId,
    attempts: 1,
    lastStatusCode,
    signature,
    timestamp,
    error: lastError,
  };
}

/**
 * Task C: Retries pending webhooks whose next_retry_at <= now().
 * Called periodically by the maintenance cron.
 */
export async function retryPendingWebhooks(): Promise<{
  processed: number;
  delivered: number;
  failedAgain: number;
  exhausted: number;
}> {
  const summary = {
    processed: 0,
    delivered: 0,
    failedAgain: 0,
    exhausted: 0,
  };

  const nowIso = new Date().toISOString();

  let pendingRows: any[] = [];
  try {
    const { data } = await supabase
      .from('webhook_deliveries')
      .select('id, org_id, file_id, event, target_url, payload, attempts, max_attempts')
      .eq('status', 'pending')
      .lte('next_retry_at', nowIso)
      .limit(20);

    pendingRows = data || [];
  } catch (err: any) {
    // If table doesn't exist yet, return empty
    return summary;
  }

  for (const item of pendingRows) {
    summary.processed++;
    const currentAttempts = Number(item.attempts || 1);
    const maxAttempts = Number(item.max_attempts || 5);
    const newAttemptNumber = currentAttempts + 1;

    // Check SSRF again before connecting
    const ssrfCheck = await validateWebhookUrlSSRF(item.target_url);
    if (!ssrfCheck.valid) {
      await supabase
        .from('webhook_deliveries')
        .update({
          status: 'failed',
          last_error: ssrfCheck.error,
          updated_at: new Date().toISOString(),
        })
        .eq('id', item.id);
      summary.exhausted++;
      continue;
    }

    // Read organization secret
    const { data: orgData } = await supabase
      .from('organizations')
      .select('webhook_secret')
      .eq('id', item.org_id)
      .maybeSingle();

    const webhookSecret = (orgData?.webhook_secret || '').trim();
    if (!webhookSecret) {
      await supabase
        .from('webhook_deliveries')
        .update({
          status: 'failed',
          last_error: 'ORGANIZATION_SECRET_REMOVED',
          updated_at: new Date().toISOString(),
        })
        .eq('id', item.id);
      summary.exhausted++;
      continue;
    }

    const timestamp = new Date().toISOString();
    const payloadJson = JSON.stringify(item.payload);
    const signature = signWebhookPayload(payloadJson, timestamp, webhookSecret);

    let delivered = false;
    let lastStatusCode: number | null = null;
    let lastError: string | null = null;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3500);

      const response = await fetch(item.target_url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-webhook-signature': signature,
          'x-webhook-timestamp': timestamp,
          'x-webhook-event': item.event,
          'x-webhook-attempt': String(newAttemptNumber),
        },
        body: payloadJson,
        redirect: 'error',
        signal: controller.signal,
      });

      clearTimeout(timeout);
      lastStatusCode = response.status;
      delivered = response.ok;
      if (!response.ok) {
        lastError = `HTTP ${response.status} ${response.statusText}`;
      }
    } catch (err: any) {
      lastError = err?.message || 'Network, timeout or redirect error';
    }

    const updateNowIso = new Date().toISOString();

    if (delivered) {
      summary.delivered++;
      await supabase
        .from('webhook_deliveries')
        .update({
          status: 'delivered',
          attempts: newAttemptNumber,
          last_status_code: lastStatusCode,
          last_error: null,
          updated_at: updateNowIso,
        })
        .eq('id', item.id);
    } else {
      if (newAttemptNumber >= maxAttempts) {
        summary.exhausted++;
        await supabase
          .from('webhook_deliveries')
          .update({
            status: 'failed',
            attempts: newAttemptNumber,
            last_status_code: lastStatusCode,
            last_error: lastError,
            updated_at: updateNowIso,
          })
          .eq('id', item.id);
      } else {
        summary.failedAgain++;
        const nextRetryIso = getNextRetryDate(newAttemptNumber).toISOString();
        await supabase
          .from('webhook_deliveries')
          .update({
            status: 'pending',
            attempts: newAttemptNumber,
            last_status_code: lastStatusCode,
            last_error: lastError,
            next_retry_at: nextRetryIso,
            updated_at: updateNowIso,
          })
          .eq('id', item.id);
      }
    }
  }

  return summary;
}
