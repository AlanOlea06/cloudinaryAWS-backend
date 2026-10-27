# Inventario Exhaustivo de Rutas y Endpoints de la API

> **Versión**: 2.0.0  
> **Fecha de Actualización**: 27 de Octubre de 2026  
> **Arquitectura**: Next.js 14 Serverless en Vercel + AWS S3 / CloudFront + Supabase PostgreSQL  
> **Principio de Seguridad**: Zero-Knowledge (claves nunca expuestas), Least-Privilege RBAC, y "Ningún archivo binario pasa por Vercel"

---

## 1. Tabla de Rutas

| Método | Ruta | Autenticación Requerida | Privilegios / RBAC | Validaciones Principales | Descripción y Propósito |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **GET, HEAD, OPTIONS** | `/api/health` | **Pública** (sin credenciales) | Ninguno | Ninguna. Retorna únicamente `{ status: 'ok', service: 'cloudinary-aws-backend', timestamp }`. | Healthcheck público para balanceadores y monitoreo; no expone nombres de bucket, IPs ni variables de entorno. |
| **POST** | `/api/upload` | API Key de Organización (`x-api-key`) | `can_upload = true`. Requiere `x-user-id` si la llave es de organización. | Whitelist MIME/extensión, tamaño `<= 25 MB`, cupos de organización (almacenamiento y tickets pendientes). Limpieza oportunista de tickets vencidos antes de evaluar cupo. Checksum SHA-256 opcional. | Emite ticket de subida directa a S3 mediante URL prefirmada PUT con TTL de 5 min y token HMAC criptográfico (`confirmToken`). |
| **PUT** | `/api/upload` (o `action=confirm`) | API Key de Organización (`x-api-key`) | `can_upload = true`. Aislamiento tenant y titularidad del usuario. | Token HMAC válido (TTL 5m + 2m gracia), S3 `HeadObject` (existencia y tamaño), Range GET 32 bytes para Magic Bytes binarios (rechaza con **422 MAGIC_BYTES_MISMATCH** si difiere), verificación SHA-256 (`sha256_verified`). | Confirma la subida exitosa en S3, asigna `fileStatus: 'uploaded'`, genera URL CloudFront para archivos públicos y despacha webhook `file.uploaded` con conexión TCP fijada a la IP pre-validada. |
| **GET** | `/api/upload/multipart` | API Key de Organización (`x-api-key`) | `can_read = true` o `can_upload = true`. Tenant y titularidad. | `ticketId` o `fileId` en UUID. `s3_upload_id` activo. | Consulta partes subidas en S3 (`ListPartsCommand`) para permitir reanudación de subidas grandes interrumpidas. |
| **POST** | `/api/upload/multipart` (`action=create`) | API Key de Organización (`x-api-key`) | `can_upload = true`. Requiere `x-user-id` válido con permiso de subida. | Whitelist MIME/extensión, tamaño `<= 500 MB`, cupos de organización. Limpieza oportunista de tickets vencidos antes de evaluar cupo. | Inicia subida multipart en S3 (`CreateMultipartUploadCommand`), crea ticket en base de datos y entrega token HMAC válido por 60 min. |
| **POST** | `/api/upload/multipart` (`action=presign_part`) | API Key de Organización (`x-api-key`) | `can_upload = true`. Tenant y titularidad. | `partNumber` entero entre 1 y 10000. `s3_upload_id` activo. | Emite URL prefirmada para subir una parte individual a S3 (`UploadPartCommand`) con TTL de 15 minutos. |
| **PUT, POST** | `/api/upload/multipart` (`action=complete`) | API Key de Organización (`x-api-key`) | `can_upload = true`. Tenant y titularidad. | Token HMAC válido (60 min), partes completadas en S3, Range GET 32 bytes para Magic Bytes (rechaza con **422 MAGIC_BYTES_MISMATCH** si difiere), checksum. | Completa la subida multipart en S3 (`CompleteMultipartUploadCommand`), pasa estado a `'uploaded'`, limpia `s3_upload_id` y despacha webhook `file.uploaded`. |
| **DELETE** | `/api/upload/multipart` (`action=abort`) | API Key de Organización (`x-api-key`) | `can_delete = true`. Tenant y titularidad. | `s3_upload_id` activo. | Aborta la subida multipart en S3 (`AbortMultipartUploadCommand`) y elimina el ticket huérfano. |
| **GET** | `/api/files` | API Key de Organización (`x-api-key`) | `can_read = true`. Multi-tenant estricto. | Filtrado por `org_id` de la llave. Paginación (`limit`, `offset`), filtros de estado. Archivos privados enmascaran CDN URL. | Lista los archivos confirmados de la organización del llamante. |
| **GET** | `/api/files/[id]` | API Key de Organización (`x-api-key`) | `can_read = true`. Tenant y propietario si es privado. | UUID v4 válido. Archivos privados requieren que el usuario sea el propietario y emiten URL prefirmada de S3 con TTL de 5 min (`cloudfrontUrl: null`). Archivos públicos entregan URL de CloudFront CDN. | Obtiene metadata detallada del archivo, URL de acceso (CDN pública o firmada temporal privada) y estado de verificación sha256. |
| **DELETE** | `/api/files/[id]` | API Key de Organización (`x-api-key`) | `can_delete = true`. Tenant y titularidad. | UUID v4 válido. Deduplicación de claves S3 (`new Set([s3_pending_key, s3_processed_key])`). | Elimina físicamente el objeto de S3 (`DeleteObjectCommand`) y borra el registro de `public.files`. |
| **GET** | `/api/files/[id]/status` | API Key de Organización (`x-api-key`) | `can_read = true`. Multi-tenant y titularidad. | UUID v4 válido. No expone CloudFront URL en privados. Respeta `ENABLE_SERVER_PROCESSING_FALLBACK` (nunca marca 'failed' un archivo 'uploaded'). | Consulta el estado transaccional del archivo (`uploaded`, `scan_status`, `sha256_verified`). Es la **fuente de verdad** para clientes. |
| **POST** | `/api/files/[id]/status` | API Key de Organización (`x-api-key`) | `can_upload = true`. Multi-tenant. | UUID v4 válido. Solo dispara webhooks usando la configuración de la organización (ignora URLs o secretos enviados por cliente). | Disparo manual de re-notificación Webhook hacia la URL registrada de la organización. |
| **GET** | `/api/organizations` | Admin (`x-admin-secret`) O Llave Delegada (`can_manage_keys=true`) | Admin: cualquier organización. Llave Delegada: estrictamente su propia organización (`user_id` nulo). | Filtro opcional `?id=<uuid>`. Rate limiting unificado. | Consulta la configuración, cuotas y webhook configurado de la organización. |
| **PATCH** | `/api/organizations` | Admin (`x-admin-secret`) O Llave Delegada (`can_manage_keys=true`) | Admin: cuotas (`max_storage_bytes`, `max_pending_tickets`, `max_api_keys`), nombres y webhooks. Llave Delegada: **únicamente** `webhook_url` y `webhook_secret` de su propia org (intento de tocar cuotas retorna 403 `FORBIDDEN_QUOTA_MODIFICATION`). | Validación SSRF estricta en `webhook_url` (solo HTTPS público, bloqueo de loopback, link-local, privadas y octales/decimales). | Actualiza la configuración de organización y credenciales de webhook de forma segura. |
| **GET** | `/api/keys` | Admin (`x-admin-secret`) O Llave Delegada (`can_manage_keys=true`) | Si es Delegada: solo consulta su propia organización (`user_id` debe ser nulo). | Rate limit en memoria y compartido en BD (20 req / 60s). Re-lee la llave en base de datos sin confiar en cabeceras internas. | Lista las API Keys activas de la organización (oculta llaves en claro y hashes completos). |
| **POST** | `/api/keys` | Admin (`x-admin-secret`) O Llave Delegada (`can_manage_keys=true`) | Delegada: siempre crea con `can_manage_keys=false`. Anti-escalada de permisos (no puede otorgar permisos que no posee). | Cupo atómico de `max_api_keys` mediante trigger con bloqueo `FOR UPDATE`. Formato UUID, nombre 2-80 caracteres. `Cache-Control: private, no-store`. | Genera una nueva API Key de 256 bits (`sk_live_...`). Se muestra una sola vez al cliente (Zero-Knowledge). Registra auditoría en `service_logs`. |
| **PATCH** | `/api/keys` | **Exclusivo Admin** (`x-admin-secret`) | Solo administrador de plataforma. | UUID v4 válido. Prohibido asignar `can_manage_keys=true` a llaves vinculadas a un usuario (`user_id` no nulo). | Modifica privilegios, nombres o promueve llaves existentes a administradoras de organización. |
| **DELETE** | `/api/keys` | Admin (`x-admin-secret`) O Llave Delegada (`can_manage_keys=true`) | Delegada: anti-auto-eliminación (`CANNOT_DELETE_SELF`) y protección de última llave administradora (`CANNOT_DELETE_LAST_MANAGE_KEY`). Aislamiento tenant (404 al intentar revocar llaves de otra org). | Multi-tenant estricto. Permite modo `delete` (físico) o `revoke` (`is_active=false`). Auditoría en `service_logs`. | Revoca o elimina una API Key de la organización. |
| **GET, POST** | `/api/cron/maintenance` | Bearer Token (`CRON_SECRET`) | Cron Runner interno / Vercel Cron. | Token verificado contra variable `CRON_SECRET`. | Ejecuta 5 tareas de mantenimiento: borrado de tickets vencidos (>7 min), cancelación de multiparts abandonados (>75 min), reintentos de webhooks con backoff exponencial, limpieza de buckets de rate limit (>1 día) y retención de IPs en logs (30 días). |
| **GET, POST** | `/api/logs` | **Exclusivo Admin** (`x-admin-secret`) | Solo administrador de plataforma. | Filtros por `org_id`, acción, fechas. | Consulta pistas de auditoría registradas en `public.service_logs`. |
| **GET** | `/api/records` | **Exclusivo Admin** (`x-admin-secret`) | Solo administrador de plataforma. | Métricas agregadas y analíticas. | Monitoreo administrativo de uso de almacenamiento y estadísticas globales. |
| **GET, POST, PATCH** | `/api/users` | **Exclusivo Admin** (`x-admin-secret`) | Solo administrador de plataforma. | Validaciones de esquema de usuario, aislamiento de organización y flag `can_upload`. | Gestión administrativa de usuarios internos de las organizaciones cliente. |
| **GET, POST** | `/api/webhooks/test-receiver` | Firma Webhook HMAC (`x-webhook-signature`) O Admin (`x-admin-secret`) | Permitido en producción para validación de entregas; `PUT` deshabilitado en producción. | Verificación de firma HMAC-SHA256 (`x-webhook-signature`) con búsqueda de `webhook_secret` en base de datos y timestamp anti-replay. | Receptor de pruebas para inspeccionar payloads y validar firmas de webhooks emitidos. |
| **POST** | `/api/test/cleanup` | **Deshabilitado en Producción** (dev: `x-admin-secret`) | Bloqueado en producción con HTTP 403 `ENDPOINT_DISABLED_IN_PRODUCTION`. | Solo entorno de desarrollo. | Limpieza de organizaciones y registros de prueba creados en suites automatizadas. |

---

## 2. Matriz de Cabeceras de Seguridad y Control de Caché

- **Cabeceras de Seguridad Inyectadas Globalmente por el Middleware**:
  - `X-Content-Type-Options: nosniff`
  - `X-Frame-Options: DENY`
  - `Referrer-Policy: strict-origin-when-cross-origin`
  - `Permissions-Policy: camera=(), microphone=(), geolocation=()`
  - `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`
- **Sanitización de Cabeceras Entrantes en Middleware**:
  - Elimina de inmediato cualquier cabecera `x-validated-*`, `x-can-manage-keys`, `x-caller-*` o `x-api-key-*` enviada por el cliente antes de evaluar o inyectar contexto verificado en el servidor.
- **Cache-Control en Rutas Críticas**:
  - `/api/keys`: `private, no-store, no-cache, max-age=0, must-revalidate`
  - `/api/organizations`: `private, no-store, no-cache, max-age=0, must-revalidate`
  - `/api/health`: `no-store, no-cache, must-revalidate`
  - `/api/cron/*`: `private, no-store`
  - Archivos privados S3: `private, no-cache, no-store, max-age=0, must-revalidate`
  - Archivos públicos S3: `public, max-age=31536000, immutable`
