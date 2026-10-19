import crypto from 'crypto';

const TICKET_SECRET = process.env.TICKET_SIGNING_SECRET || 'antigravity-cloudinary-ticket-secret-2026';
const GRACE_PERIOD_MS = 2 * 60 * 1000; // 2 minutes grace period for network latency / large uploads

/**
 * Generates an HMAC-SHA256 signature for a ticket confirmation
 * Token format: `${expiresAt}.${hmacHex}`
 */
export function generateTicketConfirmToken(ticketId: string, userId: string, expiresAt: string): string {
  const payload = `${ticketId}:${userId}:${expiresAt}`;
  const hmac = crypto
    .createHmac('sha256', TICKET_SECRET)
    .update(payload)
    .digest('hex');
  return `${expiresAt}.${hmac}`;
}

/**
 * Verifies a ticket confirmation token
 * Validates HMAC integrity and TTL expiration (with 2-minute grace window)
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

  const [expiresAt, receivedHmac] = parts;
  const payload = `${ticketId}:${userId}:${expiresAt}`;
  const expectedHmac = crypto
    .createHmac('sha256', TICKET_SECRET)
    .update(payload)
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
