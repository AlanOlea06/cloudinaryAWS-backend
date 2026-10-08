import { randomUUID } from 'node:crypto';
import { supabase } from '../config/supabase.js';
import { RequestUploadTicketInput } from '../schemas/upload.schema.js';

export interface FileRecord {
  id: string;
  ticket_id: string;
  user_id: string;
  user_name: string;
  nombre_original: string;
  formato: string;
  tamano_bytes: number;
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
   * Genera una clave limpia para el archivo en la carpeta /pendientes de S3
   */
  static generatePendingS3Key(userId: string, fileId: string, fileName: string): string {
    const sanitizedFileName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
    return `pendientes/${userId}/${fileId}-${sanitizedFileName}`;
  }

  /**
   * Registra el ticket de subida en Supabase con estado 'pendiente_subida'
   */
  static async createPendingFileRecord(
    input: RequestUploadTicketInput,
    isMock = false
  ): Promise<FileRecord> {
    const fileId = randomUUID();
    const ticketId = randomUUID();

    // Asegurar que userId sea un UUID válido para PostgreSQL
    const validUserId = UUID_REGEX.test(input.userId) ? input.userId : randomUUID();
    const s3Key = this.generatePendingS3Key(validUserId, fileId, input.fileName);

    const initialMetadata = {
      hash_sha256: input.hashSha256 || null,
      modo_simulado: isMock,
      ip_cliente: '127.0.0.1',
      creado_en: new Date().toISOString(),
    };

    const { data, error } = await supabase
      .from('archivos')
      .insert({
        id: fileId,
        ticket_id: ticketId,
        user_id: validUserId,
        user_name: input.userName || 'Usuario Anónimo',
        nombre_original: input.fileName,
        formato: input.fileType,
        tamano_bytes: input.fileSize,
        s3_key_pendiente: s3Key,
        estado: 'pendiente_subida',
        metadata: initialMetadata,
      })
      .select('*')
      .single();

    if (error) {
      console.error('Error insertando en Supabase:', error);
      throw new Error(`Error al persistir archivo en Supabase: ${error.message}`);
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
  static async getRecentRecords(limit = 10): Promise<FileRecord[]> {
    const { data, error } = await supabase
      .from('archivos')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      console.error('Error consultando registros en Supabase:', error);
      throw new Error(`Error al consultar Supabase: ${error.message}`);
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
