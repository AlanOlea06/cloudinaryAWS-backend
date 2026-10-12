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

// Almacén en memoria de los logs de servicio (últimos 100 eventos)
// En Vercel Serverless, sobrevive durante la vida del contenedor
const globalForLogs = globalThis as unknown as { serviceLogs?: ServiceLog[] };
if (!globalForLogs.serviceLogs) {
  globalForLogs.serviceLogs = [
    {
      id: 'init-log-01',
      timestamp: new Date().toISOString(),
      accion: 'SERVICIO_INICIADO',
      estado: 'PERMITIDO',
      userName: 'Sistema AWS',
      orgNombre: 'Infraestructura',
      detalles: {
        mensaje: 'Módulo de logs de servicio inicializado. Monitoreando accesos multi-tenant.',
        directorioS3: 'logs de servicio/',
      },
    },
  ];
}

export function addServiceLog(log: Omit<ServiceLog, 'id' | 'timestamp'>): ServiceLog {
  const newLog: ServiceLog = {
    ...log,
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
  };

  const logs = globalForLogs.serviceLogs || [];
  logs.unshift(newLog); // Más reciente primero
  if (logs.length > 100) logs.pop();
  globalForLogs.serviceLogs = logs;

  return newLog;
}

export function getServiceLogs(): ServiceLog[] {
  return globalForLogs.serviceLogs || [];
}

export function clearServiceLogs(): void {
  globalForLogs.serviceLogs = [];
}
