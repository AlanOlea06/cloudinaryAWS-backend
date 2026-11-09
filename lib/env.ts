/**
 * Central environment variable validation and zero-downtime secret rotation helpers.
 * Compatible with both Node.js Serverless Runtime and Next.js Edge Runtime (Middleware).
 *
 * Security Rules:
 * - Zero fallback secrets or default URLs in code.
 * - Every runtime read throws an explicit error if the mandatory variable is missing.
 * - Supports zero-downtime rotation for TICKET_SIGNING_SECRET and ADMIN_API_SECRET
 *   via *_PREVIOUS variables.
 */

export const MANDATORY_ENV_VARS = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_REGION',
  'AWS_S3_BUCKET_NAME',
  'AWS_CLOUDFRONT_DOMAIN',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'TICKET_SIGNING_SECRET',
  'ADMIN_API_SECRET',
  'CRON_SECRET',
] as const;

export type MandatoryEnvVarName = (typeof MANDATORY_ENV_VARS)[number];

/**
 * Reads a mandatory environment variable at runtime.
 * Throws a clear error immediately if the variable is undefined or empty.
 */
export function requireEnv(name: MandatoryEnvVarName | string): string {
  const val = process.env[name];
  if (typeof val !== 'string' || val.trim().length === 0) {
    throw new Error(
      `[ENV_MISSING] Falta la variable de entorno obligatoria '${name}'. No existen valores por defecto.`
    );
  }
  return val.trim();
}

/**
 * Reads an optional environment variable (e.g., *_PREVIOUS rotation secrets).
 */
function getOptionalEnv(name: string): string | null {
  const val = process.env[name];
  if (typeof val !== 'string' || val.trim().length === 0) {
    return null;
  }
  return val.trim();
}

/**
 * Constant-time string comparison compatible with both Edge Runtime and Node.js.
 * Prevents timing side-channel attacks when comparing secrets or HMAC signatures.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);

  const maxLen = Math.max(aBytes.length, bBytes.length);
  let diff = aBytes.length ^ bBytes.length;

  for (let i = 0; i < maxLen; i++) {
    const byteA = i < aBytes.length ? aBytes[i] : 0;
    const byteB = i < bBytes.length ? bBytes[i] : 0;
    diff |= byteA ^ byteB;
  }

  return diff === 0 && aBytes.length > 0;
}

/**
 * Returns the active ticket signing secret and optional previous secret for rotation.
 * - Sign new tickets exclusively with `current` (TICKET_SIGNING_SECRET).
 * - Verify existing tickets against `all` ([TICKET_SIGNING_SECRET, TICKET_SIGNING_SECRET_PREVIOUS]).
 */
export function getTicketSigningSecrets(): {
  current: string;
  previous: string | null;
  all: string[];
} {
  const current = requireEnv('TICKET_SIGNING_SECRET');
  const previous = getOptionalEnv('TICKET_SIGNING_SECRET_PREVIOUS');
  const all = previous && previous !== current ? [current, previous] : [current];
  return { current, previous, all };
}

/**
 * Returns the active admin API secret and optional previous secret for rotation.
 */
function getAdminApiSecrets(): {
  current: string;
  previous: string | null;
  all: string[];
} {
  const current = requireEnv('ADMIN_API_SECRET');
  const previous = getOptionalEnv('ADMIN_API_SECRET_PREVIOUS');
  const all = previous && previous !== current ? [current, previous] : [current];
  return { current, previous, all };
}

/**
 * Extracts and verifies ADMIN_API_SECRET (or ADMIN_API_SECRET_PREVIOUS) from request headers.
 * Accepts either `x-admin-secret: <secret>` or `Authorization: Bearer <secret>`.
 */
