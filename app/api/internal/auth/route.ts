import { NextRequest, NextResponse } from 'next/server';
import { pgClient } from '@/lib/postgres';
import { constantTimeEqual, requireEnv } from '@/lib/env';
import {
  deriveOrgScopedUserUuid,
  buildAutoProvisionedUserMetadata,
} from '@/lib/user-namespace';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: NextRequest) {
  const internalSecret = req.headers.get('x-internal-secret')?.trim() || '';
  const expectedSecret = requireEnv('TICKET_SIGNING_SECRET');

  if (!internalSecret || !constantTimeEqual(internalSecret, expectedSecret)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  try {
    const body = await req.json();
    const hashedKey = String(body.hashedKey || '').trim();
    const candidateUserId = String(body.candidateUserId || '').trim();

    if (!hashedKey) {
      return NextResponse.json({ ok: false, error: 'MISSING_HASHED_KEY' }, { status: 400 });
    }

    const { data: keyRecord, error: keyErr } = await pgClient
      .from('api_keys')
      .select('id,org_id,user_id,name,can_read,can_upload,can_delete,can_manage_keys,is_active')
      .eq('hashed_key', hashedKey)
      .maybeSingle();

    if (keyErr) {
      return NextResponse.json(
        { ok: false, error: keyErr.message || 'DB_KEY_ERROR' },
        { status: 500 }
      );
    }

    if (!keyRecord || !keyRecord.is_active) {
      return NextResponse.json({ ok: true, keyRecord: null, userRecord: null }, { status: 200 });
    }

    let userRecord: any = null;

    if (candidateUserId) {
      if (UUID_REGEX.test(candidateUserId)) {
        const { data: directUser } = await pgClient
          .from('users')
          .select('id,org_id,name,email,role,can_upload')
          .eq('id', candidateUserId)
          .eq('org_id', keyRecord.org_id)
          .maybeSingle();

        if (directUser) {
          userRecord = directUser;
        }
      }

      if (!userRecord) {
        const derivedUserId = await deriveOrgScopedUserUuid(keyRecord.org_id, candidateUserId);
        const { data: derivedUser } = await pgClient
          .from('users')
          .select('id,org_id,name,email,role,can_upload')
          .eq('id', derivedUserId)
          .eq('org_id', keyRecord.org_id)
          .maybeSingle();

        if (derivedUser) {
          userRecord = derivedUser;
        } else {
          const newUserMeta = buildAutoProvisionedUserMetadata(
            keyRecord.org_id,
            candidateUserId,
            derivedUserId
          );
          const { data: createdUser } = await pgClient
            .from('users')
            .insert(newUserMeta)
            .select('id,org_id,name,email,role,can_upload')
            .maybeSingle();

          userRecord = createdUser || newUserMeta;
        }
      }
    }

    return NextResponse.json(
      {
        ok: true,
        keyRecord,
        userRecord,
      },
      { status: 200 }
    );
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err?.message || 'INTERNAL_AUTH_ERROR' },
      { status: 500 }
    );
  }
}
