import { Router } from 'express';
import { UploadController } from '../controllers/upload.controller.js';

export const uploadRouter = Router();

// Endpoint oficial de emisión de ticket con validación multi-tenant
uploadRouter.post('/ticket', UploadController.createUploadTicket);

// Endpoints auxiliares para simulación local
uploadRouter.put('/mock-s3/:ticketId', UploadController.mockS3Upload);
uploadRouter.post('/mock-s3/:ticketId', UploadController.mockS3Upload);
uploadRouter.post('/mock-process/:ticketId', UploadController.mockLambdaProcess);

// Endpoints de datos de sesión, auditoría y persistencia en Supabase
uploadRouter.get('/auth-data', UploadController.getAuthData);
uploadRouter.get('/records', UploadController.getSupabaseRecords);
uploadRouter.delete('/records/simulated', UploadController.clearSimulatedRecords);
