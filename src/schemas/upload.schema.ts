import { z } from 'zod';

const MIME_TYPES_PERMITIDOS = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'video/mp4',
  'video/quicktime',
  'video/webm',
] as const;

export const requestUploadTicketSchema = z.object({
  userId: z.string().uuid('userId debe ser un UUID válido').or(z.string().min(1)),
  userName: z.string().optional().default('Usuario Anónimo'),
  fileName: z.string().min(1, 'fileName es requerido'),
  fileType: z.string().refine((type) => MIME_TYPES_PERMITIDOS.includes(type as any), {
    message: `Tipo de archivo no permitido. Tipos válidos: ${MIME_TYPES_PERMITIDOS.join(', ')}`,
  }),
  fileSize: z.number().positive('fileSize debe ser un número positivo'),
  hashSha256: z.string().optional(),
});

export type RequestUploadTicketInput = z.infer<typeof requestUploadTicketSchema>;
