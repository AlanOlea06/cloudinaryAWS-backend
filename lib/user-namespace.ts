/**
 * Deterministic Multi-Tenant User Namespace Hashing (UUID v5-style over SHA-256).
 *
 * Ensures that any external user identifier sent by a client platform in `x-user-id`
 * (e.g. "1", "42", "user_abc", "juan@empresa.com", or an external UUID) is mapped
 * deterministically to a valid RFC 4122 UUID v4/v5 scoped strictly to `orgId`:
 *
 *   internalUserId = UUID_SHA256(orgId + ":" + externalUserId)
 *
 * Properties:
 * 1. Zero collisions across organizations: Org A's user "1" and Org B's user "1"
 *    always produce completely different internal UUIDs because `orgId` differs.
 * 2. Deterministic within the same organization: Every time Org A sends `x-user-id: 1`,
 *    it resolves to the exact same internal UUID, preserving ownership of private files.
 * 3. Compatible with both Next.js Edge Runtime (Web Crypto API) and Node.js.
 */

export const UUID_V4_OR_NAMESPACE_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validates that a raw `x-user-id` string is non-empty and within safe length limits (1..128 chars).
 */
export function isValidExternalUserId(rawUserId: string): boolean {
  const clean = String(rawUserId || '').trim();
  if (!clean || clean.length > 128) {
    return false;
  }
  // Block control characters
  return !/[\x00-\x1f\x7f]/.test(clean);
}

/**
 * Computes a deterministic RFC 4122 UUID derived from `(orgId, externalUserId)` using SHA-256.
 * Works in both Edge Runtime (`crypto.subtle`) and Node.js.
 */
export async function deriveOrgScopedUserUuid(
  orgId: string,
  externalUserId: string
): Promise<string> {
  const cleanOrgId = String(orgId || '').trim().toLowerCase();
  const cleanExternal = String(externalUserId || '').trim();
  const canonicalInput = `cloudinary-org-user-v1:${cleanOrgId}:${cleanExternal}`;

  const encoder = new TextEncoder();
  const data = encoder.encode(canonicalInput);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(hashBuffer).slice(0, 16);

  // Set RFC 4122 version (4) and variant (10xx) bits so strict UUID v4 validators accept it
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  return (
    `${hex.slice(0, 8)}-` +
    `${hex.slice(8, 12)}-` +
    `${hex.slice(12, 16)}-` +
    `${hex.slice(16, 20)}-` +
    `${hex.slice(20, 32)}`
  );
}

/**
 * Builds anonymous, privacy-preserving user metadata for Just-In-Time (JIT) user provisioning.
 * Avoids storing unnecessary PII while keeping database constraints satisfied.
 */
export function buildAutoProvisionedUserMetadata(
  orgId: string,
  externalUserId: string,
  derivedUuid: string
): {
  id: string;
  org_id: string;
  name: string;
  email: string;
  role: string;
  can_upload: boolean;
} {
  const cleanExternal = String(externalUserId || '')
    .trim()
    .replace(/[^\w.@+-]/g, '_')
    .slice(0, 40);
  const orgPrefix = String(orgId || '').trim().slice(0, 8).toLowerCase();
  const uuidPrefix = derivedUuid.replace(/-/g, '').slice(0, 12).toLowerCase();

  return {
    id: derivedUuid,
    org_id: orgId,
    name: `User ${cleanExternal || uuidPrefix.slice(0, 8)}`,
    email: `u-${uuidPrefix}@${orgPrefix}.tenant.local`,
    role: 'client',
    can_upload: true,
  };
}
