import { supabase } from './supabase';

export interface ServiceLog {
  id: number | string;
  timestamp: string;
  method?: string | null;
  action: string;
  status: string;
  ticketId?: string | null;
  fileId?: string | null;
  userId?: string | null;
  userName?: string | null;
  orgId?: string | null;
  orgName?: string | null;
  targetOrgId?: string | null;
  fileName?: string | null;
  extension?: string | null;
  mimeType?: string | null;
  fileSize?: number | null;
  resourceType?: string | null;
  visibility?: string | null;
  uploadUrl?: string | null;
  ipAddress?: string | null;
  message?: string | null;
  details?: any; // Kept optional for backward compatibility in UI, never stored as JSON in DB
}

/**
 * ==============================================================================
 * HISTORIAL DE ARQUITECTURA: MODELO RELACIONAL PURO (3NF / ZERO JSON)
 * ==============================================================================
 * La tabla `service_logs` almacena exclusivamente eventos de auditoría y
 * seguridad atómicos (método HTTP, acción, estado, IP, mensaje, ticket_id, file_id).
 * Toda la información de archivos, usuarios y organizaciones se resuelve
 * a través de claves foráneas relacionales en PostgreSQL (JOINs en Supabase),
 * garantizando cero redundancia y eliminación total de columnas JSON/JSONB.
 * ==============================================================================
 */

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// In-memory fallback log store
const globalForLogs = globalThis as unknown as { serviceLogs?: ServiceLog[] };
if (!globalForLogs.serviceLogs) {
  globalForLogs.serviceLogs = [];
}

/**
 * Persists an audit log event to memory and to Supabase (service_logs table)
 * completely normalized without any JSONB column.
 */
export async function addServiceLog(logInput: {
  method?: string;
  action?: string;
  status?: string;
  accion?: string;
  estado?: string;
  userId?: string;
  userName?: string;
  orgId?: string;
  orgName?: string;
  orgNombre?: string;
  targetOrgId?: string;
  ticketId?: string;
  fileId?: string;
  fileName?: string;
  ip?: string;
  ipAddress?: string;
  message?: string;
  reason?: string;
  alert?: string;
  details?: any;
  detalles?: any;
}): Promise<ServiceLog> {
  const action = logInput.action || logInput.accion || 'UNKNOWN_ACTION';
  const status = (logInput.status || logInput.estado || 'ALLOWED') as string;
  const legacyDetails = logInput.details || logInput.detalles || {};

  const method = logInput.method || legacyDetails.method || (action === 'S3_UPLOAD_CONFIRMED' ? 'PUT' : 'POST');
  const userName = logInput.userName || legacyDetails.userName || null;
  const orgName = logInput.orgName || logInput.orgNombre || legacyDetails.orgName || legacyDetails.orgNombre || null;
  const ticketId = logInput.ticketId || legacyDetails.ticketId || null;
  const fileId = logInput.fileId || legacyDetails.fileId || null;
  const ipAddress = logInput.ipAddress || logInput.ip || legacyDetails.ip || '127.0.0.1';
  const message = logInput.message || logInput.reason || logInput.alert || legacyDetails.message || legacyDetails.reason || legacyDetails.alert || null;

  const fileName = logInput.fileName || legacyDetails.fileName || legacyDetails.archivo || null;
  const extension = legacyDetails.extension || (fileName && fileName.includes('.') ? fileName.slice(fileName.lastIndexOf('.')).toLowerCase() : null);

  const logs = globalForLogs.serviceLogs || [];
  const nextLocalId = logs.length + 1;

  const newLog: ServiceLog = {
    id: nextLocalId,
    timestamp: new Date().toISOString(),
    method,
    action,
    status,
    ticketId,
    fileId,
    userId: logInput.userId || null,
    userName,
    orgId: logInput.orgId || null,
    orgName,
    targetOrgId: logInput.targetOrgId || null,
    fileName,
    extension,
    mimeType: legacyDetails.mimeType || null,
    fileSize: legacyDetails.fileSize ?? null,
    resourceType: legacyDetails.resourceType || null,
    visibility: legacyDetails.visibility || null,
    uploadUrl: legacyDetails.uploadUrl || null,
    ipAddress,
    message,
    details: legacyDetails,
  };

  // 1. Persist to Supabase (pure relational columns, NO json details)
  try {
    const validOrgId = logInput.orgId && UUID_REGEX.test(logInput.orgId) ? logInput.orgId : (logInput.targetOrgId && UUID_REGEX.test(logInput.targetOrgId) ? logInput.targetOrgId : null);
    const validUserId = logInput.userId && UUID_REGEX.test(logInput.userId) && logInput.userId !== '00000000-0000-0000-0000-000000000000' ? logInput.userId : null;
    const validFileId = fileId && UUID_REGEX.test(fileId) ? fileId : null;
    const validTicketId = ticketId && UUID_REGEX.test(ticketId) ? ticketId : null;

    const payload: Record<string, any> = {
      org_id: validOrgId,
      user_id: validUserId,
      action: newLog.action,
      status: newLog.status,
      ip_address: ipAddress,
      created_at: newLog.timestamp,
      http_method: method,
      file_id: validFileId,
      ticket_id: validTicketId,
      message: message,
    };

    let { data: insertedRow, error: insertErr } = await supabase
      .from('service_logs')
      .insert(payload)
      .select('id')
      .single();

    // Resilient fallback if ALTER TABLE hasn't been executed yet in Supabase
    if (insertErr && insertErr.message.includes('in the schema cache')) {
      console.warn('Supabase missing new columns, falling back to base columns:', insertErr.message);
      const fallbackPayload = {
        org_id: validOrgId,
        user_id: validUserId,
        action: newLog.action,
        status: newLog.status,
        ip_address: ipAddress,
        created_at: newLog.timestamp,
      };
      const retry = await supabase.from('service_logs').insert(fallbackPayload).select('id').single();
      insertedRow = retry.data;
      insertErr = retry.error;
    }

    if (!insertErr && insertedRow?.id !== undefined) {
      newLog.id = insertedRow.id;
    } else if (insertErr) {
      console.error('Error inserting log in service_logs:', insertErr.message);
    }
  } catch (err: any) {
    console.error('Error persisting log in Supabase:', err.message);
  }

  // 2. Keep in memory for immediate fallback retrieval
  logs.unshift(newLog);
  if (logs.length > 100) logs.pop();
  globalForLogs.serviceLogs = logs;

  return newLog;
}

