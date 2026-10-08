import { supabase } from '../config/supabase.js';

export interface Organizacion {
  id: string;
  nombre: string;
  slug: string;
  descripcion?: string;
}

export interface Usuario {
  id: string;
  org_id: string;
  nombre: string;
  email: string;
  rol: 'admin' | 'editor' | 'visitante';
  puede_subir: boolean;
}

// Datos semilla en memoria (utilizados como fuente de verdad y fallback antes o después del SQL en Supabase)
export const SEED_ORGANIZACIONES: Organizacion[] = [
  {
    id: '11111111-1111-1111-1111-111111111111',
    nombre: 'Organización 1',
    slug: 'organizacion_1',
    descripcion: 'Corporación Alpha (10 miembros)',
  },
  {
    id: '22222222-2222-2222-2222-222222222222',
    nombre: 'Organización 2',
    slug: 'organizacion_2',
    descripcion: 'Corporación Beta (5 miembros)',
  },
];

export const SEED_USUARIOS: Usuario[] = [
  // --- 10 Personas en Organización 1 ---
  { id: 'a1111111-0000-0000-0000-000000000001', org_id: '11111111-1111-1111-1111-111111111111', nombre: 'Carlos Mendoza', email: 'carlos.mendoza@org1.com', rol: 'admin', puede_subir: true },
  { id: 'a1111111-0000-0000-0000-000000000002', org_id: '11111111-1111-1111-1111-111111111111', nombre: 'Ana Beltrán', email: 'ana.beltran@org1.com', rol: 'editor', puede_subir: true },
  { id: 'a1111111-0000-0000-0000-000000000003', org_id: '11111111-1111-1111-1111-111111111111', nombre: 'Roberto Morales', email: 'roberto.morales@org1.com', rol: 'editor', puede_subir: true },
  { id: 'a1111111-0000-0000-0000-000000000004', org_id: '11111111-1111-1111-1111-111111111111', nombre: 'Lucía Vega', email: 'lucia.vega@org1.com', rol: 'editor', puede_subir: true },
  { id: 'a1111111-0000-0000-0000-000000000005', org_id: '11111111-1111-1111-1111-111111111111', nombre: 'Diego Solís', email: 'diego.solis@org1.com', rol: 'editor', puede_subir: true },
  { id: 'a1111111-0000-0000-0000-000000000006', org_id: '11111111-1111-1111-1111-111111111111', nombre: 'Elena Castillo', email: 'elena.castillo@org1.com', rol: 'editor', puede_subir: true },
  { id: 'a1111111-0000-0000-0000-000000000007', org_id: '11111111-1111-1111-1111-111111111111', nombre: 'Javier Ramos', email: 'javier.ramos@org1.com', rol: 'editor', puede_subir: true },
  { id: 'a1111111-0000-0000-0000-000000000008', org_id: '11111111-1111-1111-1111-111111111111', nombre: 'Sofía Pineda', email: 'sofia.pineda@org1.com', rol: 'editor', puede_subir: true },
  { id: 'a1111111-0000-0000-0000-000000000009', org_id: '11111111-1111-1111-1111-111111111111', nombre: 'Fernando Ortiz', email: 'fernando.ortiz@org1.com', rol: 'editor', puede_subir: true },
  { id: 'a1111111-0000-0000-0000-000000000010', org_id: '11111111-1111-1111-1111-111111111111', nombre: 'Valeria Ruiz (Sin Permiso)', email: 'valeria.ruiz@org1.com', rol: 'visitante', puede_subir: false },

  // --- 5 Personas en Organización 2 ---
  { id: 'b2222222-0000-0000-0000-000000000001', org_id: '22222222-2222-2222-2222-222222222222', nombre: 'Mateo Delgado', email: 'mateo.delgado@org2.com', rol: 'admin', puede_subir: true },
  { id: 'b2222222-0000-0000-0000-000000000002', org_id: '22222222-2222-2222-2222-222222222222', nombre: 'Camila Herrera', email: 'camila.herrera@org2.com', rol: 'editor', puede_subir: true },
  { id: 'b2222222-0000-0000-0000-000000000003', org_id: '22222222-2222-2222-2222-222222222222', nombre: 'Andrés Navarro', email: 'andres.navarro@org2.com', rol: 'editor', puede_subir: true },
  { id: 'b2222222-0000-0000-0000-000000000004', org_id: '22222222-2222-2222-2222-222222222222', nombre: 'Paula Cárdenas', email: 'paula.cardenas@org2.com', rol: 'editor', puede_subir: true },
  { id: 'b2222222-0000-0000-0000-000000000005', org_id: '22222222-2222-2222-2222-222222222222', nombre: 'Gabriel Fuentes (Sin Permiso)', email: 'gabriel.fuentes@org2.com', rol: 'visitante', puede_subir: false },
];

export class AuthService {
  /**
   * Obtiene todas las organizaciones (desde Supabase o seed)
   */
  static async getOrganizaciones(): Promise<Organizacion[]> {
    try {
      const { data, error } = await supabase.from('organizaciones').select('*');
      if (!error && data && data.length > 0) return data;
    } catch {}
    return SEED_ORGANIZACIONES;
  }

  /**
   * Obtiene todos los usuarios
   */
  static async getUsuarios(): Promise<Usuario[]> {
    try {
      const { data, error } = await supabase.from('usuarios').select('*');
      if (!error && data && data.length > 0) return data;
    } catch {}
    return SEED_USUARIOS;
  }

  /**
   * Busca un usuario por ID o email
   */
  static async findUsuario(identifier: string): Promise<Usuario | null> {
    try {
      const { data, error } = await supabase
        .from('usuarios')
        .select('*')
        .or(`id.eq.${identifier},email.eq.${identifier}`)
        .single();
      if (!error && data) return data;
    } catch {}

    const local = SEED_USUARIOS.find(u => u.id === identifier || u.email.toLowerCase() === identifier.toLowerCase());
    return local || null;
  }

  /**
   * Busca una organización por ID
   */
  static async findOrganizacion(orgId: string): Promise<Organizacion | null> {
    try {
      const { data, error } = await supabase.from('organizaciones').select('*').eq('id', orgId).single();
      if (!error && data) return data;
    } catch {}

    const local = SEED_ORGANIZACIONES.find(o => o.id === orgId || o.slug === orgId);
    return local || null;
  }

  /**
   * Registra un log de servicio y auditoría
   */
  static async logAuditoria(params: {
    orgId?: string | null;
    userId?: string | null;
    accion: string;
    estado: string;
    detalles: any;
  }) {
    try {
      await supabase.from('logs_servicio').insert({
        org_id: params.orgId || null,
        user_id: params.userId || null,
        accion: params.accion,
        estado: params.estado,
        detalles: params.detalles,
        created_at: new Date().toISOString(),
      });
    } catch (e) {
      // Si la tabla logs_servicio aún no se crea en Supabase, no interrumpe el flujo
    }
  }
}
