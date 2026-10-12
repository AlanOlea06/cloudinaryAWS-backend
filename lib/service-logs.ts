import { supabase } from './supabase';

export interface ServiceLog {
  id: string;
  timestamp: string;
  accion: string;
  estado: 'PERMITIDO' | 'DENEGADO_NO_REGISTRADO' | 'DENEGADO_OTRA_ORG' | 'DENEGADO_SIN_PERMISO' | 'SUBIDO_LANDING';
  userId?: string;
  userName?: string;
  orgId?: string;
  orgNombre?: string;
  targetOrgId?: string;
  detalles: any;
}

export interface MockUser {
  id: string;
  orgId: string;
  nombre: string;
  email: string;
  rol: 'admin' | 'editor' | 'visitante';
  puede_subir: boolean;
}

export interface MockOrg {
  id: string;
  nombre: string;
  slug: string;
}

export const ORGANIZACIONES: Record<string, MockOrg> = {
  '11111111-1111-1111-1111-111111111111': {
    id: '11111111-1111-1111-1111-111111111111',
    nombre: 'Organización 1',
    slug: 'organizacion_1',
  },
  '22222222-2222-2222-2222-222222222222': {
    id: '22222222-2222-2222-2222-222222222222',
    nombre: 'Organización 2',
    slug: 'organizacion_2',
  },
};

export const USUARIOS: Record<string, MockUser> = {
  // Organización 1 (10 miembros)
  'a1111111-0000-0000-0000-000000000001': { id: 'a1111111-0000-0000-0000-000000000001', orgId: '11111111-1111-1111-1111-111111111111', nombre: 'Carlos Mendoza', email: 'carlos.mendoza@org1.com', rol: 'admin', puede_subir: true },
  'a1111111-0000-0000-0000-000000000002': { id: 'a1111111-0000-0000-0000-000000000002', orgId: '11111111-1111-1111-1111-111111111111', nombre: 'Ana Beltrán', email: 'ana.beltran@org1.com', rol: 'editor', puede_subir: true },
  'a1111111-0000-0000-0000-000000000003': { id: 'a1111111-0000-0000-0000-000000000003', orgId: '11111111-1111-1111-1111-111111111111', nombre: 'Roberto Morales', email: 'roberto.morales@org1.com', rol: 'editor', puede_subir: true },
  'a1111111-0000-0000-0000-000000000004': { id: 'a1111111-0000-0000-0000-000000000004', orgId: '11111111-1111-1111-1111-111111111111', nombre: 'Lucía Vega', email: 'lucia.vega@org1.com', rol: 'editor', puede_subir: true },
  'a1111111-0000-0000-0000-000000000005': { id: 'a1111111-0000-0000-0000-000000000005', orgId: '11111111-1111-1111-1111-111111111111', nombre: 'Diego Solís', email: 'diego.solis@org1.com', rol: 'editor', puede_subir: true },
  'a1111111-0000-0000-0000-000000000006': { id: 'a1111111-0000-0000-0000-000000000006', orgId: '11111111-1111-1111-1111-111111111111', nombre: 'Elena Castillo', email: 'elena.castillo@org1.com', rol: 'editor', puede_subir: true },
  'a1111111-0000-0000-0000-000000000007': { id: 'a1111111-0000-0000-0000-000000000007', orgId: '11111111-1111-1111-1111-111111111111', nombre: 'Javier Ramos', email: 'javier.ramos@org1.com', rol: 'editor', puede_subir: true },
  'a1111111-0000-0000-0000-000000000008': { id: 'a1111111-0000-0000-0000-000000000008', orgId: '11111111-1111-1111-1111-111111111111', nombre: 'Sofía Pineda', email: 'sofia.pineda@org1.com', rol: 'editor', puede_subir: true },
  'a1111111-0000-0000-0000-000000000009': { id: 'a1111111-0000-0000-0000-000000000009', orgId: '11111111-1111-1111-1111-111111111111', nombre: 'Fernando Ortiz', email: 'fernando.ortiz@org1.com', rol: 'editor', puede_subir: true },
  'a1111111-0000-0000-0000-000000000010': { id: 'a1111111-0000-0000-0000-000000000010', orgId: '11111111-1111-1111-1111-111111111111', nombre: 'Valeria Ruiz (Sin Permiso)', email: 'valeria.ruiz@org1.com', rol: 'visitante', puede_subir: false },

  // Organización 2 (5 miembros)
  'b2222222-0000-0000-0000-000000000001': { id: 'b2222222-0000-0000-0000-000000000001', orgId: '22222222-2222-2222-2222-222222222222', nombre: 'Mateo Delgado', email: 'mateo.delgado@org2.com', rol: 'admin', puede_subir: true },
  'b2222222-0000-0000-0000-000000000002': { id: 'b2222222-0000-0000-0000-000000000002', orgId: '22222222-2222-2222-2222-222222222222', nombre: 'Camila Herrera', email: 'camila.herrera@org2.com', rol: 'editor', puede_subir: true },
  'b2222222-0000-0000-0000-000000000003': { id: 'b2222222-0000-0000-0000-000000000003', orgId: '22222222-2222-2222-2222-222222222222', nombre: 'Andrés Navarro', email: 'andres.navarro@org2.com', rol: 'editor', puede_subir: true },
  'b2222222-0000-0000-0000-000000000004': { id: 'b2222222-0000-0000-0000-000000000004', orgId: '22222222-2222-2222-2222-222222222222', nombre: 'Paula Cárdenas', email: 'paula.cardenas@org2.com', rol: 'editor', puede_subir: true },
  'b2222222-0000-0000-0000-000000000005': { id: 'b2222222-0000-0000-0000-000000000005', orgId: '22222222-2222-2222-2222-222222222222', nombre: 'Gabriel Fuentes (Sin Permiso)', email: 'gabriel.fuentes@org2.com', rol: 'visitante', puede_subir: false },
};

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Almacén en memoria de respaldo
const globalForLogs = globalThis as unknown as { serviceLogs?: ServiceLog[] };
if (!globalForLogs.serviceLogs) {
  globalForLogs.serviceLogs = [];
}

