import { supabase } from './supabase';

export interface ServiceLog {
  id: string;
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

export interface MockUser {
  id: string;
  orgId: string;
  name: string;
  email: string;
  role: 'admin' | 'editor' | 'viewer';
  canUpload: boolean;
  // Backward compatibility fields
  nombre?: string;
  rol?: string;
  puede_subir?: boolean;
}

export interface MockOrg {
  id: string;
  name: string;
  slug: string;
  // Backward compatibility fields
  nombre?: string;
}

export const ORGANIZATIONS: Record<string, MockOrg> = {
  '11111111-1111-1111-1111-111111111111': {
    id: '11111111-1111-1111-1111-111111111111',
    name: 'Organization 1',
    nombre: 'Organization 1',
    slug: 'organization_1',
  },
  '22222222-2222-2222-2222-222222222222': {
    id: '22222222-2222-2222-2222-222222222222',
    name: 'Organization 2',
    nombre: 'Organization 2',
    slug: 'organization_2',
  },
};

export const USERS: Record<string, MockUser> = {
  // Organization 1 (10 members)
  'a1111111-0000-0000-0000-000000000001': { id: 'a1111111-0000-0000-0000-000000000001', orgId: '11111111-1111-1111-1111-111111111111', name: 'Carlos Mendoza', nombre: 'Carlos Mendoza', email: 'carlos.mendoza@org1.com', role: 'admin', rol: 'admin', canUpload: true, puede_subir: true },
  'a1111111-0000-0000-0000-000000000002': { id: 'a1111111-0000-0000-0000-000000000002', orgId: '11111111-1111-1111-1111-111111111111', name: 'Ana Beltran', nombre: 'Ana Beltran', email: 'ana.beltran@org1.com', role: 'editor', rol: 'editor', canUpload: true, puede_subir: true },
  'a1111111-0000-0000-0000-000000000003': { id: 'a1111111-0000-0000-0000-000000000003', orgId: '11111111-1111-1111-1111-111111111111', name: 'Roberto Morales', nombre: 'Roberto Morales', email: 'roberto.morales@org1.com', role: 'editor', rol: 'editor', canUpload: true, puede_subir: true },
  'a1111111-0000-0000-0000-000000000004': { id: 'a1111111-0000-0000-0000-000000000004', orgId: '11111111-1111-1111-1111-111111111111', name: 'Lucia Vega', nombre: 'Lucia Vega', email: 'lucia.vega@org1.com', role: 'editor', rol: 'editor', canUpload: true, puede_subir: true },
  'a1111111-0000-0000-0000-000000000005': { id: 'a1111111-0000-0000-0000-000000000005', orgId: '11111111-1111-1111-1111-111111111111', name: 'Diego Solis', nombre: 'Diego Solis', email: 'diego.solis@org1.com', role: 'editor', rol: 'editor', canUpload: true, puede_subir: true },
  'a1111111-0000-0000-0000-000000000006': { id: 'a1111111-0000-0000-0000-000000000006', orgId: '11111111-1111-1111-1111-111111111111', name: 'Elena Castillo', nombre: 'Elena Castillo', email: 'elena.castillo@org1.com', role: 'editor', rol: 'editor', canUpload: true, puede_subir: true },
  'a1111111-0000-0000-0000-000000000007': { id: 'a1111111-0000-0000-0000-000000000007', orgId: '11111111-1111-1111-1111-111111111111', name: 'Javier Ramos', nombre: 'Javier Ramos', email: 'javier.ramos@org1.com', role: 'editor', rol: 'editor', canUpload: true, puede_subir: true },
  'a1111111-0000-0000-0000-000000000008': { id: 'a1111111-0000-0000-0000-000000000008', orgId: '11111111-1111-1111-1111-111111111111', name: 'Sofia Pineda', nombre: 'Sofia Pineda', email: 'sofia.pineda@org1.com', role: 'editor', rol: 'editor', canUpload: true, puede_subir: true },
  'a1111111-0000-0000-0000-000000000009': { id: 'a1111111-0000-0000-0000-000000000009', orgId: '11111111-1111-1111-1111-111111111111', name: 'Fernando Ortiz', nombre: 'Fernando Ortiz', email: 'fernando.ortiz@org1.com', role: 'editor', rol: 'editor', canUpload: true, puede_subir: true },
  'a1111111-0000-0000-0000-000000000010': { id: 'a1111111-0000-0000-0000-000000000010', orgId: '11111111-1111-1111-1111-111111111111', name: 'Valeria Ruiz (Viewer)', nombre: 'Valeria Ruiz (Sin Permiso)', email: 'valeria.ruiz@org1.com', role: 'viewer', rol: 'visitante', canUpload: false, puede_subir: false },

  // Organization 2 (5 members)
  'b2222222-0000-0000-0000-000000000001': { id: 'b2222222-0000-0000-0000-000000000001', orgId: '22222222-2222-2222-2222-222222222222', name: 'Mateo Delgado', nombre: 'Mateo Delgado', email: 'mateo.delgado@org2.com', role: 'admin', rol: 'admin', canUpload: true, puede_subir: true },
  'b2222222-0000-0000-0000-000000000002': { id: 'b2222222-0000-0000-0000-000000000002', orgId: '22222222-2222-2222-2222-222222222222', name: 'Camila Herrera', nombre: 'Camila Herrera', email: 'camila.herrera@org2.com', role: 'editor', rol: 'editor', canUpload: true, puede_subir: true },
  'b2222222-0000-0000-0000-000000000003': { id: 'b2222222-0000-0000-0000-000000000003', orgId: '22222222-2222-2222-2222-222222222222', name: 'Andres Navarro', nombre: 'Andres Navarro', email: 'andres.navarro@org2.com', role: 'editor', rol: 'editor', canUpload: true, puede_subir: true },
  'b2222222-0000-0000-0000-000000000004': { id: 'b2222222-0000-0000-0000-000000000004', orgId: '22222222-2222-2222-2222-222222222222', name: 'Paula Cardenas', nombre: 'Paula Cardenas', email: 'paula.cardenas@org2.com', role: 'editor', rol: 'editor', canUpload: true, puede_subir: true },
  'b2222222-0000-0000-0000-000000000005': { id: 'b2222222-0000-0000-0000-000000000005', orgId: '22222222-2222-2222-2222-222222222222', name: 'Gabriel Fuentes (Viewer)', nombre: 'Gabriel Fuentes (Sin Permiso)', email: 'gabriel.fuentes@org2.com', role: 'viewer', rol: 'visitante', canUpload: false, puede_subir: false },
};

// Backward-compatible alias exports
export const ORGANIZACIONES = ORGANIZATIONS;
export const USUARIOS = USERS;

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
  const userName = logInput.userName || details.userName || (logInput.userId && USERS[logInput.userId]?.name) || null;
  const orgName = logInput.orgName || logInput.orgNombre || details.orgName || details.orgNombre || (logInput.orgId && ORGANIZATIONS[logInput.orgId]?.name) || null;
  const fileName = details.fileName || details.archivo || null;
  const extension = details.extension || (fileName && fileName.includes('.') ? fileName.slice(fileName.lastIndexOf('.')).toLowerCase() : null);

