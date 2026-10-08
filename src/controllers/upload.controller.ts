import { Request, Response } from 'express';
import { requestUploadTicketSchema } from '../schemas/upload.schema.js';
import { FileService } from '../services/file.service.js';
import { S3Service } from '../services/s3.service.js';
import { env } from '../config/env.js';

export class UploadController {
  static async createUploadTicket(req: Request, res: Response) {
    try {
      // 1. Validar el payload del BFF o cliente
      const parsedBody = requestUploadTicketSchema.parse(req.body);

      // Detectar si estamos en modo simulación para AWS
      const isMockMode =
        req.headers['x-mock-mode'] === 'true' ||
        env.MOCK_MODE ||
        env.AWS_ACCESS_KEY_ID === 'tu_aws_access_key_id';

      // 2. Persistir SIEMPRE en Supabase (incluso en pruebas/simulación)
      const fileRecord = await FileService.createPendingFileRecord(parsedBody, isMockMode);

      // 3. Determinar la URL de subida
      let uploadUrl: string;
      if (isMockMode) {
        // En simulación apunta a nuestro endpoint mock en Express
        uploadUrl = `/api/upload/mock-s3/${fileRecord.ticket_id}`;
      } else {
        // En modo real genera la S3 Pre-signed URL
        uploadUrl = await S3Service.generateUploadPresignedUrl({
          key: fileRecord.s3_key_pendiente,
          contentType: parsedBody.fileType,
          contentLength: parsedBody.fileSize,
        });
      }

      // 4. Evaluar tamaño para Multipart
      const isMultipart = parsedBody.fileSize > (isMockMode ? 5 * 1024 * 1024 : env.MAX_FILE_SIZE_BYTES);

      // 5. Devolver la respuesta esperada
      return res.status(200).json({
        status: 'ready',
        ticketId: fileRecord.ticket_id,
        fileId: fileRecord.id,
        uploadUrl,
        isMultipart,
        isMock: isMockMode,
        databaseRecord: {
          id: fileRecord.id,
          tabla: 'archivos',
          estado: fileRecord.estado,
        },
        metadata: {
          key: fileRecord.s3_key_pendiente,
          bucket: isMockMode ? 'simulador-s3-pendientes' : env.AWS_S3_BUCKET_NAME,
          fileType: fileRecord.formato,
          fileSize: fileRecord.tamano_bytes,
          expiresIn: env.UPLOAD_URL_EXPIRATION_SECONDS,
        },
      });
    } catch (error: any) {
      if (error.name === 'ZodError') {
        return res.status(400).json({
          status: 'error',
          message: 'Error de validación en la solicitud',
          errors: error.errors,
        });
      }

      console.error('Error generando ticket de subida:', error);
      return res.status(500).json({
        status: 'error',
        message: error.message || 'Error interno del servidor central',
      });
    }
  }

  /**
   * Endpoint de simulación para recibir el PUT y actualizar estado en Supabase a 'subido_pendiente_proc'
   */
  static async mockS3Upload(req: Request, res: Response) {
    const { ticketId } = req.params;

    try {
      // Actualizar en Supabase que el archivo ya cayó en S3 /pendientes
      await FileService.updateFileRecordByTicket(ticketId, {
        estado: 'subido_pendiente_proc',
      });

      res.setHeader('ETag', `"mock-etag-${Date.now()}"`);
      return res.status(200).json({
        message: 'Simulación: Archivo recibido exitosamente en S3 /pendientes',
        ticketId,
        s3Status: 200,
        estadoSupabase: 'subido_pendiente_proc',
        timestamp: new Date().toISOString(),
      });
    } catch (error: any) {
      console.error('Error actualizando estado en Supabase:', error);
      return res.status(500).json({
        status: 'error',
        message: error.message,
      });
    }
  }

  /**
   * Endpoint de simulación de Lambda: procesa con Sharp, escanea con GuardDuty y guarda en Supabase como 'completado'
   */
  static async mockLambdaProcess(req: Request, res: Response) {
    const { ticketId } = req.params;
    const { fileType, fileName, fileSize, hashSha256 } = req.body || {};

    try {
      const optimizedSize = Math.round((fileSize || 1024000) * 0.22); // Simula 78% reducción
      const processedKey = `procesados/user-simulado/${ticketId}.webp`;
      const cloudfrontUrl = `https://cdn.simulador-cloudinary.local/${processedKey}`;

      const metadataLambda = {
        hash_sha256: hashSha256 || null,
        modo_simulado: true,
        guardDutyScan: {
          status: 'CLEAN',
          threatDetected: false,
          scanTimestamp: new Date().toISOString(),
        },
        sharp: {
          engine: 'Sharp v0.33',
          transformations: ['strip_exif', 'convert_webp', 'auto_compress'],
          originalSize: fileSize,
          finalSize: optimizedSize,
          savingsPercent: '78%',
        },
        completado_en: new Date().toISOString(),
      };

      // Actualizar registro en Supabase con la información final
      const updatedRecord = await FileService.updateFileRecordByTicket(ticketId, {
        estado: 'completado',
        s3_key_procesado: processedKey,
        cloudfront_url: cloudfrontUrl,
        metadata: metadataLambda,
      });

      return res.status(200).json({
        status: 'completado',
        ticketId,
        record: updatedRecord,
        s3_key_procesado: processedKey,
        cloudfront_url: cloudfrontUrl,
        lambdaProcessing: metadataLambda.sharp,
        guardDutyScan: metadataLambda.guardDutyScan,
      });
    } catch (error: any) {
      console.error('Error finalizando simulación en Supabase:', error);
      return res.status(500).json({
        status: 'error',
        message: error.message,
      });
    }
  }

  /**
   * Obtener registros recientes directamente de Supabase
   */
  static async getSupabaseRecords(_req: Request, res: Response) {
    try {
      const records = await FileService.getRecentRecords(15);
      return res.status(200).json({ records });
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  }

  /**
   * Limpiar los registros creados durante simulaciones
   */
  static async clearSimulatedRecords(_req: Request, res: Response) {
    try {
      const count = await FileService.clearSimulatedRecords();
      return res.status(200).json({
        message: `Se eliminaron ${count} registros simulados de Supabase exitosamente.`,
        deletedCount: count,
      });
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  }
}
