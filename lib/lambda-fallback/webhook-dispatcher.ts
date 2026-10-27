// ============================================================================
// [TEMPORARY-LAMBDA-FALLBACK: WEBHOOK-DISPATCHER]
// Búsqueda rápida: "TEMPORARY-LAMBDA-FALLBACK"
// Sustituye a: AWS EventBridge / SQS + Lambda de notificación.
//
// - Destino y secreto: SIEMPRE los actuales de public.organizations (webhook_url,
//   webhook_secret), leídos en el momento de cada envío. Nunca del cliente.
// - SSRF: solo HTTPS, sin credenciales en la URL, DNS resuelto y validado contra
//   rangos privados/loopback/link-local/metadata en cada envío, redirect: 'error',
//   timeout 3.5 s.
// - Payload: se construye en cada envío desde public.files (sin claves de S3).
// - Persistencia: public.webhook_deliveries (sin payload ni URL). Reclamo atómico
//   con claim_webhook_deliveries() (FOR UPDATE SKIP LOCKED).
// - last_error: solo códigos cortos; nunca cuerpos de respuesta ni URLs.
// ============================================================================

import crypto from 'crypto';
import dns from 'dns';
import { supabase } from '@/lib/supabase';
import { addServiceLog } from '@/lib/service-logs';

export type WebhookEventName = 'file.uploaded' | 'file.processed' | 'file.failed';

export interface WebhookDispatchResult {
  configured: boolean;
  delivered: boolean;
  deliveryId: string | null;
  attempts: number;
  lastStatusCode: number | null;
  error: string | null;
}

const WEBHOOK_TIMEOUT_MS = 3500;
const SENDING_LOCK_SECONDS = 60;
const DEFAULT_MAX_ATTEMPTS = 5;
const DELIVERED_RETENTION_DAYS = 30;
const FAILED_RETENTION_DAYS = 90;

// ============================================================================
// 1. SSRF
// ============================================================================

function ipv4ToLong(ip: string): number {
  return ip.split('.').reduce((acc, o) => ((acc << 8) + parseInt(o, 10)) >>> 0, 0);
}

function isIpv4InCidr(ip: string, cidr: string): boolean {
  const [range, bitsStr] = cidr.split('/');
  const bits = parseInt(bitsStr, 10);
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipv4ToLong(ip) & mask) === (ipv4ToLong(range) & mask);
}

const FORBIDDEN_IPV4_CIDRS = [
  '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16',
  '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24', '192.88.99.0/24', '192.168.0.0/16',
  '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4',
  '255.255.255.255/32',
];

export function isIpBlocked(ip: string): boolean {
  const t = ip.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (t.startsWith('::ffff:')) return isIpBlocked(t.substring(7));
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(t)) {
    return FORBIDDEN_IPV4_CIDRS.some((c) => isIpv4InCidr(t, c));
  }
  if (t.includes(':')) {
    if (t === '::' || t === '::1') return true;
    if (/^fe[89ab]/.test(t)) return true; // link-local fe80::/10
    if (/^f[cd]/.test(t)) return true; // unique local fc00::/7 (incl. fd00:ec2::254 metadata)
    if (t.startsWith('ff')) return true; // multicast
    if (t.startsWith('64:ff9b:')) return true; // NAT64 (could map to private IPv4)
    return false;
  }
  return false; // not an IP literal (hostname) -> validated via DNS
}

/** Returns a short error code (no host, no IP, no URL) or null when the URL is safe. */
export async function validateWebhookUrlSSRF(rawUrl: string): Promise<string | null> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return 'SSRF_URL_MALFORMED';
  }
  if (parsed.protocol !== 'https:') return 'SSRF_PROTOCOL_NOT_HTTPS';
  if (parsed.username || parsed.password) return 'SSRF_CREDENTIALS_IN_URL';

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) {
    return 'SSRF_BLOCKED_HOST';
  }
  if (isIpBlocked(host)) return 'SSRF_BLOCKED_IP';

  try {
    const addresses = await dns.promises.lookup(host, { all: true, verbatim: true });
    if (!addresses.length) return 'SSRF_DNS_EMPTY';
    if (addresses.some((a) => isIpBlocked(a.address))) return 'SSRF_BLOCKED_IP';
  } catch {
    return 'SSRF_DNS_ERROR';
  }
  return null;
}

