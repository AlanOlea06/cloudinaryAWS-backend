import crypto from 'crypto';
import postgres from 'postgres';

let sqlClient = null;
function getSql() {
  if (!sqlClient) {
    const rawUrl = (process.env.DATABASE_URL || '').trim();
    if (!rawUrl) {
      throw new Error('Missing DATABASE_URL environment variable in practicas-alan-fn3');
    }
    const connStr = rawUrl.replace(/(\.pooler\.[^:]+):6543\b/, '$1:5432');
    sqlClient = postgres(connStr, {
      max: 1,
      idle_timeout: 10,
      connect_timeout: 10,
      prepare: false,
    });
  }
  return sqlClient;
}

export const handler = async (event) => {
  console.log('[practicas-alan-fn3] Conditional webhook invocation:', JSON.stringify(event));

  const sql = getSql();
  const detail = event?.detail || {};
  const objectKey = decodeURIComponent(
    String(detail?.s3ObjectDetails?.objectKey || event?.objectKey || '').replace(/\+/g, ' ')
  );
  const fileId = event?.fileId || null;

  if (!objectKey && !fileId) {
    return { ok: false, skipped: 'missing_target' };
  }

  const rows = fileId
    ? await sql`
        SELECT f.id, f.ticket_id, f.org_id, f.user_id, f.original_name, f.mime_type,
               f.size_bytes, f.visibility, f.status, f.scan_status, f.cloudfront_url,
               o.name AS org_name, o.slug AS org_slug, o.webhook_url, o.webhook_secret
        FROM files f
        JOIN organizations o ON o.id = f.org_id
        WHERE f.id = ${fileId}
        LIMIT 1
      `
    : await sql`
        SELECT f.id, f.ticket_id, f.org_id, f.user_id, f.original_name, f.mime_type,
               f.size_bytes, f.visibility, f.status, f.scan_status, f.cloudfront_url,
               o.name AS org_name, o.slug AS org_slug, o.webhook_url, o.webhook_secret
        FROM files f
        JOIN organizations o ON o.id = f.org_id
        WHERE f.s3_processed_key = ${objectKey} OR f.s3_pending_key = ${objectKey}
        LIMIT 1
      `;

  const record = rows[0] || null;
  if (!record || !record.webhook_url) {
    return { ok: true, skipped: 'no_webhook_configured' };
  }

  const webhookEvent =
    record.scan_status === 'THREAT_DETECTED' || record.status === 'quarantined'
      ? 'file.quarantined'
      : 'file.ready';

  const timestamp = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify({
    event: webhookEvent,
    timestamp: new Date(timestamp * 1000).toISOString(),
    file: {
      id: record.id,
      ticketId: record.ticket_id,
      originalName: record.original_name,
      mimeType: record.mime_type,
      sizeBytes: Number(record.size_bytes || 0),
      visibility: record.visibility,
      status: record.status,
      scanStatus: record.scan_status,
      cloudfrontUrl: record.cloudfront_url,
    },
    organization: {
      id: record.org_id,
      name: record.org_name,
      slug: record.org_slug,
    },
  });

  const secret = record.webhook_secret || process.env.TICKET_SIGNING_SECRET || 'webhook-secret';
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${payload}`)
    .digest('hex');

  const resp = await fetch(record.webhook_url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-webhook-event': webhookEvent,
      'x-webhook-timestamp': String(timestamp),
      'x-webhook-signature': `t=${timestamp},v1=${signature}`,
    },
    body: payload,
  });

  await sql`
    INSERT INTO service_logs (http_method, action, status, user_id, org_id, ticket_id, file_id, ip_address, message)
    VALUES ('POST', 'LAMBDA_FN3_WEBHOOK_SENT', ${resp.ok ? 'DELIVERED' : 'FAILED'}, ${record.user_id}, ${record.org_id}, ${record.ticket_id}, ${record.id}, 'lambda.amazonaws.com', ${`[practicas-alan-fn3] Webhook '${webhookEvent}' enviado a ${record.webhook_url} (HTTP ${resp.status}).`})
  `.catch(() => {});

  return {
    ok: resp.ok,
    httpStatus: resp.status,
    webhookEvent,
    fileId: record.id,
  };
};