export interface PaginatedServiceLogs {
  logs: ServiceLog[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/**
 * Fetches audit logs from Supabase (service_logs table) with pagination,
 * sorted strictly from newest to oldest (id DESC, created_at DESC).
 */
export async function getServiceLogs(options?: {
  page?: number;
  limit?: number;
}): Promise<PaginatedServiceLogs> {
  const page = Math.max(1, Number(options?.page) || 1);
  const limit = Math.max(1, Math.min(100, Number(options?.limit) || 20));
  const offset = (page - 1) * limit;

  try {
    // 1. Query service_logs with exact total count and newest first
    const { data, count, error } = await supabase
      .from('service_logs')
      .select('*', { count: 'exact' })
      .order('id', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      console.warn('Error querying service_logs from Supabase:', error.message);
      throw error;
    }

    const total = count ?? data?.length ?? 0;
    const totalPages = Math.max(1, Math.ceil(total / limit));

    if (!data || data.length === 0) {
      return {
        logs: [],
        total,
        page,
        limit,
        totalPages,
      };
    }

    // 2. Correlate with files, users, and organizations referenced in this page
    const fileIds = Array.from(new Set(data.map((r: any) => r.file_id).filter(Boolean)));
    const ticketIds = Array.from(new Set(data.map((r: any) => r.ticket_id).filter(Boolean)));
    const userIds = Array.from(new Set(data.map((r: any) => r.user_id).filter(Boolean)));
    const orgIds = Array.from(new Set(data.map((r: any) => r.org_id).filter(Boolean)));

    const [filesByIdRes, filesByTicketRes, usersRes, orgsRes] = await Promise.all([
      fileIds.length > 0
        ? supabase.from('files').select('*').in('id', fileIds)
        : Promise.resolve({ data: [] }),
      ticketIds.length > 0
        ? supabase.from('files').select('*').in('ticket_id', ticketIds)
        : Promise.resolve({ data: [] }),
      userIds.length > 0
        ? supabase.from('users').select('id, name').in('id', userIds)
        : Promise.resolve({ data: [] }),
      orgIds.length > 0
        ? supabase.from('organizations').select('id, name').in('id', orgIds)
        : Promise.resolve({ data: [] }),
    ]);

    const filesByTicket: Record<string, any> = {};
    const filesById: Record<string, any> = {};
    if (filesByIdRes.data) {
      for (const f of filesByIdRes.data as any[]) {
        if (f.id) filesById[f.id] = f;
        if (f.ticket_id) filesByTicket[f.ticket_id] = f;
      }
    }
    if (filesByTicketRes.data) {
      for (const f of filesByTicketRes.data as any[]) {
        if (f.id) filesById[f.id] = f;
        if (f.ticket_id) filesByTicket[f.ticket_id] = f;
      }
    }

    const usersById: Record<string, string> = {};
    if (usersRes.data) {
      for (const u of usersRes.data as any[]) {
        usersById[u.id] = u.name;
      }
    }

    const orgsById: Record<string, string> = {};
    if (orgsRes.data) {
      for (const o of orgsRes.data as any[]) {
        orgsById[o.id] = o.name;
      }
    }

    const logs: ServiceLog[] = data.map((row: any) => {
      const action = row.action || '';
      const status = row.status || '';
      const ticketId = row.ticket_id || row.details?.ticketId || null;
      const fileId = row.file_id || row.details?.fileId || null;
      const matchedFile = (ticketId ? filesByTicket[ticketId] : null) || (fileId ? filesById[fileId] : null);

      const userId = row.user_id || matchedFile?.user_id || null;
      const userName = (userId && usersById[userId]) || row.details?.userName || null;
      const orgId = row.org_id || matchedFile?.org_id || null;
      const orgName = (orgId && orgsById[orgId]) || row.details?.orgName || null;

      const fileName = matchedFile?.original_name || row.file_name || row.details?.fileName || null;
      const extension = matchedFile?.extension || (fileName && fileName.includes('.') ? fileName.slice(fileName.lastIndexOf('.')).toLowerCase() : null);
      const mimeType = matchedFile?.mime_type || row.details?.mimeType || null;
      const fileSize = matchedFile?.size_bytes ?? row.details?.fileSize ?? null;
      const resourceType = matchedFile?.resource_type || row.details?.resourceType || null;
      const visibility = matchedFile?.visibility || row.details?.visibility || null;
      const method = row.http_method || row.details?.method || (action === 'S3_UPLOAD_CONFIRMED' ? 'PUT' : 'POST');
      const ipAddress = row.ip_address || row.details?.ip || null;
      const message = row.message || row.details?.message || row.details?.reason || row.details?.alert || null;

      return {
        id: row.id,
        timestamp: row.created_at,
        method,
        action,
        status,
        ticketId,
        fileId: fileId || matchedFile?.id || null,
        userId,
        userName,
        orgId,
        orgName,
        targetOrgId: null,
        fileName,
        extension,
        mimeType,
        fileSize,
        resourceType,
        visibility,
        uploadUrl: null,
        ipAddress,
        message,
        details: {},
      };
    });

    return {
      logs,
      total,
      page,
      limit,
      totalPages,
    };
  } catch (err) {
    console.warn('Fallback to in-memory logs:', err);
    const inMem = globalForLogs.serviceLogs || [];
    const total = inMem.length;
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const paged = inMem.slice(offset, offset + limit);
    return {
      logs: paged,
      total,
      page,
      limit,
      totalPages,
    };
  }
}

/**
 * Clears service logs from Supabase and memory
 */
export async function clearServiceLogs(): Promise<void> {
  globalForLogs.serviceLogs = [];
  try {
    await supabase.from('service_logs').delete().not('created_at', 'is', null);
  } catch (err) {
    console.error('Error clearing logs in Supabase:', err);
  }
}

/**
 * Task B.11: Enforces the privacy/retention policy for `ip_address` in `public.service_logs`.
 * Sets `ip_address = null` for audit log rows older than `retentionDays` (default: 30 days)
 * or `retentionMinutes` (if explicitly specified for testing).
 */
export async function enforceIpAddressRetention(options?: {
  retentionDays?: number;
  retentionMinutes?: number;
  logId?: string | number;
}): Promise<{
  cutoffIso: string;
  retentionDays: number;
  anonymizedCount: number;
  anonymizedLogIds: Array<string | number>;
}> {
  const retentionDays = options?.retentionDays ?? 30;
  const retentionMs =
    options?.retentionMinutes !== undefined
      ? options.retentionMinutes * 60 * 1000
      : retentionDays * 24 * 60 * 60 * 1000;

  const cutoffIso = new Date(Date.now() - retentionMs).toISOString();

  let query: any = supabase
    .from('service_logs')
    .select('id, ip_address, created_at')
    .not('ip_address', 'is', null)
    .lte('created_at', cutoffIso)
    .limit(500);

  if (options?.logId !== undefined) {
    query = supabase
      .from('service_logs')
      .select('id, ip_address, created_at')
      .eq('id', options.logId);
  }

  const { data: rowsToAnonymize, error: fetchErr } = await query;
  if (fetchErr || !rowsToAnonymize || rowsToAnonymize.length === 0) {
    return {
      cutoffIso,
      retentionDays,
      anonymizedCount: 0,
      anonymizedLogIds: [],
    };
  }

  const ids = rowsToAnonymize.map((r: any) => r.id);
  const { error: updateErr } = await supabase
    .from('service_logs')
    .update({ ip_address: null })
    .in('id', ids);

  if (updateErr) {
    console.error('Error anonymizing ip_address in service_logs:', updateErr.message);
    return {
      cutoffIso,
      retentionDays,
      anonymizedCount: 0,
      anonymizedLogIds: [],
    };
  }

  return {
    cutoffIso,
    retentionDays,
    anonymizedCount: ids.length,
    anonymizedLogIds: ids,
  };
}

