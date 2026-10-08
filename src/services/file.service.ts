import { randomUUID } from 'node:crypto';
import { supabase } from '../config/supabase.js';
import { RequestUploadTicketInput } from '../schemas/upload.schema.js';
import { AuthService } from './auth.service.js';

export interface FileRecord {
  id: string;
  ticket_id: string;
  user_id: string;
  org_id?: string;
  user_name: string;
  nombre_original: string;
  formato: string;
  tamano_bytes: number;
  tipo_recurso?: 'imagenes' | 'documentos' | 'videos';
  visibilidad?: 'publicos' | 'privados';
  s3_key_pendiente: string;
  s3_key_procesado?: string | null;
  cloudfront_url?: string | null;
  estado: string;
  metadata?: any;
  created_at?: string;
  updated_at?: string;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class FileService {
  /**
   * Clasifica la tipología del archivo según su MIME type
   */
  static getTipoRecurso(fileType: string): 'imagenes' | 'documentos' | 'videos' {
    if (fileType.startsWith('image/')) return 'imagenes';
    if (fileType.startsWith('video/')) return 'videos';
    return 'documentos';
  }

  /**
   * Genera la ruta en S3 para la zona de aterrizaje: Pendientes/
   * Estructura: Pendientes/{orgSlug}/{userId}/{fileId}-{filename}
   */
  static generatePendingS3Key(orgSlug: string, userId: string, fileId: string, fileName: string): string {
    const sanitizedFileName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
    return `Pendientes/${orgSlug}/${userId}/${fileId}-${sanitizedFileName}`;
  }

  /**
   * Genera la ruta definitiva en S3 según la jerarquía multi-tenant:
   * Organizaciones/{Organizacion}/{tipo_recurso}/{visibilidad}/{archivo}
   */
  static generateProcessedS3Key(
    orgSlug: string,
    tipoRecurso: 'imagenes' | 'documentos' | 'videos',
    visibilidad: 'publicos' | 'privados',
    fileId: string,
    fileName: string,
    extensionOverride?: string
  ): string {
    const sanitizedBase = fileName.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/\.[^/.]+$/, '');
    const ext = extensionOverride || (fileName.includes('.') ? fileName.split('.').pop() : 'bin');
    return `Organizaciones/${orgSlug}/${tipoRecurso}/${visibilidad}/${fileId}-${sanitizedBase}.${ext}`;
  }

  /**
   * Registra el ticket de subida en Supabase
   */
  static async createPendingFileRecord(
    input: RequestUploadTicketInput,
    isMock = false
  ): Promise<FileRecord> {
    const fileId = randomUUID();
    const ticketId = randomUUID();

    const validUserId = UUID_REGEX.test(input.userId) ? input.userId : randomUUID();
    const validOrgId = UUID_REGEX.test(input.orgId) ? input.orgId : randomUUID();

    const org = await AuthService.findOrganizacion(input.orgId);
    const orgSlug = org ? org.slug : 'organizacion_desconocida';
    const tipoRecurso = this.getTipoRecurso(input.fileType);
    const visibilidad = input.visibilidad || 'privados';

    const s3KeyPendiente = this.generatePendingS3Key(orgSlug, validUserId, fileId, input.fileName);

    const initialMetadata = {
      hash_sha256: input.hashSha256 || null,
      modo_simulado: isMock,
      org_slug: orgSlug,
      tipo_recurso: tipoRecurso,
      visibilidad,
      creado_en: new Date().toISOString(),
    };

    // Objeto base para insertar
    const recordPayload: any = {
      id: fileId,
      ticket_id: ticketId,
      user_id: validUserId,
      user_name: input.userName || 'Usuario',
      nombre_original: input.fileName,
      formato: input.fileType,
      tamano_bytes: input.fileSize,
      s3_key_pendiente: s3KeyPendiente,
      estado: 'pendiente_subida',
      metadata: initialMetadata,
    };

    // Si la tabla ya tiene las columnas de organizaciones las incluimos
    try {
      recordPayload.org_id = validOrgId;
      recordPayload.visibilidad = visibilidad;
      recordPayload.tipo_recurso = tipoRecurso;
    } catch {}

    const { data, error } = await supabase
      .from('archivos')
      .insert(recordPayload)
      .select('*')
      .single();

    if (error) {
      console.warn('Advertencia al insertar con columnas multi-tenant, reintentando con columnas base:', error.message);
      // Reintento sin las columnas nuevas si no se ha corrido el script en Supabase
      delete recordPayload.org_id;
      delete recordPayload.visibilidad;
      delete recordPayload.tipo_recurso;

      const fallback = await supabase.from('archivos').insert(recordPayload).select('*').single();
      if (fallback.error) {
        throw new Error(`Error al persistir archivo en Supabase: ${fallback.error.message}`);
      }
      return fallback.data;
    }

    return data;
  }

  /**
   * Actualiza el registro tras la subida o procesamiento (S3 / Lambda)
   */
  static async updateFileRecordByTicket(
    ticketId: string,
    updates: {
      estado?: 'pendiente_subida' | 'subido_pendiente_proc' | 'procesando' | 'completado' | 'error' | 'rechazado_seguridad';
      s3_key_procesado?: string;
      cloudfront_url?: string;
      metadata?: any;
    }
  ): Promise<FileRecord | null> {
    const { data, error } = await supabase
      .from('archivos')
      .update(updates)
      .eq('ticket_id', ticketId)
      .select('*')
      .single();

    if (error) {
      console.error(`Error actualizando archivo con ticket ${ticketId} en Supabase:`, error);
      throw new Error(`Error al actualizar en Supabase: ${error.message}`);
    }

    return data;
  }

  /**
   * Obtiene los registros más recientes de Supabase para visualizarlos en la interfaz
   */
  static async getRecentRecords(limit = 15): Promise<FileRecord[]> {
    const { data, error } = await supabase
      .from('archivos')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      console.error('Error consultando registros en Supabase:', error);
      return [];
    }

    return data || [];
  }

  /**
   * Elimina todos los registros de prueba simulados
   */
  static async clearSimulatedRecords(): Promise<number> {
    const { data, error } = await supabase
      .from('archivos')
      .delete()
      .filter('metadata->>modo_simulado', 'eq', 'true')
      .select('id');

    if (error) {
      console.error('Error eliminando registros simulados en Supabase:', error);
      throw new Error(`Error al eliminar registros: ${error.message}`);
    }

    return data ? data.length : 0;
  }
}
