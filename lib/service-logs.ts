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
  details: any;
  // Backward compatibility fields
  accion?: string;
  estado?: string;
  orgNombre?: string;
  detalles?: any;
}

/**
 * ==============================================================================
 * HISTORIAL DE ARQUITECTURA: TRANSICIÓN DE MOCKS A SUPABASE EN TIEMPO REAL
 * ==============================================================================
 * Durante las fases iniciales del prototipo (Fase 1.1 a 1.4), se utilizaron
 * diccionarios constantes en memoria (ORGANIZATIONS y USERS) para validar
 * las reglas de negocio (RBAC y Aislamiento Multi-Tenant) de manera local.
 *
 * En la fase de endurecimiento y producción, todos los datos estáticos fueron
 * completamente eliminados y reemplazados al 100% por consultas relacionales
 * directas a las tablas `public.users` y `public.organizations` en Supabase,
 * tanto en el endpoint de validación (POST /api/upload) como en el de catálogo
 * (GET /api/users).
 * ==============================================================================
 */

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// In-memory fallback log store
const globalForLogs = globalThis as unknown as { serviceLogs?: ServiceLog[] };
if (!globalForLogs.serviceLogs) {
  globalForLogs.serviceLogs = [];
}

/**
 * Persists an audit log event to memory and to Supabase (service_logs table with fallback to logs_servicio)
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
  details?: any;
  detalles?: any;
}): Promise<ServiceLog> {
  const action = logInput.action || logInput.accion || 'UNKNOWN_ACTION';
  const status = (logInput.status || logInput.estado || 'ALLOWED') as string;
  const details = logInput.details || logInput.detalles || {};
  const method = logInput.method || details.method || (action === 'S3_UPLOAD_CONFIRMED' ? 'PUT' : 'POST');
  const userName = logInput.userName || details.userName || null;
  const orgName = logInput.orgName || logInput.orgNombre || details.orgName || details.orgNombre || null;
  const fileName = details.fileName || details.archivo || null;
  const extension = details.extension || (fileName && fileName.includes('.') ? fileName.slice(fileName.lastIndexOf('.')).toLowerCase() : null);

  const enrichedDetails = {
    ...details,
    method,
    userName,
    orgName,
    extension,
  };

  const logs = globalForLogs.serviceLogs || [];
  const nextLocalId = logs.length + 1;

  const newLog: ServiceLog = {
    id: nextLocalId,
    timestamp: new Date().toISOString(),
    method,
    action,
    status,
    ticketId: details.ticketId || null,
    fileId: details.fileId || null,
    userId: logInput.userId || null,
    userName,
    orgId: logInput.orgId || null,
    orgName,
    targetOrgId: logInput.targetOrgId || null,
    fileName,
    extension,
    mimeType: details.mimeType || null,
    fileSize: details.fileSize ?? null,
    resourceType: details.resourceType || null,
    visibility: details.visibility || null,
    uploadUrl: details.uploadUrl || null,
    s3Landing: details.s3Landing || null,
    s3Permanent: details.s3Permanent || null,
    ipAddress: details.ip || null,
    message: details.message || details.reason || details.alert || null,
    details: enrichedDetails,
    accion: action,
    estado: status,
    orgNombre: orgName || undefined,
    detalles: enrichedDetails,
  };

  // 1. Persist to Supabase (letting PostgreSQL generate sequential numeric id)
  try {
    const validOrgId = logInput.orgId && UUID_REGEX.test(logInput.orgId) ? logInput.orgId : (logInput.targetOrgId && UUID_REGEX.test(logInput.targetOrgId) ? logInput.targetOrgId : null);
    const validUserId = logInput.userId && UUID_REGEX.test(logInput.userId) && logInput.userId !== '00000000-0000-0000-0000-000000000000' ? logInput.userId : null;

    // Try primary English table: service_logs
    const { data: insertedRow, error: englishErr } = await supabase
      .from('service_logs')
      .insert({
        org_id: validOrgId,
        user_id: validUserId,
        action: newLog.action,
        status: newLog.status,
        file_name: fileName,
        details: enrichedDetails,
        ip_address: details.ip || '127.0.0.1',
        created_at: newLog.timestamp,
      })
      .select('id')
      .single();

    if (!englishErr && insertedRow?.id !== undefined) {
      newLog.id = insertedRow.id;
    } else if (englishErr) {
      // Fallback if table is still logs_servicio
      const { data: fallbackRow } = await supabase
        .from('logs_servicio')
        .insert({
          org_id: validOrgId,
          user_id: validUserId,
          accion: newLog.action,
          estado: newLog.status,
          detalles: enrichedDetails,
          ip_origen: details.ip || '127.0.0.1',
          created_at: newLog.timestamp,
        })
        .select('id')
        .single();

      if (fallbackRow?.id !== undefined) {
        newLog.id = fallbackRow.id;
      }
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
 * Fetches recent audit logs from Supabase (service_logs or logs_servicio) and correlates with files table
 */
