import { supabase } from '../config/supabase.js';

export interface Organizacion {
  id: string;
  nombre: string;
  slug: string;
  descripcion?: string;
  created_at?: string;
}

export interface Usuario {
  id: string;
  org_id: string;
  nombre: string;
  email: string;
  rol: 'admin' | 'editor' | 'visitante';
  puede_subir: boolean;
  created_at?: string;
}

export class AuthService {
  /**
   * Obtiene todas las organizaciones directamente desde la tabla 'organizaciones' en Supabase
   */
  static async getOrganizaciones(): Promise<Organizacion[]> {
    const { data, error } = await supabase
      .from('organizaciones')
      .select('*')
      .order('nombre', { ascending: true });

    if (error) {
      console.error('Error consultando organizaciones en Supabase:', error.message);
      return [];
    }
    return data || [];
  }

  /**
   * Obtiene todos los usuarios registrados directamente desde la tabla 'usuarios' en Supabase
   */
  static async getUsuarios(): Promise<Usuario[]> {
    const { data, error } = await supabase
      .from('usuarios')
      .select('*')
      .order('nombre', { ascending: true });

    if (error) {
      console.error('Error consultando usuarios en Supabase:', error.message);
      return [];
    }
    return data || [];
  }

  /**
   * Consulta estricta en Supabase: Busca un usuario por ID o Email en PostgreSQL
   */
  static async findUsuario(identifier: string): Promise<Usuario | null> {
    const { data, error } = await supabase
      .from('usuarios')
      .select('*')
      .or(`id.eq.${identifier},email.eq.${identifier}`)
      .single();

    if (error || !data) {
      return null;
    }

    return data;
  }

  /**
   * Consulta estricta en Supabase: Busca una organización por ID o Slug en PostgreSQL
   */
  static async findOrganizacion(orgId: string): Promise<Organizacion | null> {
    const { data, error } = await supabase
      .from('organizaciones')
      .select('*')
      .or(`id.eq.${orgId},slug.eq.${orgId}`)
      .single();

    if (error || !data) {
      return null;
    }

    return data;
  }

  /**
   * Registra eventos de auditoría directamente en la tabla 'logs_servicio' en Supabase
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
    } catch (err: any) {
      console.error('Error registrando log de servicio en Supabase:', err.message);
    }
  }
}