/** For logs: scheme + host only (no userinfo, path or query string). */
function redactUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    return `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ''}`;
  } catch {
    return '[url-invalida]';
  }
}

/** Maps any fetch failure to a short code. Never stores response bodies or URLs. */
function sanitizeFetchError(err: any): string {
  const name = String(err?.name || '');
  const msg = String(err?.message || '').toLowerCase();
  if (name === 'AbortError' || msg.includes('abort')) return 'TIMEOUT';
  if (msg.includes('redirect')) return 'REDIRECT_BLOCKED';
  if (msg.includes('certificate') || msg.includes('ssl') || msg.includes('tls')) return 'TLS_ERROR';
  return 'NETWORK_ERROR';
}

// ============================================================================
// 2. HMAC-SHA256
// ============================================================================

export function signWebhookPayload(payloadJson: string, timestamp: string, secret: string): string {
  const s = (secret || '').trim();
  if (!s) throw new Error('[WEBHOOK_SECRET_MISSING]');
  return `sha256=${crypto.createHmac('sha256', s).update(`${timestamp}.${payloadJson}`).digest('hex')}`;
}

export function verifyWebhookSignature(
  payloadJson: string,
  timestamp: string,
  signatureHeader: string,
  secret: string
): boolean {
  const s = (secret || '').trim();
  if (!payloadJson || !timestamp || !signatureHeader || !s) return false;
  const a = Buffer.from(signWebhookPayload(payloadJson, timestamp, s), 'utf8');
  const b = Buffer.from(signatureHeader.trim(), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ============================================================================
// 3. Backoff y payload
// ============================================================================

/** Delay before the next attempt, after `attemptsDone` failed attempts. */
export function getBackoffSeconds(attemptsDone: number): number {
  if (attemptsDone <= 1) return 60;
  if (attemptsDone === 2) return 300;
  if (attemptsDone === 3) return 1800;
  return 7200;
}

function statusForEvent(event: WebhookEventName): 'uploaded' | 'processed' | 'failed' {
  return event === 'file.failed' ? 'failed' : event === 'file.processed' ? 'processed' : 'uploaded';
}

/** Builds the payload from the current files row. Never includes S3 keys. */
function buildPayload(file: any, event: WebhookEventName, deliveryId: string | null, timestamp: string) {
  const visibility = String(file.visibility || 'private').toLowerCase() === 'public' ? 'public' : 'private';
  let errorMessage: string | null = null;
  if (event === 'file.failed' && file.error_message) {
    errorMessage = String(file.error_message)
      .replace(/static\/[A-Za-z0-9/_.-]+/g, '[redacted]')
      .slice(0, 200);
  }
  return {
    event,
    deliveryId,
    timestamp,
    fileId: file.id,
    ticketId: file.ticket_id || null,
    orgId: file.org_id || null,
    userId: file.user_id || null,
    status: statusForEvent(event),
    fileStatus: file.status,
    scanStatus: file.scan_status || 'not_scanned',
    visibility,
    mimeType: file.mime_type || null,
    sizeBytes: Number(file.size_bytes || 0),
    sha256Hash: file.sha256_hash || null,
    sha256Verified: Boolean(file.sha256_verified),
    cloudfrontUrl: visibility === 'public' ? file.cloudfront_url || null : null,
    errorMessage,
  };
}

// ============================================================================
// 4. Envío de una entrega ya reclamada (status = 'sending')
// ============================================================================

interface ClaimedDelivery {
  id: string | null; // null when the table is not migrated yet (no persistence)
  org_id: string;
  file_id: string;
  event_type: WebhookEventName;
  attempts: number;
  max_attempts: number;
}

async function finalizeDelivery(
  d: ClaimedDelivery,
  outcome: { delivered: boolean; statusCode: number | null; error: string | null; terminal?: boolean }
) {
  if (!d.id) return;
  const nowIso = new Date().toISOString();
  let update: Record<string, any>;
  if (outcome.delivered) {
    update = { status: 'delivered', locked_until: null, last_status_code: outcome.statusCode, last_error: null, delivered_at: nowIso, updated_at: nowIso };
  } else if (outcome.terminal || d.attempts >= d.max_attempts) {
    update = { status: 'failed', locked_until: null, last_status_code: outcome.statusCode, last_error: outcome.error, updated_at: nowIso };
  } else {
    update = {
      status: 'pending',
      locked_until: null,
      last_status_code: outcome.statusCode,
      last_error: outcome.error,
      next_retry_at: new Date(Date.now() + getBackoffSeconds(d.attempts) * 1000).toISOString(),
      updated_at: nowIso,
    };
  }
  // Only finalize if we still own the claim (same status and attempt number).
  await supabase
    .from('webhook_deliveries')
    .update(update)
    .eq('id', d.id)
    .eq('status', 'sending')
    .eq('attempts', d.attempts);
}

async function sendClaimedDelivery(d: ClaimedDelivery, ipAddress: string): Promise<WebhookDispatchResult> {
  const base = { deliveryId: d.id, attempts: d.attempts };

  // Current organization configuration (read at send time)
  const { data: org } = await supabase
    .from('organizations')
    .select('webhook_url, webhook_secret')
    .eq('id', d.org_id)
    .maybeSingle();
  const webhookUrl = String(org?.webhook_url || '').trim();
  const webhookSecret = String(org?.webhook_secret || '').trim();

  if (!webhookUrl || !webhookSecret) {
    const code = !webhookUrl ? 'WEBHOOK_NOT_CONFIGURED' : 'WEBHOOK_SECRET_NOT_CONFIGURED';
    await finalizeDelivery(d, { delivered: false, statusCode: null, error: code, terminal: true });
    return { ...base, configured: false, delivered: false, lastStatusCode: null, error: code };
  }

  const ssrfError = await validateWebhookUrlSSRF(webhookUrl);
  if (ssrfError) {
    await finalizeDelivery(d, { delivered: false, statusCode: null, error: ssrfError, terminal: true });
    await addServiceLog({
      method: 'POST',
      action: 'WEBHOOK_SSRF_BLOCKED',
      status: 'BLOCKED',
      orgId: d.org_id,
      fileId: d.file_id,
      ipAddress,
      message: `Webhook bloqueado por SSRF (${ssrfError}) hacia ${redactUrl(webhookUrl)}. deliveryId=${d.id}.`,
    });
    return { ...base, configured: true, delivered: false, lastStatusCode: null, error: ssrfError };
  }

  const { data: file } = await supabase.from('files').select('*').eq('id', d.file_id).maybeSingle();
  if (!file) {
    await finalizeDelivery(d, { delivered: false, statusCode: null, error: 'FILE_NOT_FOUND', terminal: true });
    return { ...base, configured: true, delivered: false, lastStatusCode: null, error: 'FILE_NOT_FOUND' };
  }

  const timestamp = new Date().toISOString();
  const payloadJson = JSON.stringify(buildPayload(file, d.event_type, d.id, timestamp));
  const signature = signWebhookPayload(payloadJson, timestamp, webhookSecret);

  let delivered = false;
  let statusCode: number | null = null;
  let error: string | null = null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-webhook-signature': signature,
        'x-webhook-timestamp': timestamp,
        'x-webhook-event': d.event_type,
        'x-webhook-attempt': String(d.attempts),
        ...(d.id ? { 'x-webhook-delivery-id': d.id } : {}),
      },
      body: payloadJson,
      redirect: 'error',
      signal: controller.signal,
      cache: 'no-store',
    });
    statusCode = res.status;
    delivered = res.ok;
    if (!res.ok) error = `HTTP_${res.status}`;
    // Body is intentionally never read or stored.
    try { await res.body?.cancel(); } catch {}
  } catch (err: any) {
    error = sanitizeFetchError(err);
  } finally {
    clearTimeout(timer);
  }

  await finalizeDelivery(d, { delivered, statusCode, error });

  await addServiceLog({
    method: 'POST',
    action: delivered ? 'WEBHOOK_SENT' : 'WEBHOOK_FAILED',
    status: delivered ? 'DELIVERED' : d.attempts >= d.max_attempts ? 'FAILED_FINAL' : 'RETRY_SCHEDULED',
    userId: file.user_id || undefined,
    orgId: d.org_id,
    ticketId: file.ticket_id || undefined,
    fileId: d.file_id,
    ipAddress,
    message: `Webhook '${d.event_type}' hacia ${redactUrl(webhookUrl)}: ${delivered ? `entregado (HTTP ${statusCode})` : `fallo ${error}`}. intento=${d.attempts}/${d.max_attempts}, deliveryId=${d.id}.`,
  });

  return { ...base, configured: true, delivered, lastStatusCode: statusCode, error };
}

