import { supabase } from './supabase';

export interface QuotaCheckResult {
  allowed: boolean;
  httpStatus?: number;
  code?: 'PENDING_TICKETS_QUOTA_EXCEEDED' | 'STORAGE_QUOTA_EXCEEDED';
  message?: string;
  usage: {
    currentStorageBytes: number;
    maxStorageBytes: number;
    incomingFileSizeBytes: number;
    currentPendingTickets: number;
    maxPendingTickets: number;
  };
}

/**
 * Task B.13: Validates organization-level quotas (`max_storage_bytes` and `max_pending_tickets`)
 * before issuing a new upload ticket.
 * Also supports optional test overrides (`overrideMaxStorageBytes`, `overrideMaxPendingTickets`)
 * so automated tests can deterministically verify 413/429 quota enforcement without altering production org settings.
 */
export async function checkOrganizationQuotas(
  orgId: string,
  incomingFileSizeBytes: number,
  options?: {
    overrideMaxStorageBytes?: number;
    overrideMaxPendingTickets?: number;
  }
): Promise<QuotaCheckResult> {
  // 1. Fetch organization quota limits from public.organizations
  const { data: orgRow } = await supabase
    .from('organizations')
    .select('id, name, max_storage_bytes, max_pending_tickets')
    .eq('id', orgId)
    .maybeSingle();

  const maxStorageBytes =
    options?.overrideMaxStorageBytes !== undefined
      ? Number(options.overrideMaxStorageBytes)
      : Number(orgRow?.max_storage_bytes ?? 1073741824); // Default 1 GB

  const maxPendingTickets =
    options?.overrideMaxPendingTickets !== undefined
      ? Number(options.overrideMaxPendingTickets)
      : Number(orgRow?.max_pending_tickets ?? 20); // Default 20 pending tickets

  // 2. Fetch active files for this organization
  const { data: orgFiles } = await supabase
    .from('files')
    .select('id, status, size_bytes')
    .eq('org_id', orgId)
    .in('status', ['pending_upload', 'completed', 'processed']);

  const filesList = orgFiles || [];
  const currentPendingTickets = filesList.filter((f) => f.status === 'pending_upload').length;
  const currentStorageBytes = filesList.reduce(
    (sum, f) => sum + Number(f.size_bytes || 0),
    0
  );

  const usage = {
    currentStorageBytes,
    maxStorageBytes,
    incomingFileSizeBytes,
    currentPendingTickets,
    maxPendingTickets,
  };

  if (currentPendingTickets >= maxPendingTickets) {
    return {
      allowed: false,
      httpStatus: 429,
      code: 'PENDING_TICKETS_QUOTA_EXCEEDED',
      message: `Cuota de tickets pendientes excedida para la organización '${orgRow?.name || orgId}': tiene ${currentPendingTickets} tickets en 'pending_upload' (máximo permitido: ${maxPendingTickets}). Confirma o limpia los pendientes antes de emitir otro.`,
      usage,
    };
  }

  if (currentStorageBytes + incomingFileSizeBytes > maxStorageBytes) {
    return {
      allowed: false,
      httpStatus: 413,
      code: 'STORAGE_QUOTA_EXCEEDED',
      message: `Cuota de almacenamiento excedida para la organización '${orgRow?.name || orgId}': uso actual (${currentStorageBytes} bytes) + archivo solicitado (${incomingFileSizeBytes} bytes) supera el límite máximo (${maxStorageBytes} bytes).`,
      usage,
    };
  }

  return {
    allowed: true,
    usage,
  };
}
