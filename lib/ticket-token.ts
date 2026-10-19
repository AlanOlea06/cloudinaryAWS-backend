import crypto from 'crypto';

const TICKET_SECRET = process.env.TICKET_SIGNING_SECRET || 'antigravity-cloudinary-ticket-secret-2026';
const GRACE_PERIOD_MS = 2 * 60 * 1000; // 2 minutes grace period for network latency / large uploads

/**
 * Generates an HMAC-SHA256 signature for a ticket confirmation
 * Token format: `${base64url(ticketId:userId:expiresAt)}.${hmacHex}`
 */
export function generateTicketConfirmToken(ticketId: string, userId: string, expiresAt: string): string {
  const rawPayload = `${ticketId}:${userId}:${expiresAt}`;
  const payloadB64 = Buffer.from(rawPayload, 'utf8').toString('base64url');
  const hmac = crypto
    .createHmac('sha256', TICKET_SECRET)
    .update(rawPayload)
    .digest('hex');
  return `${payloadB64}.${hmac}`;
}

/**
 * Verifies a ticket confirmation token
 * Validates HMAC integrity, user/ticket binding, and TTL expiration (with 2-minute grace window)
 */
export function verifyTicketConfirmToken(
  token: string,
  ticketId: string,
  userId: string
): { valid: boolean; reason?: string; expiresAt?: string } {
  if (!token || typeof token !== 'string') {
    return { valid: false, reason: 'TOKEN_MISSING' };
  }

  const parts = token.split('.');
  if (parts.length !== 2) {
    return { valid: false, reason: 'TOKEN_MALFORMED' };
  }

  const [payloadB64, receivedHmac] = parts;
  let decodedPayload = '';
  try {
    decodedPayload = Buffer.from(payloadB64, 'base64url').toString('utf8');
  } catch {
    return { valid: false, reason: 'PAYLOAD_MALFORMED' };
  }

  const payloadParts = decodedPayload.split(':');
  if (payloadParts.length < 3) {
    return { valid: false, reason: 'PAYLOAD_INVALID' };
  }

  const tokenTicketId = payloadParts[0];
  const tokenUserId = payloadParts[1];
  const expiresAt = payloadParts.slice(2).join(':'); // Handles ISO timestamp colons cleanly

  if (tokenTicketId !== ticketId || tokenUserId !== userId) {
    return { valid: false, reason: 'TOKEN_MISMATCH' };
  }

  const expectedHmac = crypto
    .createHmac('sha256', TICKET_SECRET)
    .update(decodedPayload)
    .digest('hex');

  // Constant-time comparison to prevent timing attacks
  const receivedBuf = Buffer.from(receivedHmac, 'hex');
  const expectedBuf = Buffer.from(expectedHmac, 'hex');

  if (receivedBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(receivedBuf, expectedBuf)) {
    return { valid: false, reason: 'SIGNATURE_INVALID' };
  }

  // Check expiration + grace period
  const expirationTime = new Date(expiresAt).getTime();
  if (isNaN(expirationTime)) {
    return { valid: false, reason: 'INVALID_EXPIRATION_DATE' };
  }

  const now = Date.now();
  if (now > expirationTime + GRACE_PERIOD_MS) {
    return { valid: false, reason: 'TOKEN_EXPIRED', expiresAt };
  }

  return { valid: true, expiresAt };
}
