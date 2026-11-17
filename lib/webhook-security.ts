import crypto from 'crypto';
import dns from 'dns/promises';
import net from 'net';

function isPrivateOrReservedIp(ip: string): boolean {
  const clean = ip.trim().toLowerCase();
  if (!clean) return true;

  const v4MappedMatch = clean.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  const target = v4MappedMatch ? v4MappedMatch[1] : clean;

  if (net.isIPv4(target)) {
    const parts = target.split('.').map(Number);
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }

  if (net.isIPv6(target)) {
    if (
      target === '::1' ||
      target === '::' ||
      target.startsWith('fc') ||
      target.startsWith('fd') ||
      target.startsWith('fe80')
    ) {
      return true;
    }
    return false;
  }

  return true;
}

export async function validateWebhookUrlSSRF(
  rawUrl: string
): Promise<{ safe: boolean; error?: string }> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { safe: false, error: 'INVALID_WEBHOOK_URL_FORMAT' };
  }

  if (parsed.protocol !== 'https:') {
    return { safe: false, error: 'WEBHOOK_HTTPS_REQUIRED' };
  }

  const hostname = parsed.hostname.toLowerCase();
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal')
  ) {
    return { safe: false, error: 'SSRF_LOCAL_HOSTNAME_BLOCKED' };
  }

  if (net.isIP(hostname)) {
    if (isPrivateOrReservedIp(hostname)) {
      return { safe: false, error: 'SSRF_PRIVATE_IP_BLOCKED' };
    }
    return { safe: true };
  }

  try {
    const addresses = await dns.lookup(hostname, { all: true });
    if (!addresses || addresses.length === 0) {
      return { safe: false, error: 'WEBHOOK_DNS_UNRESOLVABLE' };
    }
    for (const addr of addresses) {
      if (isPrivateOrReservedIp(addr.address)) {
        return { safe: false, error: 'SSRF_DNS_REBINDING_PRIVATE_IP_BLOCKED' };
      }
    }
  } catch {
    return { safe: false, error: 'WEBHOOK_DNS_LOOKUP_FAILED' };
  }

  return { safe: true };
}

export function verifyWebhookSignature(
  rawBody: string,
  timestampHeader: string,
  signatureHeader: string,
  secret: string,
  toleranceSeconds: number = 300
): boolean {
  if (!signatureHeader || !secret) {
    return false;
  }

  const parts = signatureHeader.split(',').map((p) => p.trim());
  const tPart = parts.find((p) => p.startsWith('t='));
  const v1Part = parts.find((p) => p.startsWith('v1='));

  const timestamp = tPart ? Number(tPart.slice(2)) : Number(timestampHeader);
  const receivedSig = v1Part ? v1Part.slice(3) : signatureHeader.replace(/^sha256=/, '');

  if (Number.isFinite(timestamp) && toleranceSeconds > 0) {
    const nowSec = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSec - timestamp) > toleranceSeconds) {
      return false;
    }
  }

  const signedPayload = Number.isFinite(timestamp)
    ? `${timestamp}.${rawBody}`
    : rawBody;

  const expectedSig = crypto
    .createHmac('sha256', secret)
    .update(signedPayload)
    .digest('hex');

  const a = Buffer.from(receivedSig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return false;
  }

  return true;
}
