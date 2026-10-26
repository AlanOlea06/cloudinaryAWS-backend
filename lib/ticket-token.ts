import crypto from 'crypto';
import { constantTimeEqual, getTicketSigningSecrets } from '@/lib/env';

const GRACE_PERIOD_MS = 2 * 60 * 1000; // 2 minutes grace period for network latency / large uploads

/**
 * Generates an HMAC-SHA256 signature for a ticket confirmation using TICKET_SIGNING_SECRET.
 * Token format: `${base64url(ticketId:userId:expiresAt)}.${hmacHex}`
 * Throws immediately if TICKET_SIGNING_SECRET is missing (zero fallback secrets).
 */
export function generateTicketConfirmToken(
  ticketId: string,
  userId: string,
  expiresAt: string
): string {
  const { current } = getTicketSigningSecrets();
  const rawPayload = `${ticketId}:${userId}:${expiresAt}`;
  const payloadB64 = Buffer.from(rawPayload, 'utf8').toString('base64url');
  const hmac = crypto
    .createHmac('sha256', current)
    .update(rawPayload)
    .digest('hex');
  return `${payloadB64}.${hmac}`;
}

/**
 * Verifies a ticket confirmation token against TICKET_SIGNING_SECRET and, if configured,
 * TICKET_SIGNING_SECRET_PREVIOUS (zero-downtime secret rotation).
 * Validates HMAC integrity, user/ticket binding, and TTL expiration (with 2-minute grace window).
 */
export function verifyTicketConfirmToken(
  token: string,
  ticketId: string,
  userId: string
): {
  valid: boolean;
  reason?: string;
  expiresAt?: string;
  usedPreviousSecret?: boolean;
} {
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
    decodedPayload = Buffer.from(payloadB64, 'utf8').toString('utf8');
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
  const expiresAt = payloadParts.slice(2).join(':');

  if (tokenTicketId !== ticketId || tokenUserId !== userId) {
    return { valid: false, reason: 'TOKEN_MISMATCH' };
  }

  const { current, previous } = getTicketSigningSecrets();
  const normalizedReceived = receivedHmac.trim().toLowerCase();

  const expectedCurrentHmac = crypto
    .createHmac('sha256', current)
    .update(decodedPayload)
    .digest('hex')
    .toLowerCase();

  let matched = constantTimeEqual(normalizedReceived, expectedCurrentHmac);
  let usedPreviousSecret = false;

  if (!matched && previous) {
    const expectedPreviousHmac = crypto
      .createHmac('sha256', previous)
      .update(decodedPayload)
      .digest('hex')
      .toLowerCase();
    if (constantTimeEqual(normalizedReceived, expectedPreviousHmac)) {
      matched = true;
      usedPreviousSecret = true;
    }
  }

  if (!matched) {
    return { valid: false, reason: 'SIGNATURE_INVALID' };
  }

  const expirationTime = new Date(expiresAt).getTime();
  if (isNaN(expirationTime)) {
    return { valid: false, reason: 'INVALID_EXPIRATION_DATE' };
  }

  const now = Date.now();
  if (now > expirationTime + GRACE_PERIOD_MS) {
    return { valid: false, reason: 'TOKEN_EXPIRED', expiresAt };
  }

  return { valid: true, expiresAt, usedPreviousSecret };
}
