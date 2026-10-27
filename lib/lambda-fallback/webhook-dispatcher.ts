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
import https from 'https';
import net from 'net';
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
// 1. SSRF & CONEXIÓN FIJADA A LA IP VALIDADA (Anti-DNS Rebinding / TOCTOU)
// ============================================================================

export function parseIpToBytes(raw: string): { family: 4 | 6; bytes: number[] } | null {
  const ip = String(raw || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map((x) => parseInt(x, 10));
    if (parts.length === 4 && parts.every((p) => !isNaN(p) && p >= 0 && p <= 255)) {
      return { family: 4, bytes: parts };
    }
    return null;
  }
  if (net.isIPv6(ip)) {
    let s = ip;
    if (s.includes('.')) {
      const lastColon = s.lastIndexOf(':');
      const v4part = s.substring(lastColon + 1);
      if (!net.isIPv4(v4part)) return null;
      const v4bytes = v4part.split('.').map((x) => parseInt(x, 10));
      const hexPart =
        ((v4bytes[0] << 8) | v4bytes[1]).toString(16) + ':' + (((v4bytes[2] << 8) | v4bytes[3]) >>> 0).toString(16);
      s = s.substring(0, lastColon + 1) + hexPart;
    }
    const parts = s.split('::');
    if (parts.length > 2) return null;
    const left = parts[0] ? parts[0].split(':') : [];
    const right = parts[1] ? parts[1].split(':') : [];
    const missing = 8 - (left.length + right.length);
    if (missing < 0) return null;
    const middle = new Array(missing).fill('0');
    const full = (parts.length === 2 ? [...left, ...middle, ...right] : left).map((h) => parseInt(h || '0', 16));
    if (full.length !== 8 || full.some((h) => isNaN(h) || h < 0 || h > 0xffff)) return null;
    const bytes: number[] = [];
    for (const h of full) {
      bytes.push((h >> 8) & 0xff);
      bytes.push(h & 0xff);
    }
    const isV4Mapped = bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
    if (isV4Mapped) {
      return { family: 4, bytes: bytes.slice(12) };
    }
    return { family: 6, bytes };
  }
  return null;
}

export function isIpBlocked(raw: string): boolean {
  const parsed = parseIpToBytes(raw);
  // Rechaza por defecto cualquier cadena que no pueda interpretar como IP
  if (!parsed) return true;

  if (parsed.family === 4) {
    const b = parsed.bytes;
    if (b[0] === 0) return true; // 0.0.0.0/8
    if (b[0] === 10) return true; // 10.0.0.0/8
    if (b[0] === 100 && (b[1] & 0xc0) === 64) return true; // 100.64.0.0/10
    if (b[0] === 127) return true; // 127.0.0.0/8 Loopback
    if (b[0] === 169 && b[1] === 254) return true; // 169.254.0.0/16 Link-local / Metadata
    if (b[0] === 172 && (b[1] & 0xf0) === 16) return true; // 172.16.0.0/12 Private
    if (b[0] === 192 && b[1] === 0 && b[2] === 0) return true; // 192.0.0.0/24
    if (b[0] === 192 && b[1] === 0 && b[2] === 2) return true; // 192.0.2.0/24 TEST-NET-1
    if (b[0] === 192 && b[1] === 88 && b[2] === 99) return true; // 192.88.99.0/24 6to4
    if (b[0] === 192 && b[1] === 168) return true; // 192.168.0.0/16 Private
    if (b[0] === 198 && (b[1] & 0xfe) === 18) return true; // 198.18.0.0/15
    if (b[0] === 198 && b[1] === 51 && b[2] === 100) return true; // 198.51.100.0/24 TEST-NET-2
    if (b[0] === 203 && b[1] === 0 && b[2] === 113) return true; // 203.0.113.0/24 TEST-NET-3
    if (b[0] >= 224) return true; // Multicast & Reserved
    return false;
  }

  const b = parsed.bytes;
  if (b.every((x) => x === 0)) return true; // ::
  if (b.slice(0, 15).every((x) => x === 0) && b[15] === 1) return true; // ::1 Loopback
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true; // fe80::/10 Link-Local
  if ((b[0] & 0xfe) === 0xfc) return true; // fc00::/7 Unique Local (fd00::/8)
  if (b[0] === 0xff) return true; // ff00::/8 Multicast
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && b.slice(4, 12).every((x) => x === 0)) return true; // 64:ff9b::/96
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return true; // 2001:db8::/32 Documentation
  if (b[0] === 0x01 && b[1] === 0x00 && b.slice(2, 8).every((x) => x === 0)) return true; // 100::/64 Discard
  return false;
}

