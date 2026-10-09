import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  PORT: z.string().default('4000'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // AWS S3
  AWS_REGION: z.string().default('us-east-1'),
  AWS_ACCESS_KEY_ID: z.string().default('mock-access-key-id'),
  AWS_SECRET_ACCESS_KEY: z.string().default('mock-secret-access-key'),
  AWS_S3_BUCKET_NAME: z.string().default('mock-s3-bucket'),

  // Supabase
  SUPABASE_URL: z.string().url().default('https://mock-project.supabase.co'),
  SUPABASE_SERVICE_ROLE_KEY: z.string().default('mock-service-role-key'),

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

