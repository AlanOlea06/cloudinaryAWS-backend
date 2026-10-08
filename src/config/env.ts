import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  PORT: z.string().default('4000'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // AWS S3
  AWS_REGION: z.string().min(1, 'AWS_REGION es requerida'),
  AWS_ACCESS_KEY_ID: z.string().min(1, 'AWS_ACCESS_KEY_ID es requerida'),
  AWS_SECRET_ACCESS_KEY: z.string().min(1, 'AWS_SECRET_ACCESS_KEY es requerida'),
  AWS_S3_BUCKET_NAME: z.string().min(1, 'AWS_S3_BUCKET_NAME es requerida'),

  // Supabase
  SUPABASE_URL: z.string().url('SUPABASE_URL debe ser una URL válida'),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1, 'SUPABASE_SERVICE_ROLE_KEY es requerida'),

  // Opciones de subida
  UPLOAD_URL_EXPIRATION_SECONDS: z.coerce.number().default(900), // 15 min
  MAX_FILE_SIZE_BYTES: z.coerce.number().default(100 * 1024 * 1024), // 100 MB

  // Modo de pruebas / simulación
  MOCK_MODE: z
    .string()
    .optional()
    .default('true')
    .transform((val) => val === 'true' || val === '1'),
});

export const env = envSchema.parse(process.env);