/**
 * Guarda un evento de auditoría tanto en memoria como en la tabla logs_servicio de Supabase
 */
export async function addServiceLog(log: Omit<ServiceLog, 'id' | 'timestamp'>): Promise<ServiceLog> {
  const newLog: ServiceLog = {
    ...log,
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
  };

  // 1. Guardar en memoria para respuesta ultra rápida
  const logs = globalForLogs.serviceLogs || [];
  logs.unshift(newLog);
  if (logs.length > 100) logs.pop();
  globalForLogs.serviceLogs = logs;

  // 2. Persistir en la tabla 'logs_servicio' en Supabase
  try {
    const validOrgId = log.orgId && UUID_REGEX.test(log.orgId) ? log.orgId : (log.targetOrgId && UUID_REGEX.test(log.targetOrgId) ? log.targetOrgId : null);
    const validUserId = log.userId && UUID_REGEX.test(log.userId) && log.userId !== '00000000-0000-0000-0000-000000000000' ? log.userId : null;

    const { error } = await supabase.from('logs_servicio').insert({
      id: newLog.id,
      org_id: validOrgId,
      user_id: validUserId,
      accion: log.accion,
      estado: log.estado,
      detalles: {
        ...log.detalles,
        userName: log.userName,
        orgNombre: log.orgNombre,
      },
      ip_origen: log.detalles?.ip || '127.0.0.1',
      created_at: newLog.timestamp,
    });

    if (error) {
      console.warn('Advertencia insertando en logs_servicio de Supabase:', error.message);
    }
  } catch (err: any) {
    console.error('Error persistiendo log en Supabase:', err.message);
  }

  return newLog;
}

/**
 * Obtiene los logs de servicio directamente desde la tabla 'logs_servicio' en Supabase
 */
export async function getServiceLogs(): Promise<ServiceLog[]> {
  try {
    const { data, error } = await supabase
      .from('logs_servicio')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(50);

    if (!error && data && data.length > 0) {
      return data.map((row: any) => ({
        id: row.id,
        timestamp: row.created_at,
        accion: row.accion,
        estado: row.estado,
        userId: row.user_id,
        userName: row.detalles?.userName || 'Desconocido',
        orgId: row.org_id,
        orgNombre: row.detalles?.orgNombre || 'Organización',
        targetOrgId: row.detalles?.targetOrgId,
        detalles: row.detalles,
      }));
    }
  } catch (err) {
    console.warn('Fallback a logs en memoria:', err);
  }

  return globalForLogs.serviceLogs || [];
}

/**
 * Limpia los logs de servicio en Supabase y en memoria
 */
export async function clearServiceLogs(): Promise<void> {
  globalForLogs.serviceLogs = [];
  try {
    await supabase.from('logs_servicio').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  } catch (err) {
    console.error('Error limpiando logs en Supabase:', err);
  }
}