export type SSRFValidationResult =
  | { safe: true; parsedUrl: URL; hostname: string; pinnedIp: string; pinnedFamily: 4 | 6 }
  | { safe: false; error: string };

/**
 * Valida la URL contra SSRF y resuelve la IP para fijar la conexión TCP posterior (anti-TOCTOU).
 */
export async function validateWebhookUrlSSRF(rawUrl: string): Promise<SSRFValidationResult> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { safe: false, error: 'SSRF_URL_MALFORMED' };
  }
  if (parsed.protocol !== 'https:') return { safe: false, error: 'SSRF_PROTOCOL_NOT_HTTPS' };
  if (parsed.username || parsed.password) return { safe: false, error: 'SSRF_CREDENTIALS_IN_URL' };

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) {
    return { safe: false, error: 'SSRF_BLOCKED_HOST' };
  }

  // Si host es una IP literal (ej. 127.0.0.1 o [::1] o [::ffff:7f00:1])
  const literalParsed = parseIpToBytes(host);
  if (literalParsed) {
    if (isIpBlocked(host)) {
      return { safe: false, error: 'SSRF_BLOCKED_IP' };
    }
    return {
      safe: true,
      parsedUrl: parsed,
      hostname: host,
      pinnedIp: host,
      pinnedFamily: literalParsed.family,
    };
  }

  // Host es un dominio: resuelve todas sus direcciones
  try {
    const addresses = await dns.promises.lookup(host, { all: true, verbatim: true });
    if (!addresses.length) return { safe: false, error: 'SSRF_DNS_EMPTY' };
    for (const a of addresses) {
      if (isIpBlocked(a.address)) {
        return { safe: false, error: 'SSRF_BLOCKED_IP' };
      }
    }
    const chosen = addresses.find((a) => a.family === 4) || addresses[0];
    return {
      safe: true,
      parsedUrl: parsed,
      hostname: host,
      pinnedIp: chosen.address,
      pinnedFamily: (chosen.family === 6 ? 6 : 4) as 4 | 6,
    };
  } catch {
    return { safe: false, error: 'SSRF_DNS_ERROR' };
  }
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

