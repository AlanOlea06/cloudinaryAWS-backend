import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  PORT: z.string().default('4000'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // AWS S3 (Credenciales reales de producción)
  AWS_REGION: z.string().default('us-east-1'),
  AWS_ACCESS_KEY_ID: z.string().min(1, 'AWS_ACCESS_KEY_ID es requerido'),
  AWS_SECRET_ACCESS_KEY: z.string().min(1, 'AWS_SECRET_ACCESS_KEY es requerido'),
  AWS_S3_BUCKET_NAME: z.string().min(1, 'AWS_S3_BUCKET_NAME es requerido'),

  // Supabase (Conexión real)
  SUPABASE_URL: z.string().url('SUPABASE_URL debe ser una URL válida'),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1, 'SUPABASE_SERVICE_ROLE_KEY es requerido'),

  // Opciones de subida endurecidas
  UPLOAD_URL_EXPIRATION_SECONDS: z.coerce.number().default(300), // 5 min (Hardened TTL)
  MAX_FILE_SIZE_BYTES: z.coerce.number().default(100 * 1024 * 1024), // 100 MB

  // Amazon CloudFront CDN
  AWS_CLOUDFRONT_DOMAIN: z.string().optional().default(''),
  AWS_CLOUDFRONT_KEY_PAIR_ID: z.string().optional().default(''),
  AWS_CLOUDFRONT_PRIVATE_KEY: z.string().optional().default(''),
});

export const env = envSchema.parse(process.env);