// ============================================================================
// 5. API pública
// ============================================================================

/**
 * Creates a delivery row already claimed (status='sending', attempts=1, locked_until)
 * and sends it immediately. Because the row is born claimed, the cron's
 * claim_webhook_deliveries() cannot pick it up concurrently.
 */
export async function dispatchFileWebhook(params: {
  fileId: string;
  event: WebhookEventName;
  ipAddress?: string;
}): Promise<WebhookDispatchResult> {
  const { fileId, event, ipAddress = '127.0.0.1' } = params;
  const notConfigured: WebhookDispatchResult = {
    configured: false, delivered: false, deliveryId: null, attempts: 0, lastStatusCode: null, error: null,
  };

  const { data: file } = await supabase.from('files').select('id, org_id').eq('id', fileId).maybeSingle();
  if (!file?.org_id) return { ...notConfigured, error: 'FILE_NOT_FOUND' };

  const { data: org } = await supabase
    .from('organizations')
    .select('webhook_url, webhook_secret')
    .eq('id', file.org_id)
    .maybeSingle();
  if (!String(org?.webhook_url || '').trim()) return notConfigured;
  if (!String(org?.webhook_secret || '').trim()) {
    await addServiceLog({
      method: 'POST',
      action: 'WEBHOOK_SKIPPED_NO_SECRET',
      status: 'BLOCKED',
      orgId: file.org_id,
      fileId,
      ipAddress,
      message: 'Webhook omitido: la organización tiene webhook_url pero no webhook_secret.',
    });
    return { ...notConfigured, configured: true, error: 'WEBHOOK_SECRET_NOT_CONFIGURED' };
  }

  const { data: row, error: insertErr } = await supabase
    .from('webhook_deliveries')
    .insert({
      org_id: file.org_id,
      file_id: fileId,
      event_type: event,
      status: 'sending',
      attempts: 1,
      max_attempts: DEFAULT_MAX_ATTEMPTS,
      locked_until: new Date(Date.now() + SENDING_LOCK_SECONDS * 1000).toISOString(),
    })
    .select('id, org_id, file_id, event_type, attempts, max_attempts')
    .maybeSingle();

  const claimed: ClaimedDelivery =
    !insertErr && row
      ? (row as ClaimedDelivery)
      : // Table not migrated yet: single best-effort attempt, no persistence.
        { id: null, org_id: file.org_id, file_id: fileId, event_type: event, attempts: 1, max_attempts: 1 };

  return sendClaimedDelivery(claimed, ipAddress);
}

