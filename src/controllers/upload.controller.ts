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

      // 2. Persistir en Supabase
      const fileRecord = await FileService.createPendingFileRecord(parsedBody, isMockMode);

      // 3. Determinar la URL de subida
      let uploadUrl: string;
      if (isMockMode) {
        uploadUrl = `/api/upload/mock-s3/${fileRecord.ticket_id}`;
      } else {
        uploadUrl = await S3Service.generateUploadPresignedUrl({
          key: fileRecord.s3_key_pendiente,
          contentType: parsedBody.fileType,
          contentLength: parsedBody.fileSize,
        });
      }

      // 4. Evaluar tamaño para Multipart
      const isMultipart = parsedBody.fileSize > (isMockMode ? 5 * 1024 * 1024 : env.MAX_FILE_SIZE_BYTES);

      // 5. Devolver la respuesta
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
   * Endpoint de simulación de Lambda: procesa imágenes con Sharp, valida documentos con GuardDuty
   * y guarda en Supabase como 'completado'
   */
  static async mockLambdaProcess(req: Request, res: Response) {
    const { ticketId } = req.params;
    const { fileType = '', fileName = '', fileSize = 1024000, hashSha256 } = req.body || {};

    try {
      const isImage = fileType.startsWith('image/');
      const isVideo = fileType.startsWith('video/');
      const isDocument = !isImage && !isVideo;

      const extension = fileName.includes('.') ? fileName.split('.').pop() : 'bin';
      let processedKey: string;
      let finalSize = fileSize;
      let savingsPercent = '0%';
      let pipelineEngine = 'Document Security & Scan';
      let transformations: string[] = [];

      if (isImage) {
        processedKey = `procesados/user-simulado/${ticketId}.webp`;
        finalSize = Math.round(fileSize * 0.22);
        savingsPercent = '78%';
        pipelineEngine = 'Sharp v0.33';
        transformations = ['strip_exif', 'convert_webp', 'auto_compress'];
      } else if (isVideo) {
        processedKey = `procesados/user-simulado/${ticketId}.mp4`;
        finalSize = Math.round(fileSize * 0.65);
        savingsPercent = '35%';
        pipelineEngine = 'AWS Elemental MediaConvert';
        transformations = ['h264_transcode', 'generate_thumbnail', 'metadata_extract'];
      } else {
        // Documentos (PDF, Office, TXT, etc.): se conserva el archivo original íntegro
        processedKey = `procesados/user-simulado/${ticketId}.${extension}`;
        finalSize = fileSize;
        savingsPercent = '0% (Original)';
        pipelineEngine = 'AWS GuardDuty / ClamAV Scanner';
        transformations = ['antivirus_scan', 'checksum_verification', 'mime_validation', 'secure_retention'];
      }

      const cloudfrontUrl = `https://cdn.simulador-cloudinary.local/${processedKey}`;

      const metadataLambda = {
        hash_sha256: hashSha256 || null,
        tipo_categoria: isImage ? 'imagen' : isVideo ? 'video' : 'documento',
        modo_simulado: true,
        guardDutyScan: {
          status: 'CLEAN',
          threatDetected: false,
          scanTimestamp: new Date().toISOString(),
        },
        pipeline: {
          engine: pipelineEngine,
          transformations,
          originalSize: fileSize,
          finalSize,
          savingsPercent,
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
        categoria: metadataLambda.tipo_categoria,
        record: updatedRecord,
        s3_key_procesado: processedKey,
        cloudfront_url: cloudfrontUrl,
        lambdaProcessing: metadataLambda.pipeline,
        guardDutyScan: metadataLambda.guardDutyScan,
      });
    } catch (error: any) {
      console.error('Error finalizando procesamiento en Supabase:', error);
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
