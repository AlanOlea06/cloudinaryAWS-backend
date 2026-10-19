import { Router } from 'express';
import { UploadController } from '../controllers/upload.controller.js';

export const uploadRouter = Router();

// Endpoint oficial de emisión de ticket con validación multi-tenant
uploadRouter.post('/ticket', UploadController.createUploadTicket);

// Endpoint oficial de confirmación de subida directa a S3
uploadRouter.put('/confirm/:ticketId', UploadController.confirmUpload);
uploadRouter.post('/confirm/:ticketId', UploadController.confirmUpload);

// Endpoints de datos de sesión, auditoría y persistencia en Supabase
uploadRouter.get('/auth-data', UploadController.getAuthData);
uploadRouter.get('/records', UploadController.getSupabaseRecords);
uploadRouter.delete('/records', UploadController.clearFileRecords);
