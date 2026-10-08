import { Router } from 'express';
import { UploadController } from '../controllers/upload.controller.js';

export const uploadRouter = Router();

// Endpoint oficial invocado por el BFF de Next.js o el cliente
uploadRouter.post('/ticket', UploadController.createUploadTicket);

// Endpoints auxiliares para simulación local
uploadRouter.put('/mock-s3/:ticketId', UploadController.mockS3Upload);
uploadRouter.post('/mock-s3/:ticketId', UploadController.mockS3Upload);
uploadRouter.post('/mock-process/:ticketId', UploadController.mockLambdaProcess);

// Endpoints para consultar y limpiar registros de Supabase
uploadRouter.get('/records', UploadController.getSupabaseRecords);
uploadRouter.delete('/records/simulated', UploadController.clearSimulatedRecords);
