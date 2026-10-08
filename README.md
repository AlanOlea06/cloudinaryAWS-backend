# Cloudinary Clone - Servidor Central (Node.js + TypeScript)

Servidor central encargado de la orquestación de subidas multimedia, autenticación con Supabase, registro de metadatos y emisión de URLs prefirmadas (**S3 Pre-signed URLs**) para el patrón arquitectónico de **Direct Upload**.

---

## 🛠️ Requisitos Previos

- **Node.js**: v20+ o v24+
- **AWS**: Cuenta con acceso a S3 y credenciales IAM (`s3:PutObject`).
- **Supabase**: Proyecto configurado con PostgreSQL.

---

## 🚀 Instalación y Puesta en Marcha

1. **Instalar dependencias:**
   ```bash
   npm install
   ```

2. **Configurar variables de entorno:**
   Copia el archivo `.env.example` a `.env`:
   ```bash
   cp .env.example .env
   ```
   Rellena los valores reales de AWS y Supabase:
   - `AWS_REGION`
   - `AWS_ACCESS_KEY_ID`
   - `AWS_SECRET_ACCESS_KEY`
   - `AWS_S3_BUCKET_NAME`
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`

3. **Ejecutar el esquema de Base de Datos:**
   Abre el archivo `supabase_schema.sql` y ejecútalo en el **SQL Editor** de tu panel de Supabase.

4. **Modo Desarrollo:**
   ```bash
   npm run dev
   ```

5. **Compilar y Ejecutar en Producción (Railway):**
   ```bash
   npm run build
   npm start
   ```

---

## 🛡️ Configuración de CORS en AWS S3

Para permitir que el navegador suba el archivo directamente usando la Pre-signed URL emitida por este servidor, debes agregar la siguiente regla CORS en la consola de AWS S3 (*Tu Bucket* > *Permissions* > *Cross-origin resource sharing*):

```json
[
  {
    "AllowedHeaders": ["*"],
    "AllowedMethods": ["PUT", "POST", "GET"],
    "AllowedOrigins": ["http://localhost:3000", "https://*.vercel.app"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

---

## 📡 Endpoints

### 1. Healthcheck
- **GET** `/health`
- Respuesta:
  ```json
  {
    "status": "ok",
    "service": "cloudinary-clone-central-server",
    "timestamp": "2026-10-08T10:00:00.000Z"
  }
  ```

### 2. Generar Ticket y Pre-signed URL
- **POST** `/api/upload/ticket`
- **Body esperado (desde el BFF de Next.js):**
  ```json
  {
    "userId": "d3b07384-d113-4f44-98a4-123456789abc",
    "userName": "Alan",
    "fileName": "avatar.png",
    "fileType": "image/png",
    "fileSize": 204800
  }
  ```
- **Respuesta (200 OK):**
  ```json
  {
    "status": "ready",
    "ticketId": "a910ec3f-2b04-46c5-8f6b-abcdef123456",
    "fileId": "e3052db2-5e60-4927-b50a-987654321def",
    "uploadUrl": "https://tu-bucket.s3.us-east-1.amazonaws.com/pendientes/d3b07384.../...",
    "isMultipart": false,
    "metadata": {
      "key": "pendientes/d3b07384.../e3052db2...-avatar.png",
      "bucket": "tu-bucket-cloudinary-clone",
      "fileType": "image/png",
      "fileSize": 204800,
      "expiresIn": 900
    }
  }
  ```
