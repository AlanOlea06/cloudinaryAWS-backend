import { pgClient } from './postgres';
import { db, isDirectDatabaseConfigured, serviceLogs, files, users, organizations } from '@/lib/db';
import { desc, count, inArray } from 'drizzle-orm';

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
 * a través de claves foráneas relacionales en PostgreSQL (JOINs en PostgreSQL),
 * garantizando cero redundancia y eliminación total de columnas JSON/JSONB.
 * ==============================================================================
 */

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function inferMimeTypeFromExt(ext: string | null): string | null {
  if (!ext) return null;
  const clean = ext.startsWith('.') ? ext.toLowerCase() : '.' + ext.toLowerCase();
  const map: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.pdf': 'application/pdf',
    '.zip': 'application/zip',
    '.txt': 'text/plain',
    '.json': 'application/json',
  };
  return map[clean] || null;
}

export function inferResourceType(mime: string | null, ext: string | null): string {
  if (mime) {
    if (mime.startsWith('image/')) return 'image';
    if (mime.startsWith('video/')) return 'video';
    if (mime.startsWith('audio/')) return 'audio';
  }
  if (ext) {
    const clean = ext.toLowerCase();
    if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'].includes(clean)) return 'image';
    if (['.mp4', '.webm', '.mov'].includes(clean)) return 'video';
    if (['.mp3', '.wav', '.ogg'].includes(clean)) return 'audio';
  }
  return 'raw';
}

