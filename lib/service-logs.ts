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
  s3Landing?: string | null;
  s3Permanent?: string | null;
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
    s3Landing: legacyDetails.s3Landing || null,
    s3Permanent: legacyDetails.s3Permanent || null,
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

/**
 * Fetches recent audit logs from Supabase (service_logs table) and correlates with files, users, and organizations
 */
export async function getServiceLogs(): Promise<ServiceLog[]> {
  try {
    // 1. Query service_logs
    const { data, error } = await supabase
      .from('service_logs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100);

    // 2. Correlate with files, users, and organizations in parallel
    const [filesRes, usersRes, orgsRes] = await Promise.all([
      supabase.from('files').select('*').limit(100),
      supabase.from('users').select('id, name').limit(100),
      supabase.from('organizations').select('id, name').limit(100),
    ]);

    const filesByTicket: Record<string, any> = {};
    const filesById: Record<string, any> = {};
    if (filesRes.data) {
      for (const f of filesRes.data) {
        if (f.ticket_id) filesByTicket[f.ticket_id] = f;
        if (f.id) filesById[f.id] = f;
      }
    }

    const usersById: Record<string, string> = {};
    if (usersRes.data) {
      for (const u of usersRes.data) {
        usersById[u.id] = u.name;
      }
    }

    const orgsById: Record<string, string> = {};
    if (orgsRes.data) {
      for (const o of orgsRes.data) {
        orgsById[o.id] = o.name;
      }
    }

    if (!error && data && data.length > 0) {
      return data.map((row: any) => {
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
        const s3Landing = matchedFile?.s3_pending_key || row.details?.s3Landing || null;
        const s3Permanent = matchedFile?.s3_processed_key || row.details?.s3Permanent || null;
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
          s3Landing,
          s3Permanent,
          ipAddress,
          message,
          details: {},
        };
      });
    }
  } catch (err) {
    console.warn('Fallback to in-memory logs:', err);
  }

  return globalForLogs.serviceLogs || [];
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