  const enrichedDetails = {
    ...details,
    method,
    userName,
    orgName,
    extension,
  };

  const newLog: ServiceLog = {
    id: crypto.randomUUID(),
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

  // 1. Keep in memory for immediate fallback retrieval
  const logs = globalForLogs.serviceLogs || [];
  logs.unshift(newLog);
  if (logs.length > 100) logs.pop();
  globalForLogs.serviceLogs = logs;

  // 2. Persist to Supabase
  try {
    const validOrgId = logInput.orgId && UUID_REGEX.test(logInput.orgId) ? logInput.orgId : (logInput.targetOrgId && UUID_REGEX.test(logInput.targetOrgId) ? logInput.targetOrgId : null);
    const validUserId = logInput.userId && UUID_REGEX.test(logInput.userId) && logInput.userId !== '00000000-0000-0000-0000-000000000000' ? logInput.userId : null;

    // Try primary English table: service_logs
    const { error: englishErr } = await supabase.from('service_logs').insert({
      id: newLog.id,
      org_id: validOrgId,
      user_id: validUserId,
      action: newLog.action,
      status: newLog.status,
      file_name: fileName,
      details: enrichedDetails,
      ip_address: details.ip || '127.0.0.1',
      created_at: newLog.timestamp,
    });

    // Fallback if table is still logs_servicio
    if (englishErr) {
      await supabase.from('logs_servicio').insert({
        id: newLog.id,
        org_id: validOrgId,
        user_id: validUserId,
        accion: newLog.action,
        estado: newLog.status,
        detalles: enrichedDetails,
        ip_origen: details.ip || '127.0.0.1',
        created_at: newLog.timestamp,
      });
    }
  } catch (err: any) {
    console.error('Error persisting log in Supabase:', err.message);
  }

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
        const userName = details.userName || (userId && USERS[userId]?.name) || null;
        const orgId = row.org_id || matchedFile?.org_id || details.orgId || null;
        const orgName = details.orgName || details.orgNombre || (orgId && ORGANIZATIONS[orgId]?.name) || null;
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
    await supabase.from('service_logs').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await supabase.from('logs_servicio').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  } catch (err) {
    console.error('Error clearing logs in Supabase:', err);
  }
}