export function parseMetadataFromMessage(msg: string | null): {
  fileName?: string;
  extension?: string;
  mimeType?: string;
  fileSize?: number;
  visibility?: string;
  fileId?: string;
} {
  if (!msg || typeof msg !== 'string') return {};
  const meta: {
    fileName?: string;
    extension?: string;
    mimeType?: string;
    fileSize?: number;
    visibility?: string;
    fileId?: string;
  } = {};

  // Extraer nombre de archivo entre comillas simples o dobles
  const nameMatch = msg.match(/(?:file|archivo)\s*['"]([^'"]+)['"]/i) || msg.match(/['"]([^'"]+\.[a-zA-Z0-9]{2,5})['"]/);
  if (nameMatch) {
    meta.fileName = nameMatch[1];
    if (meta.fileName.includes('.')) {
      meta.extension = meta.fileName.slice(meta.fileName.lastIndexOf('.')).toLowerCase();
    }
  }

  // Extraer MIME type
  const mimeMatch = msg.match(/\(([a-zA-Z0-9_\-\.\/]+),/) || msg.match(/mime(?:Type)?\s*[:=]\s*['"]?([a-zA-Z0-9_\-\.\/]+)['"]?/i);
  if (mimeMatch) {
    meta.mimeType = mimeMatch[1];
  }

  // Extraer tamaño en bytes
  const sizeMatch = msg.match(/(\d+)\s*bytes/i) || msg.match(/size\s*=\s*(\d+)/i);
  if (sizeMatch) {
    meta.fileSize = parseInt(sizeMatch[1], 10);
  }

  // Extraer visibilidad
  const visMatch = msg.match(/visibility\s*=\s*['"]?([a-zA-Z0-9_\-]+)['"]?/i);
  if (visMatch) {
    meta.visibility = visMatch[1];
  }

  // Extraer UUID de fileId si quedó incrustado en el texto
  const fileIdMatch = msg.match(/\[fileId:\s*([0-9a-fA-F\-]{36})\]/i) || msg.match(/id:\s*([0-9a-fA-F\-]{36})/i);
  if (fileIdMatch) {
    meta.fileId = fileIdMatch[1];
  }

  return meta;
}

// In-memory fallback log store
const globalForLogs = globalThis as unknown as { serviceLogs?: ServiceLog[] };
if (!globalForLogs.serviceLogs) {
  globalForLogs.serviceLogs = [];
}

/**
 * Persists an audit log event to memory and to PostgreSQL (service_logs table)
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
  let message = logInput.message || logInput.reason || logInput.alert || legacyDetails.message || legacyDetails.reason || legacyDetails.alert || null;
  if (fileId && message && !message.includes(fileId)) {
    message = `${message} [fileId: ${fileId}]`;
  }

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

  // 1. Persist log (Direct PostgreSQL if DATABASE_URL is set, PostgreSQL fallback otherwise)
  try {
    const validOrgId = logInput.orgId && UUID_REGEX.test(logInput.orgId) ? logInput.orgId : (logInput.targetOrgId && UUID_REGEX.test(logInput.targetOrgId) ? logInput.targetOrgId : null);
    const validUserId = logInput.userId && UUID_REGEX.test(logInput.userId) && logInput.userId !== '00000000-0000-0000-0000-000000000000' ? logInput.userId : null;
    const validFileId = fileId && UUID_REGEX.test(fileId) ? fileId : null;
    const validTicketId = ticketId && UUID_REGEX.test(ticketId) ? ticketId : null;

    if (isDirectDatabaseConfigured()) {
      try {
        const [inserted] = await db.insert(serviceLogs).values({
          org_id: validOrgId,
          user_id: validUserId,
          action: newLog.action,
          status: newLog.status,
          ip_address: ipAddress,
          created_at: new Date(newLog.timestamp),
          http_method: method,
          file_id: validFileId,
          ticket_id: validTicketId,
          message: message,
        }).returning({ id: serviceLogs.id });
        if (inserted?.id !== undefined) {
          newLog.id = inserted.id;
        }
      } catch (directInsertErr: any) {
        // Fallback si la llave foránea de file_id falla (ej. archivo ya borrado)
        try {
          const [retryInserted] = await db.insert(serviceLogs).values({
            org_id: validOrgId,
            user_id: validUserId,
            action: newLog.action,
            status: newLog.status,
            ip_address: ipAddress,
            created_at: new Date(newLog.timestamp),
            http_method: method,
            file_id: null,
            ticket_id: validTicketId,
            message: message,
          }).returning({ id: serviceLogs.id });
          if (retryInserted?.id !== undefined) {
            newLog.id = retryInserted.id;
          }
        } catch (e: any) {
          console.error('Error inserting log via direct PostgreSQL:', e.message, e.cause);
        }
      }
    } else {

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

    let { data: insertedRow, error: insertErr } = await pgClient
      .from('service_logs')
      .insert(payload)
      .select('id')
      .single();

    // Fallback si la llave foránea de file_id falla (ej. archivo ya borrado de public.files)
    if (insertErr && (insertErr.code === '23503' || insertErr.message?.includes('foreign key') || insertErr.message?.includes('files'))) {
      console.warn('Llave foránea en file_id no coincide con registro activo en files; guardando log con file_id: null:', insertErr.message);
      const safePayload = { ...payload, file_id: null };
      const retryFk = await pgClient.from('service_logs').insert(safePayload).select('id').single();
      insertedRow = retryFk.data;
      insertErr = retryFk.error;
    }

    // Resilient fallback if ALTER TABLE hasn't been executed yet in PostgreSQL
    if (insertErr && insertErr.message.includes('in the schema cache')) {
      console.warn('PostgreSQL missing new columns, falling back to base columns:', insertErr.message);
      const fallbackPayload = {
        org_id: validOrgId,
        user_id: validUserId,
        action: newLog.action,
        status: newLog.status,
        ip_address: ipAddress,
        created_at: newLog.timestamp,
      };
      const retry = await pgClient.from('service_logs').insert(fallbackPayload).select('id').single();
      insertedRow = retry.data;
      insertErr = retry.error;
    }

    if (!insertErr && insertedRow?.id !== undefined) {
      newLog.id = insertedRow.id;
    } else if (insertErr) {
      console.error('Error inserting log in service_logs:', insertErr.message);
    }
    }
  } catch (err: any) {
    console.error('Error persisting log in database:', err.message);
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
 * Fetches audit logs from PostgreSQL (service_logs table) with pagination,
 * sorted strictly from newest to oldest (id DESC, created_at DESC).
 */
export async function getServiceLogs(options?: {
  page?: number;
  limit?: number;
}): Promise<PaginatedServiceLogs> {
  const page = Math.max(1, Number(options?.page) || 1);
  const limit = Math.max(1, Math.min(100, Number(options?.limit) || 20));
  const offset = (page - 1) * limit;

  // 1. Direct PostgreSQL query with Drizzle when configured
  if (isDirectDatabaseConfigured()) {
    try {
      const [totalRow] = await db.select({ count: count() }).from(serviceLogs);
      const total = Number(totalRow?.count || 0);
      const totalPages = Math.max(1, Math.ceil(total / limit));

      const rawLogs = await db
        .select()
        .from(serviceLogs)
        .orderBy(desc(serviceLogs.id))
        .limit(limit)
        .offset(offset);

      const fileIds = Array.from(new Set(rawLogs.map((r) => r.file_id).filter(Boolean))) as string[];
      const ticketIds = Array.from(new Set(rawLogs.map((r) => r.ticket_id).filter(Boolean))) as string[];
      const userIds = Array.from(new Set(rawLogs.map((r) => r.user_id).filter(Boolean))) as string[];
      const orgIds = Array.from(new Set(rawLogs.map((r) => r.org_id).filter(Boolean))) as string[];

      const [filesByIdRes, filesByTicketRes, usersRes, orgsRes] = await Promise.all([
        fileIds.length > 0 ? db.select().from(files).where(inArray(files.id, fileIds)) : Promise.resolve([]),
        ticketIds.length > 0 ? db.select().from(files).where(inArray(files.ticket_id, ticketIds)) : Promise.resolve([]),
        userIds.length > 0 ? db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, userIds)) : Promise.resolve([]),
        orgIds.length > 0 ? db.select({ id: organizations.id, name: organizations.name }).from(organizations).where(inArray(organizations.id, orgIds)) : Promise.resolve([]),
      ]);

      const filesByTicket: Record<string, any> = {};
      const filesById: Record<string, any> = {};
      for (const f of filesByIdRes) {
        if (f.id) filesById[f.id] = f;
        if (f.ticket_id) filesByTicket[f.ticket_id] = f;
      }
      for (const f of filesByTicketRes) {
        if (f.id) filesById[f.id] = f;
        if (f.ticket_id) filesByTicket[f.ticket_id] = f;
      }

      const usersById: Record<string, string> = {};
      for (const u of usersRes) {
        if (u.id) usersById[u.id] = u.name;
      }

      const orgsById: Record<string, string> = {};
      for (const o of orgsRes) {
        if (o.id) orgsById[o.id] = o.name;
      }

      const ticketMetaMap: Record<string, any> = {};
      for (const row of rawLogs) {
        const parsed = parseMetadataFromMessage(row.message);
        const tId = row.ticket_id;
        if (tId) {
          if (!ticketMetaMap[tId]) ticketMetaMap[tId] = {};
          if (parsed.fileName && !ticketMetaMap[tId].fileName) ticketMetaMap[tId].fileName = parsed.fileName;
          if (parsed.extension && !ticketMetaMap[tId].extension) ticketMetaMap[tId].extension = parsed.extension;
          if (parsed.mimeType && !ticketMetaMap[tId].mimeType) ticketMetaMap[tId].mimeType = parsed.mimeType;
          if (parsed.fileSize !== undefined && ticketMetaMap[tId].fileSize === undefined) ticketMetaMap[tId].fileSize = parsed.fileSize;
          if (parsed.visibility && !ticketMetaMap[tId].visibility) ticketMetaMap[tId].visibility = parsed.visibility;
          if (parsed.fileId && !ticketMetaMap[tId].fileId) ticketMetaMap[tId].fileId = parsed.fileId;
        }
      }

      const mappedLogs: ServiceLog[] = rawLogs.map((row) => {
        const action = row.action || '';
        const status = row.status || '';
        const ticketId = row.ticket_id || null;
        const fileId = row.file_id || null;
        const matchedFile = (ticketId ? filesByTicket[ticketId] : null) || (fileId ? filesById[fileId] : null);
        const parsed = parseMetadataFromMessage(row.message);
        const tMeta = ticketId ? ticketMetaMap[ticketId] || {} : {};

        const userId = row.user_id || matchedFile?.user_id || null;
        const userName = (userId && usersById[userId]) || null;
        const orgId = row.org_id || matchedFile?.org_id || null;
        const orgName = (orgId && orgsById[orgId]) || null;

        const fileName = matchedFile?.original_name || tMeta.fileName || parsed.fileName || null;
        const extension = matchedFile?.extension || tMeta.extension || parsed.extension || (fileName && fileName.includes('.') ? fileName.slice(fileName.lastIndexOf('.')).toLowerCase() : null);
        const mimeType = matchedFile?.mime_type || tMeta.mimeType || parsed.mimeType || inferMimeTypeFromExt(extension) || null;
        const fileSize = matchedFile?.size_bytes ?? tMeta.fileSize ?? parsed.fileSize ?? null;
        const resourceType = matchedFile?.resource_type || inferResourceType(mimeType, extension) || null;
        const visibility = matchedFile?.visibility || tMeta.visibility || parsed.visibility || null;
        const method = row.http_method || (action === 'S3_UPLOAD_CONFIRMED' ? 'PUT' : 'POST');
        const ipAddress = row.ip_address || null;
        const message = row.message || null;
        const effectiveFileId = fileId || matchedFile?.id || tMeta.fileId || parsed.fileId || null;

        return {
          id: row.id,
          timestamp: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString(),
          method,
          action,
          status,
          ticketId,
          fileId: effectiveFileId,
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
        logs: mappedLogs,
        total,
        page,
        limit,
        totalPages,
      };
    } catch (directErr: any) {
      console.warn('[SERVICE_LOGS_DIRECT_FALLBACK] Direct query failed, falling back to PostgreSQL:', directErr.message, directErr.cause);
    }
  }

  try {
    // 2. Legacy PostgreSQL HTTP query fallback
    const { data, count, error } = await pgClient
      .from('service_logs')
      .select('*', { count: 'exact' })
      .order('id', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      console.warn('Error querying service_logs from PostgreSQL:', error.message);
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
        ? pgClient.from('files').select('*').in('id', fileIds)
        : Promise.resolve({ data: [] }),
      ticketIds.length > 0
        ? pgClient.from('files').select('*').in('ticket_id', ticketIds)
        : Promise.resolve({ data: [] }),
      userIds.length > 0
        ? pgClient.from('users').select('id, name').in('id', userIds)
        : Promise.resolve({ data: [] }),
      orgIds.length > 0
        ? pgClient.from('organizations').select('id, name').in('id', orgIds)
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

    // 2.1 Pre-análisis y correlación de metadatos por ticket_id a partir de los mensajes del lote
    // Esto asegura que logs de archivos eliminados (o cascadas a NULL) mantengan todos sus campos
    const ticketMetaMap: Record<string, {
      fileName?: string;
      extension?: string;
      mimeType?: string;
      fileSize?: number;
      visibility?: string;
      fileId?: string;
    }> = {};

    for (const row of data) {
      const parsed = parseMetadataFromMessage(row.message);
      const tId = row.ticket_id;
      if (tId) {
        if (!ticketMetaMap[tId]) ticketMetaMap[tId] = {};
        if (parsed.fileName && !ticketMetaMap[tId].fileName) ticketMetaMap[tId].fileName = parsed.fileName;
        if (parsed.extension && !ticketMetaMap[tId].extension) ticketMetaMap[tId].extension = parsed.extension;
        if (parsed.mimeType && !ticketMetaMap[tId].mimeType) ticketMetaMap[tId].mimeType = parsed.mimeType;
        if (parsed.fileSize !== undefined && ticketMetaMap[tId].fileSize === undefined) ticketMetaMap[tId].fileSize = parsed.fileSize;
        if (parsed.visibility && !ticketMetaMap[tId].visibility) ticketMetaMap[tId].visibility = parsed.visibility;
        if (parsed.fileId && !ticketMetaMap[tId].fileId) ticketMetaMap[tId].fileId = parsed.fileId;
      }
    }

    const logs: ServiceLog[] = data.map((row: any) => {
      const action = row.action || '';
      const status = row.status || '';
      const ticketId = row.ticket_id || row.details?.ticketId || null;
      const fileId = row.file_id || row.details?.fileId || null;
      const matchedFile = (ticketId ? filesByTicket[ticketId] : null) || (fileId ? filesById[fileId] : null);
      const parsed = parseMetadataFromMessage(row.message);
      const tMeta = ticketId ? ticketMetaMap[ticketId] || {} : {};

      const userId = row.user_id || matchedFile?.user_id || null;
      const userName = (userId && usersById[userId]) || row.details?.userName || null;
      const orgId = row.org_id || matchedFile?.org_id || null;
      const orgName = (orgId && orgsById[orgId]) || row.details?.orgName || null;

      const fileName = matchedFile?.original_name || row.file_name || tMeta.fileName || parsed.fileName || row.details?.fileName || null;
      const extension = matchedFile?.extension || tMeta.extension || parsed.extension || (fileName && fileName.includes('.') ? fileName.slice(fileName.lastIndexOf('.')).toLowerCase() : null);
      const mimeType = matchedFile?.mime_type || tMeta.mimeType || parsed.mimeType || inferMimeTypeFromExt(extension) || row.details?.mimeType || null;
      const fileSize = matchedFile?.size_bytes ?? tMeta.fileSize ?? parsed.fileSize ?? row.details?.fileSize ?? null;
      const resourceType = matchedFile?.resource_type || inferResourceType(mimeType, extension) || row.details?.resourceType || null;
      const visibility = matchedFile?.visibility || tMeta.visibility || parsed.visibility || row.details?.visibility || null;
      const method = row.http_method || row.details?.method || (action === 'S3_UPLOAD_CONFIRMED' ? 'PUT' : 'POST');
      const ipAddress = row.ip_address || row.details?.ip || null;
      const message = row.message || row.details?.message || row.details?.reason || row.details?.alert || null;
      const effectiveFileId = fileId || matchedFile?.id || tMeta.fileId || parsed.fileId || null;

      return {
        id: row.id,
        timestamp: row.created_at,
        method,
        action,
        status,
        ticketId,
        fileId: effectiveFileId,
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
 * Clears service logs from PostgreSQL and memory
 */
export async function clearServiceLogs(): Promise<void> {
  globalForLogs.serviceLogs = [];
  try {
    await pgClient.from('service_logs').delete().not('created_at', 'is', null);
  } catch (err) {
    console.error('Error clearing logs in PostgreSQL:', err);
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

  let query: any = pgClient
    .from('service_logs')
    .select('id, ip_address, created_at')
    .not('ip_address', 'is', null)
    .lte('created_at', cutoffIso)
    .limit(500);

  if (options?.logId !== undefined) {
    query = pgClient
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
  const { error: updateErr } = await pgClient
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

