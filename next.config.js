const MANDATORY_ENV_VARS = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_REGION',
  'AWS_S3_BUCKET_NAME',
  'AWS_CLOUDFRONT_DOMAIN',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'TICKET_SIGNING_SECRET',
  'ADMIN_API_SECRET',
  'CRON_SECRET',
];

const missingEnvVars = MANDATORY_ENV_VARS.filter((name) => {
  const val = process.env[name];
  return typeof val !== 'string' || val.trim().length === 0;
});

if (missingEnvVars.length > 0) {
  throw new Error(
    `[ENV_VALIDATION_FAILED] Faltan variables de entorno obligatorias (${missingEnvVars.length}): ${missingEnvVars.join(', ')}. El build o arranque de Next.js fue abortado porque no se permiten valores por defecto.`
  );
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  async headers() {
    return [
      {
        // Aplica las políticas CORS a todos los endpoints bajo /api/
        source: '/api/:path*',
        headers: [
          { key: 'Access-Control-Allow-Credentials', value: 'true' },
          { key: 'Access-Control-Allow-Origin', value: 'http://localhost:3000' },
          { key: 'Access-Control-Allow-Methods', value: 'GET,POST,PUT,DELETE,OPTIONS' },
          {
            key: 'Access-Control-Allow-Headers',
            value:
              'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization, x-api-key, x-user-id, x-end-user-id, x-admin-secret',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
