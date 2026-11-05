# Cloudinary Clone - Servicio Backend (Next.js App Router en Vercel)

Servidor encargado de la orquestación de subidas multimedia, aislamiento multi-tenant en 3ra Forma Normal (3NF) con arquitectura **agnóstica de base de datos SQL** (Drizzle ORM + PostgreSQL directo), emisión de URLs prefirmadas (**S3 Pre-signed URLs**) y entrega por CDN (**Amazon CloudFront**).

---

## Requisitos Previos

- **Node.js**: v20+
- **AWS**: Cuenta con acceso a S3 y distribución CloudFront (`/static/*`).
- **Base de Datos SQL**: PostgreSQL 15+ (AWS RDS, Neon, Supabase Pooler, Docker) o cualquier motor SQL compatible con los esquemas en `database/universal/` (`schema.postgresql.sql`, `schema.mysql.sql`, `schema.sqlite.sql`).

---

## Variables de Entorno

Configurar en Vercel (`Project -> Settings -> Environment Variables`) y en local mediante `.env` (excluido por `.gitignore`):

### Conexión Directa a Base de Datos (Agnóstica SQL / Drizzle ORM):
- `DATABASE_URL`: URI de conexión directa a PostgreSQL (ej. `postgresql://usuario:password@host:5432/postgres`). Si la contraseña contiene `$` o `%`, codificarlos como `%24` y `%25`.

### Variables Operativas y de Infraestructura:
1. `AWS_ACCESS_KEY_ID`
2. `AWS_SECRET_ACCESS_KEY`
3. `AWS_REGION`
4. `AWS_S3_BUCKET_NAME`
5. `AWS_CLOUDFRONT_DOMAIN`
6. `SUPABASE_URL` (compatibilidad / middleware Edge)
7. `SUPABASE_SERVICE_ROLE_KEY` (compatibilidad / fallback HTTP)
8. `TICKET_SIGNING_SECRET` (opcional de rotación: `TICKET_SIGNING_SECRET_PREVIOUS`)
9. `ADMIN_API_SECRET` (opcional de rotación: `ADMIN_API_SECRET_PREVIOUS`)
10. `CRON_SECRET`

---

## Instalación y Puesta en Marcha

1. **Instalar dependencias:**
   ```bash
   npm install
   ```

2. **Modo Desarrollo Local:**
   ```bash
   npm run dev
   ```

3. **Compilar y Ejecutar en Producción (Vercel):**
   ```bash
   npm run build
   npm start
   ```

---

## Healthcheck Público (sin datos sensibles)

- **GET** `/api/health`
- Respuesta (`200 OK`):
  ```json
  {
    "status": "ok",
    "service": "cloudinary-aws-backend",
    "timestamp": "2026-10-26T18:00:00.000Z"
  }
  ```
