import { z } from 'zod';

const MIME_TYPES_PERMITIDOS = [
  // Imágenes
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/svg+xml',

  // Videos
  'video/mp4',
  'video/quicktime',
  'video/webm',

  // Documentos
  'application/pdf',
  'application/msword', // .doc
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
  'application/vnd.ms-excel', // .xls
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
  'application/vnd.ms-powerpoint', // .ppt
  'application/vnd.openxmlformats-officedocument.presentationml.presentation', // .pptx
  'text/plain', // .txt
  'text/csv', // .csv
  'application/zip', // .zip
  'application/x-zip-compressed',
] as const;

export const requestUploadTicketSchema = z.object({
  userId: z.string().uuid('userId debe ser un UUID válido').or(z.string().min(1)),
  userName: z.string().optional().default('Usuario Anónimo'),
  fileName: z.string().min(1, 'fileName es requerido'),
  fileType: z.string().refine((type) => MIME_TYPES_PERMITIDOS.includes(type as any), {
    message: `Tipo de archivo no permitido. Tipos válidos: imágenes, videos y documentos (PDF, Word, Excel, PPT, TXT, CSV, ZIP).`,
  }),
  fileSize: z.number().positive('fileSize debe ser un número positivo'),
  hashSha256: z.string().optional(),
});

export type RequestUploadTicketInput = z.infer<typeof requestUploadTicketSchema>;
