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
   * Obtiene todas las organizaciones directamente desde la tabla 'organizations' en Supabase
   */
  static async getOrganizaciones(): Promise<Organizacion[]> {
    const { data, error } = await supabase
      .from('organizations')
      .select('*')
      .order('name', { ascending: true });

    if (error) {
      console.error('Error consultando organizaciones en Supabase:', error.message);
      return [];
    }
    return (data || []).map((o: any) => ({
      id: o.id,
      nombre: o.name,
      slug: o.slug,
      descripcion: o.description,
      created_at: o.created_at,
    }));
  }

  /**
   * Obtiene todos los usuarios registrados directamente desde la tabla 'users' en Supabase
   */
  static async getUsuarios(): Promise<Usuario[]> {
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .order('name', { ascending: true });

    if (error) {
      console.error('Error consultando usuarios en Supabase:', error.message);
      return [];
    }
    return (data || []).map((u: any) => ({
      id: u.id,
      org_id: u.org_id,
      nombre: u.name,
      email: u.email,
      rol: u.role,
      puede_subir: Boolean(u.can_upload),
      created_at: u.created_at,
    }));
  }

  /**
   * Consulta estricta en Supabase: Busca un usuario por ID o Email en PostgreSQL (users table)
   */
  static async findUsuario(identifier: string): Promise<Usuario | null> {
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .or(`id.eq.${identifier},email.eq.${identifier}`)
      .maybeSingle();

    if (error || !data) {
      return null;
    }

    return {
      id: data.id,
      org_id: data.org_id,
      nombre: data.name,
      email: data.email,
      rol: data.role,
      puede_subir: Boolean(data.can_upload),
      created_at: data.created_at,
    };
  }

  /**
   * Consulta estricta en Supabase: Busca una organización por ID o Slug en PostgreSQL (organizations table)
   */
  static async findOrganizacion(orgId: string): Promise<Organizacion | null> {
    const { data, error } = await supabase
      .from('organizations')
      .select('*')
      .or(`id.eq.${orgId},slug.eq.${orgId}`)
      .maybeSingle();

    if (error || !data) {
      return null;
    }

    return {
      id: data.id,
      nombre: data.name,
      slug: data.slug,
      descripcion: data.description,
      created_at: data.created_at,
    };
  }

  /**
   * Registra eventos de auditoría directamente en la tabla 'service_logs' en Supabase
   */
  static async logAuditoria(params: {
    orgId?: string | null;
    userId?: string | null;
    accion: string;
    estado: string;
    detalles: any;
  }) {
    try {
      await supabase.from('service_logs').insert({
        org_id: params.orgId || null,
        user_id: params.userId || null,
        action: params.accion,
        status: params.estado,
        details: params.detalles,
        ip_address: params.detalles?.ip || '127.0.0.1',
        created_at: new Date().toISOString(),
      });
    } catch (err: any) {
      console.error('Error registrando log de servicio en Supabase:', err.message);
    }
  }
}
