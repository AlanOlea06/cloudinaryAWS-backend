import { Request, Response } from 'express';
import { requestUploadTicketSchema } from '../schemas/upload.schema.js';
import { FileService } from '../services/file.service.js';
import { S3Service } from '../services/s3.service.js';
import { AuthService } from '../services/auth.service.js';
import { env } from '../config/env.js';

export class UploadController {
  /**
   * Endpoint de solicitud de ticket con control de acceso multi-tenant
   */
  static async createUploadTicket(req: Request, res: Response) {
    try {
      // 1. Validar la estructura de la petición
      const parsedBody = requestUploadTicketSchema.parse(req.body);

      // =========================================================================
      // COMPROBACIÓN 1: Verificar si el usuario está registrado en el sistema
      // =========================================================================
      const user = await AuthService.findUsuario(parsedBody.userId);
      if (!user) {
        await AuthService.logAuditoria({
          orgId: parsedBody.orgId,
          userId: parsedBody.userId,
          accion: 'PETICION_SUBIDA',
          estado: 'DENEGADO_NO_REGISTRADO',
          detalles: { motivo: 'Usuario no registrado o sesión inválida', fileName: parsedBody.fileName },
        });

        return res.status(401).json({
          status: 'error',
          code: 'UNAUTHORIZED_USER',
          message: `Acceso denegado: El usuario con ID "${parsedBody.userId}" no está registrado en el sistema.`,
        });
      }

      // =========================================================================
      // COMPROBACIÓN 2: Aislamiento Multi-Tenant (Solo subir a su propia organización)
      // =========================================================================
      if (user.org_id !== parsedBody.orgId) {
        const userOrg = await AuthService.findOrganizacion(user.org_id);
        const targetOrg = await AuthService.findOrganizacion(parsedBody.orgId);

        await AuthService.logAuditoria({
          orgId: parsedBody.orgId,
          userId: user.id,
          accion: 'PETICION_SUBIDA',
          estado: 'DENEGADO_OTRA_ORG',
          detalles: {
            userOrg: userOrg?.nombre,
            targetOrg: targetOrg?.nombre,
            fileName: parsedBody.fileName,
          },
        });

        return res.status(403).json({
          status: 'error',
          code: 'FORBIDDEN_ORGANIZATION',
          message: `Violación de aislamiento multi-inquilino: El usuario "${user.nombre}" pertenece a "${userOrg?.nombre || 'otra org'}" y no puede subir archivos a "${targetOrg?.nombre || 'esta organización'}".`,
          allowedOrg: userOrg,
          attemptedOrg: targetOrg,
        });
      }

      // =========================================================================
      // COMPROBACIÓN 3: Permiso específico de subida (puede_subir === true)
      // =========================================================================
      if (!user.puede_subir) {
        await AuthService.logAuditoria({
          orgId: user.org_id,
          userId: user.id,
          accion: 'PETICION_SUBIDA',
          estado: 'DENEGADO_SIN_PERMISO',
          detalles: {
            usuario: user.nombre,
            rol: user.rol,
            fileName: parsedBody.fileName,
          },
        });

        return res.status(403).json({
          status: 'error',
          code: 'FORBIDDEN_NO_PERMISSION',
          message: `Permiso denegado: El usuario "${user.nombre}" (rol: ${user.rol}) no tiene autorización para subir archivos.`,
          user: { id: user.id, nombre: user.nombre, rol: user.rol, puede_subir: user.puede_subir },
        });
      }

      // =========================================================================
      // AUTORIZACIÓN EXITOSA: Registrar auditoría y emitir ticket
      // =========================================================================
      const org = await AuthService.findOrganizacion(user.org_id);
      const orgSlug = org ? org.slug : 'organizacion_1';
      const tipoRecurso = FileService.getTipoRecurso(parsedBody.fileType);
      const visibilidad = parsedBody.visibilidad || 'privados';

      await AuthService.logAuditoria({
        orgId: user.org_id,
        userId: user.id,
        accion: 'PETICION_SUBIDA',
        estado: 'PERMITIDO',
        detalles: {
          usuario: user.nombre,
          organizacion: org?.nombre,
          tipoRecurso,
          visibilidad,
          fileName: parsedBody.fileName,
        },
      });

      // Detectar modo simulación
      const isMockMode =
        req.headers['x-mock-mode'] === 'true' ||
        env.MOCK_MODE ||
        env.AWS_ACCESS_KEY_ID === 'tu_aws_access_key_id';

      // 2. Persistir registro en Supabase
      const fileRecord = await FileService.createPendingFileRecord(
        {
          ...parsedBody,
          userName: user.nombre,
        },
        isMockMode
      );

      // 3. Determinar URL de subida
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

      // 4. Calcular la ruta definitiva futura que usará la Lambda
      const projectedProcessedKey = FileService.generateProcessedS3Key(
        orgSlug,
        tipoRecurso,
        visibilidad,
        fileRecord.id,
        parsedBody.fileName
      );

      const isMultipart = parsedBody.fileSize > (isMockMode ? 5 * 1024 * 1024 : env.MAX_FILE_SIZE_BYTES);

      // 5. Devolver la respuesta autorizada
      return res.status(200).json({
        status: 'ready',
        ticketId: fileRecord.ticket_id,
        fileId: fileRecord.id,
        uploadUrl,
        isMultipart,
        isMock: isMockMode,
        organizacion: org,
        usuario: { id: user.id, nombre: user.nombre, rol: user.rol },
        visibilidad,
        tipoRecurso,
        s3Hierarchy: {
          landingZone: fileRecord.s3_key_pendiente,
          permanentTarget: projectedProcessedKey,
          auditDirectory: `logs de servicio/${orgSlug}/`,
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

      console.error('Error procesando ticket:', error);
      return res.status(500).json({
        status: 'error',
        message: error.message || 'Error interno del servidor central',
      });
    }
  }

  /**
   * Endpoint mock para subida directa (PUT)
   */
  static async mockS3Upload(req: Request, res: Response) {
    const { ticketId } = req.params;

    try {
      await FileService.updateFileRecordByTicket(ticketId, {
        estado: 'subido_pendiente_proc',
      });

      res.setHeader('ETag', `"mock-etag-${Date.now()}"`);
      return res.status(200).json({
        message: 'Simulación: Archivo recibido exitosamente en S3 /Pendientes',
        ticketId,
        s3Status: 200,
        estadoSupabase: 'subido_pendiente_proc',
        timestamp: new Date().toISOString(),
      });
    } catch (error: any) {
      console.error('Error actualizando estado en Supabase:', error);
      return res.status(500).json({ status: 'error', message: error.message });
    }
  }

  /**
   * Endpoint mock de la Lambda: Mueve a Organizaciones/{org}/{tipo}/{visibilidad}/
   */
  static async mockLambdaProcess(req: Request, res: Response) {
    const { ticketId } = req.params;
    const {
      fileType = '',
      fileName = '',
      fileSize = 1024000,
      hashSha256,
      orgSlug = 'organizacion_1',
      visibilidad = 'privados',
    } = req.body || {};

    try {
      const isImage = fileType.startsWith('image/');
      const isVideo = fileType.startsWith('video/');
      const tipoRecurso = isImage ? 'imagenes' : isVideo ? 'videos' : 'documentos';

      let extensionOverride: string | undefined;
      let finalSize = fileSize;
      let savingsPercent = '0%';
      let pipelineEngine = 'AWS GuardDuty / ClamAV';
      let transformations: string[] = [];

      if (isImage) {
        extensionOverride = 'webp';
        finalSize = Math.round(fileSize * 0.22);
        savingsPercent = '78%';
        pipelineEngine = 'Sharp v0.33';
        transformations = ['strip_exif', 'convert_webp', 'auto_compress'];
      } else if (isVideo) {
        extensionOverride = 'mp4';
        finalSize = Math.round(fileSize * 0.65);
        savingsPercent = '35%';
        pipelineEngine = 'AWS Elemental MediaConvert';
        transformations = ['h264_transcode', 'generate_thumbnail', 'metadata_extract'];
      } else {
        finalSize = fileSize;
        savingsPercent = '0% (Original)';
        pipelineEngine = 'AWS GuardDuty Document Pipeline';
        transformations = ['antivirus_scan', 'checksum_verification', 'mime_validation', 'secure_retention'];
      }

      // Estructura exacta requerida: Organizaciones/{org}/{tipo}/{visibilidad}/{archivo}
      const processedKey = FileService.generateProcessedS3Key(
        orgSlug,
        tipoRecurso,
        visibilidad,
        ticketId,
        fileName,
        extensionOverride
      );

      const cloudfrontUrl = visibilidad === 'privados'
        ? `https://cdn.simulador-cloudinary.local/${processedKey}?signed=true&expires=300`
        : `https://cdn.simulador-cloudinary.local/${processedKey}`;

      const metadataLambda = {
        hash_sha256: hashSha256 || null,
        org_slug: orgSlug,
        tipo_recurso: tipoRecurso,
        visibilidad,
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

      const updatedRecord = await FileService.updateFileRecordByTicket(ticketId, {
        estado: 'completado',
        s3_key_procesado: processedKey,
        cloudfront_url: cloudfrontUrl,
        metadata: metadataLambda,
      });

      return res.status(200).json({
        status: 'completado',
        ticketId,
        categoria: tipoRecurso,
        visibilidad,
        record: updatedRecord,
        s3_key_procesado: processedKey,
        cloudfront_url: cloudfrontUrl,
        lambdaProcessing: metadataLambda.pipeline,
        guardDutyScan: metadataLambda.guardDutyScan,
      });
    } catch (error: any) {
      console.error('Error finalizando procesamiento:', error);
      return res.status(500).json({ status: 'error', message: error.message });
    }
  }

  /**
   * Obtener organizaciones y usuarios para el selector de pruebas
   */
  static async getAuthData(_req: Request, res: Response) {
    try {
      const organizaciones = await AuthService.getOrganizaciones();
      const usuarios = await AuthService.getUsuarios();
      return res.status(200).json({ organizaciones, usuarios });
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  }

  /**
   * Obtener registros de Supabase
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
   * Limpiar registros simulados
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