export function verifyAdminSecretHeader(headers: Headers): {
  valid: boolean;
  status: 200 | 401 | 403;
  code?: string;
  message?: string;
  usedPreviousSecret?: boolean;
} {
  const directHeader = headers.get('x-admin-secret')?.trim() || '';
  const authHeader = headers.get('authorization')?.trim() || '';
  let candidate = directHeader;

  if (!candidate && authHeader.toLowerCase().startsWith('bearer ')) {
    candidate = authHeader.slice(7).trim();
  }

  if (!candidate) {
    return {
      valid: false,
      status: 401,
      code: 'MISSING_ADMIN_SECRET',
      message:
        'Autenticación administrativa requerida. Envía la cabecera x-admin-secret o Authorization: Bearer <ADMIN_API_SECRET>.',
    };
  }

  const { current, previous } = getAdminApiSecrets();

  if (constantTimeEqual(candidate, current)) {
    return { valid: true, status: 200, usedPreviousSecret: false };
  }

  if (previous && constantTimeEqual(candidate, previous)) {
    return { valid: true, status: 200, usedPreviousSecret: true };
  }

  return {
    valid: false,
    status: 403,
    code: 'INVALID_ADMIN_SECRET',
    message: 'Credencial administrativa (ADMIN_API_SECRET) inválida.',
  };
}

/**
 * Extracts and verifies CRON_SECRET from `Authorization: Bearer <CRON_SECRET>`.
 */
export function verifyCronSecretHeader(headers: Headers): {
  valid: boolean;
  status: 200 | 401 | 403;
  code?: string;
  message?: string;
} {
  const authHeader = headers.get('authorization')?.trim() || '';
  if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) {
    return {
      valid: false,
      status: 401,
      code: 'MISSING_CRON_SECRET',
      message: 'Autenticación de Cron requerida (Authorization: Bearer <CRON_SECRET>).',
    };
  }

  const candidate = authHeader.slice(7).trim();
  if (!candidate) {
    return {
      valid: false,
      status: 401,
      code: 'MISSING_CRON_SECRET',
      message: 'El token Bearer para Cron está vacío.',
    };
  }

  const expected = requireEnv('CRON_SECRET');
  if (!constantTimeEqual(candidate, expected)) {
    return {
      valid: false,
      status: 403,
      code: 'INVALID_CRON_SECRET',
      message: 'CRON_SECRET inválido.',
    };
  }

  return { valid: true, status: 200 };
}

/**
 * Verifies the organization registration invite code (`x-invite-code` header or `inviteCode` in body)
 * against `ORG_INVITE_CODE` (or `ADMIN_API_SECRET` if an admin registers the organization).
 */
export function verifyOrgInviteCode(
  headers: Headers,
  bodyInviteCode?: string | null
): {
  valid: boolean;
  status: 200 | 401 | 403;
  code?: string;
  message?: string;
} {
  // Admin secret always authorizes organization creation
  const adminCheck = verifyAdminSecretHeader(headers);
  if (adminCheck.valid) {
    return { valid: true, status: 200 };
  }

  const candidate = (
    headers.get('x-invite-code') ||
    bodyInviteCode ||
    ''
  ).trim();

  if (!candidate) {
    return {
      valid: false,
      status: 401,
      code: 'MISSING_INVITE_CODE',
      message:
        'Para registrar una nueva organización debes proporcionar el código de invitación en el campo inviteCode o en la cabecera x-invite-code.',
    };
  }

  const configuredInviteCode = getOptionalEnv('ORG_INVITE_CODE');
  const { current: adminSecret, previous: prevAdminSecret } = getAdminApiSecrets();

  if (configuredInviteCode && constantTimeEqual(candidate, configuredInviteCode)) {
    return { valid: true, status: 200 };
  }

  if (constantTimeEqual(candidate, adminSecret)) {
    return { valid: true, status: 200 };
  }

  if (prevAdminSecret && constantTimeEqual(candidate, prevAdminSecret)) {
    return { valid: true, status: 200 };
  }

  return {
    valid: false,
    status: 403,
    code: 'INVALID_INVITE_CODE',
    message: 'El código de invitación (inviteCode) proporcionado no es válido.',
  };
}