export async function getServiceLogs(): Promise<ServiceLog[]> {
  try {
    // 1. Query English table: service_logs
    let { data, error } = await supabase
      .from('service_logs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100);

    // 2. Fallback to Spanish table if not yet migrated
    if (error) {
      const fallback = await supabase
        .from('logs_servicio')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(100);

      data = fallback.data;
      error = fallback.error;
    }

    // 3. Query files table to correlate real ticket metadata stored in Supabase
    const filesByTicket: Record<string, any> = {};
    try {
      const { data: filesData } = await supabase
        .from('files')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(100);

      if (filesData) {
        for (const f of filesData) {
          if (f.ticket_id) filesByTicket[f.ticket_id] = f;
        }
      }
    } catch {
      // Ignore if files table query fails
    }

    if (!error && data && data.length > 0) {
      return data.map((row: any) => {
        const action = row.action || row.accion || '';
        const status = row.status || row.estado || '';
        const details = row.details || row.detalles || {};
        const ticketId = details.ticketId || row.ticket_id || null;
        const matchedFile = ticketId ? filesByTicket[ticketId] : null;

        const userId = row.user_id || matchedFile?.user_id || details.userId || null;
        const userName = details.userName || null;
        const orgId = row.org_id || matchedFile?.org_id || details.orgId || null;
        const orgName = details.orgName || details.orgNombre || null;
        const fileName = row.file_name || details.fileName || matchedFile?.original_name || matchedFile?.nombre_original || null;
        const extension = details.extension || matchedFile?.extension || (fileName && fileName.includes('.') ? fileName.slice(fileName.lastIndexOf('.')).toLowerCase() : null);
        const mimeType = details.mimeType || matchedFile?.mime_type || matchedFile?.formato || null;
        const fileSize = details.fileSize ?? matchedFile?.size_bytes ?? matchedFile?.tamano_bytes ?? null;
        const resourceType = details.resourceType || matchedFile?.resource_type || matchedFile?.tipo_recurso || null;
        const visibility = details.visibility || matchedFile?.visibility || matchedFile?.visibilidad || null;
        const uploadUrl = details.uploadUrl || null;
        const s3Landing = details.s3Landing || matchedFile?.s3_pending_key || matchedFile?.s3_key_pendiente || null;
        const s3Permanent = details.s3Permanent || matchedFile?.s3_processed_key || matchedFile?.s3_key_procesado || null;
        const method = details.method || (action === 'S3_UPLOAD_CONFIRMED' ? 'PUT' : 'POST');
        const ipAddress = row.ip_address || row.ip_origen || details.ip || null;
        const message = details.message || details.reason || details.alert || null;

        return {
          id: row.id,
          timestamp: row.created_at,
          method,
          action,
          status,
          ticketId,
          fileId: details.fileId || matchedFile?.id || null,
          userId,
          userName,
          orgId,
          orgName,
          targetOrgId: details.targetOrgId || null,
          fileName,
          extension,
          mimeType,
          fileSize,
          resourceType,
          visibility,
          uploadUrl,
          s3Landing,
          s3Permanent,
          ipAddress,
          message,
          details,
          accion: action,
          estado: status,
          orgNombre: orgName || undefined,
          detalles: details,
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
    await supabase.from('logs_servicio').delete().not('created_at', 'is', null);
  } catch (err) {
    console.error('Error clearing logs in Supabase:', err);
  }
}