/** Conecta a la IP ya validada conservando Host y SNI sin segundo resolve (inmune a rebinding). */
export function executePinnedHttpsPost(
  parsedUrl: URL,
  pinnedIp: string,
  pinnedFamily: 4 | 6,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number
): Promise<{ statusCode: number; error: string | null }> {
  return new Promise((resolve) => {
    let finished = false;
    const finish = (result: { statusCode: number; error: string | null }) => {
      if (!finished) {
        finished = true;
        resolve(result);
      }
    };

    const port = parsedUrl.port ? parseInt(parsedUrl.port, 10) : 443;
    const req = https.request(
      {
        protocol: 'https:',
        hostname: parsedUrl.hostname,
        servername: parsedUrl.hostname,
        port,
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'POST',
        headers: {
          Host: parsedUrl.hostname + (parsedUrl.port ? `:${parsedUrl.port}` : ''),
          ...headers,
        },
        lookup: (_hostname, options, callback) => {
          const cb = typeof options === 'function' ? options : callback;
          const all = options && typeof options === 'object' && (options as any).all;
          if (all) {
            return cb(null, [{ address: pinnedIp, family: pinnedFamily }]);
          }
          return cb(null, pinnedIp, pinnedFamily);
        },
        timeout: timeoutMs,
      },
      (res) => {
        const statusCode = res.statusCode || 0;
        if (statusCode >= 300 && statusCode < 400) {
          res.destroy();
          return finish({ statusCode, error: 'REDIRECT_BLOCKED' });
        }
        const ok = statusCode >= 200 && statusCode < 300;
        res.destroy();
        return finish({ statusCode, error: ok ? null : `HTTP_${statusCode}` });
      }
    );

    req.on('timeout', () => {
      req.destroy();
      finish({ statusCode: 0, error: 'TIMEOUT' });
    });

    req.on('error', (err: any) => {
      finish({ statusCode: 0, error: sanitizeFetchError(err) });
    });

    req.write(body);
    req.end();
  });
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

  const ssrfResult = await validateWebhookUrlSSRF(webhookUrl);
  if (!ssrfResult.safe) {
    const ssrfError = ssrfResult.error;
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

  // Conexión fijada directamente a la IP validada (inmune a DNS rebinding / TOCTOU)
  const res = await executePinnedHttpsPost(
    ssrfResult.parsedUrl,
    ssrfResult.pinnedIp,
    ssrfResult.pinnedFamily,
    {
      'Content-Type': 'application/json',
      'x-webhook-signature': signature,
      'x-webhook-timestamp': timestamp,
      'x-webhook-event': d.event_type,
      'x-webhook-attempt': String(d.attempts),
      ...(d.id ? { 'x-webhook-delivery-id': d.id } : {}),
    },
    payloadJson,
    WEBHOOK_TIMEOUT_MS
  );

  const statusCode = res.statusCode || null;
  const delivered = res.statusCode >= 200 && res.statusCode < 300;
  const error = res.error;

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
 *
 * [TEMPORARY-LAMBDA-FALLBACK: WEBHOOK-CIRCUIT-BREAKER]
 * Si las últimas N entregas de esa organización fallaron consecutivamente,
 * se encola la entrega (status='pending') sin esperarla en línea, evitando penalizar
 * la latencia de la subida con esperas infructuosas (3.5s timeout).
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

  // ============================================================================
  // [TEMPORARY-LAMBDA-FALLBACK: WEBHOOK-CIRCUIT-BREAKER]
  // ============================================================================
  const CIRCUIT_BREAKER_FAILURES_THRESHOLD = 3;
  const { data: recentDeliveries } = await supabase
    .from('webhook_deliveries')
    .select('status')
    .eq('org_id', file.org_id)
    .order('created_at', { ascending: false })
    .limit(CIRCUIT_BREAKER_FAILURES_THRESHOLD);

  const isCircuitBreakerOpen =
    Boolean(recentDeliveries &&
    recentDeliveries.length >= CIRCUIT_BREAKER_FAILURES_THRESHOLD &&
    recentDeliveries.every((d) => d.status !== 'delivered'));

  if (isCircuitBreakerOpen) {
    const { data: queuedRow } = await supabase
      .from('webhook_deliveries')
      .insert({
        org_id: file.org_id,
        file_id: fileId,
        event_type: event,
        status: 'pending',
        attempts: 0,
        max_attempts: DEFAULT_MAX_ATTEMPTS,
        locked_until: null,
        next_retry_at: new Date().toISOString(),
      })
      .select('id')
      .maybeSingle();

    await addServiceLog({
      method: 'POST',
      action: 'WEBHOOK_CIRCUIT_BREAKER_QUEUED',
      status: 'QUEUED',
      orgId: file.org_id,
      fileId,
      ipAddress,
      message: `Webhook '${event}' encolado en segundo plano sin esperar en línea (circuit breaker abierto: últimas ${CIRCUIT_BREAKER_FAILURES_THRESHOLD} entregas fallaron). deliveryId=${queuedRow?.id || 'none'}.`,
    });

    return {
      configured: true,
      delivered: false,
      deliveryId: queuedRow?.id || null,
      attempts: 0,
      lastStatusCode: null,
      error: 'CIRCUIT_BREAKER_QUEUED',
    };
  }
  // ============================================================================
  // END [TEMPORARY-LAMBDA-FALLBACK: WEBHOOK-CIRCUIT-BREAKER]
  // ============================================================================

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
