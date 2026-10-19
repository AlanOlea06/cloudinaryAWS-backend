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

      // 2. Persistir registro en Supabase (files table)
      const fileRecord = await FileService.createPendingFileRecord({
        ...parsedBody,
        userName: user.nombre,
      });

      // 3. Generar URL prefirmada real en AWS S3
      const uploadUrl = await S3Service.generateUploadPresignedUrl({
        key: fileRecord.s3_key_pendiente,
        contentType: parsedBody.fileType,
        contentLength: parsedBody.fileSize,
      });

      const resourceTypeEnglish = tipoRecurso === 'imagenes' ? 'images' : tipoRecurso === 'videos' ? 'videos' : 'documents';
      const visibilityEnglish = visibilidad === 'privados' ? 'private' : 'public';

      // 4. Calcular la ruta definitiva futura que usará la Lambda
      const projectedProcessedKey = FileService.generateProcessedS3Key(
        orgSlug,
        resourceTypeEnglish,
        visibilityEnglish,
        fileRecord.id,
        parsedBody.fileName
      );

      const isMultipart = parsedBody.fileSize > env.MAX_FILE_SIZE_BYTES;

      // 5. Devolver la respuesta autorizada
      return res.status(200).json({
        status: 'ready',
        ticketId: fileRecord.ticket_id,
        fileId: fileRecord.id,
        uploadUrl,
        isMultipart,
        isRealS3: true,
        organizacion: org,
        usuario: { id: user.id, nombre: user.nombre, rol: user.rol },
        visibilidad,
        tipoRecurso,
        s3Hierarchy: {
          landingZone: fileRecord.s3_key_pendiente,
          permanentTarget: projectedProcessedKey,
          auditDirectory: `logs/${orgSlug}/`,
        },
        metadata: {
          key: fileRecord.s3_key_pendiente,
          bucket: env.AWS_S3_BUCKET_NAME,
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
   * Endpoint oficial de confirmación de subida a S3
   */
  static async confirmUpload(req: Request, res: Response) {
    const { ticketId } = req.params;

    try {
      const updatedRecord = await FileService.updateFileRecordByTicket(ticketId, {
        estado: 'completado',
      });

      if (!updatedRecord) {
        return res.status(404).json({
          status: 'error',
          message: `Ticket "${ticketId}" no encontrado en Supabase`,
        });
      }

      await AuthService.logAuditoria({
        orgId: updatedRecord.org_id,
        userId: updatedRecord.user_id,
        accion: 'S3_UPLOAD_CONFIRMED',
        estado: 'ALLOWED',
        detalles: {
          ticketId,
          fileName: updatedRecord.nombre_original,
          status: 'completed',
        },
      });

      return res.status(200).json({
        status: 'success',
        message: 'Subida confirmada exitosamente en S3 y Supabase',
        ticketId,
        record: updatedRecord,
        timestamp: new Date().toISOString(),
      });
    } catch (error: any) {
      console.error('Error confirmando subida en Supabase:', error);
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
   * Limpiar registros de la tabla files
   */
  static async clearFileRecords(_req: Request, res: Response) {
    try {
      const count = await FileService.clearFileRecords();
      return res.status(200).json({
        message: `Se eliminaron ${count} registros de Supabase exitosamente.`,
        deletedCount: count,
      });
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  }
}