/** Claims due deliveries atomically and sends them. Called from the maintenance cron. */
export async function processPendingWebhookDeliveries(limit = 20): Promise<{
  claimed: number;
  delivered: number;
  rescheduled: number;
  failed: number;
  error?: string;
}> {
  const summary = { claimed: 0, delivered: 0, rescheduled: 0, failed: 0 };
  const { data, error } = await supabase.rpc('claim_webhook_deliveries', {
    p_limit: limit,
    p_lock_seconds: SENDING_LOCK_SECONDS,
  });
  if (error) return { ...summary, error: error.code || 'CLAIM_FAILED' };

  for (const d of (data || []) as ClaimedDelivery[]) {
    summary.claimed++;
    const res = await sendClaimedDelivery(d, 'cron');
    if (res.delivered) summary.delivered++;
    else if (d.attempts >= d.max_attempts || (res.error || '').startsWith('SSRF_') || res.error?.startsWith('WEBHOOK_') || res.error === 'FILE_NOT_FOUND') summary.failed++;
    else summary.rescheduled++;
  }
  return summary;
}

/** Retention: delivered > 30 days and failed > 90 days are deleted. Called from the cron. */
export async function purgeOldWebhookDeliveries(): Promise<{ ok: boolean; error?: string }> {
  const now = Date.now();
  const deliveredCutoff = new Date(now - DELIVERED_RETENTION_DAYS * 86400000).toISOString();
  const failedCutoff = new Date(now - FAILED_RETENTION_DAYS * 86400000).toISOString();

  const r1 = await supabase.from('webhook_deliveries').delete().eq('status', 'delivered').lt('updated_at', deliveredCutoff);
  const r2 = await supabase.from('webhook_deliveries').delete().eq('status', 'failed').lt('updated_at', failedCutoff);
  const err = r1.error || r2.error;
  return err ? { ok: false, error: err.code || 'DELETE_FAILED' } : { ok: true };
}
