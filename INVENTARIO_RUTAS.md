# Inventario Exhaustivo de Rutas y Endpoints de la API

> **Versión**: 2.2.0  
> **Fecha de Actualización**: 10 de Noviembre de 2026  
> **Arquitectura**: Next.js 14 + AWS S3 (`pending` -> `public` / `private` por `{org_id}`) + CloudFront CDN + PostgreSQL  
> **Principio de Seguridad**: Zero-Knowledge (claves nunca expuestas), Least-Privilege RBAC, Aislamiento Determinista de Usuarios Multi-Tenant y "Ningún archivo binario pasa por el backend"

---

## 1. Tabla de Rutas (Ordenada por Frecuencia de Uso del Cliente / Desarrollador)

| Prioridad | Método | Ruta | Autenticación Requerida | Privilegios / RBAC | Validaciones Principales | Descripción y Propósito |
| :---: | :--- | :--- | :--- | :--- | :--- | :--- |
| **1 (Uso Diario)** | **POST** | `/api/upload` | API Key de Organización (`x-api-key`) | `can_upload = true`. Requiere `x-user-id` (auto-registra al usuario si no existe en la org). | Whitelist MIME/extensión, tamaño `<= 25 MB`, cupos de organización (almacenamiento y tickets pendientes). Checksum SHA-256 en hexadecimal. | Emite ticket de subida directa a S3 hacia la zona de aterrizaje `static/pending/{org_id}/` mediante URL prefirmada PUT (TTL 5 min) y `confirmToken` HMAC. |
| **2 (Uso Diario)** | **PUT** | `/api/upload?ticketId=<uuid>` | API Key de Organización (`x-api-key`) | `can_upload = true`. Aislamiento tenant y titularidad del usuario. | `confirmToken` HMAC válido (TTL 5m + 2m gracia), S3 `HeadObject`, Range GET 32 bytes para Magic Bytes binarios (rechaza con **422 MAGIC_BYTES_MISMATCH** si difiere) y verificación SHA-256. | Confirma la subida en S3, **promueve el objeto de `static/pending/{org_id}/` hacia `static/public/{org_id}/` o `static/private/{org_id}/`**, asigna `fileStatus: 'uploaded'` y despacha webhook `file.uploaded`. |
| **3 (Uso Diario)** | **GET** | `/api/files/[id]` | API Key de Organización (`x-api-key`) | `can_read = true`. Tenant y propietario (`x-user-id`) si es privado. | UUID v4 válido. Archivos privados exigen que `x-user-id` sea el propietario y emiten URL prefirmada de S3 por 5 min (`static/private/{org_id}/`). Archivos públicos entregan URL permanente de CloudFront (`static/public/{org_id}/`). | Obtiene el link de descarga/visualización (`url`), metadatos del archivo y estado de verificación SHA-256. |
| **4 (Uso Diario)** | **GET** | `/api/files` | API Key de Organización (`x-api-key`) | `can_read = true`. Multi-tenant estricto. | Filtrado por `org_id` de la llave y opcionalmente por `x-user-id` / `?userId=`. Archivos privados mantienen `cloudfront_url: null`. | Lista los archivos registrados en la organización del llamante. |
| **5 (Uso Diario)** | **DELETE** | `/api/files/[id]` | API Key de Organización (`x-api-key`) | `can_delete = true`. Tenant y titularidad. | UUID v4 válido. Limpieza tanto de `s3_pending_key` como de `s3_processed_key`. | Elimina físicamente el archivo de S3, invalida caché en CloudFront (si era público) y borra el registro en PostgreSQL liberando cuota. |
| **6 (Uso Diario)** | **GET** | `/api/files/[id]/status` | API Key de Organización (`x-api-key`) | `can_read = true`. Multi-tenant y titularidad. | UUID v4 válido. No expone CloudFront URL en archivos privados. | Consulta el estado transaccional del archivo (`uploaded`, `scan_status`, `sha256Verified`). |
| **7 (Onboarding)** | **POST** | `/api/organizations` | Código de Invitación (`inviteCode` en body o `x-invite-code`) o `x-admin-secret` | Público con `inviteCode` válido. | Nombre obligatorio (2-80 caracteres), validación anti-SSRF si se incluye `webhookUrl`. | **Onboarding automático en 1 paso**: crea la organización, su usuario administrador inicial y devuelve su API Key Maestra (`sk_live_...`, mostrada una sola vez). |
| **8 (Onboarding)** | **POST** | `/api/users` | API Key de Organización (`x-api-key`) o `x-admin-secret` | Aislado estrictamente a la organización de la `x-api-key`. | `externalUserId` (1-128 chars), `role` (`editor`, `admin` o `viewer`), `canUpload` booleano. Deriva `UUID_SHA256(org_id + ":" + externalUserId)`. | Registra o resuelve un usuario dentro de la organización garantizando **cero colisiones** entre organizaciones distintas. |
| **9 (Onboarding)** | **GET** | `/api/users` | API Key de Organización (`x-api-key`) o `x-admin-secret` | Con `x-api-key`: devuelve únicamente los usuarios de esa organización (`403 FORBIDDEN_CROSS_ORG` si pide otra). | Aislamiento Multi-Tenant por `org_id`. | Lista los usuarios registrados en la organización autenticada. |
| **10 (Archivos Grandes)** | **POST** | `/api/upload/multipart` (`action=create \| presign_part \| complete`) | API Key de Organización (`x-api-key`) | `can_upload = true`. Requiere `x-user-id` con permiso de subida. | Whitelist MIME/extensión, tamaño `<= 500 MB`, partes `>= 5 MB` (salvo la última), validación de Magic Bytes y promoción de `static/pending/{org_id}/` a `public/{org_id}/` o `private/{org_id}/`. | Inicia subida multipart en S3 (`create`), firma cada fragmento (`presign_part`, TTL 15m) y ensambla/promueve el archivo final (`complete`). |
| **11 (Archivos Grandes)** | **GET** | `/api/upload/multipart` | API Key de Organización (`x-api-key`) | `can_read = true` o `can_upload = true`. Tenant y titularidad. | `ticketId` o `fileId` en UUID con `s3_upload_id` activo. | Consulta partes ya subidas en S3 (`ListPartsCommand`) para reanudar subidas interrumpidas. |
| **12 (Archivos Grandes)** | **DELETE** | `/api/upload/multipart` | API Key de Organización (`x-api-key`) | `can_delete = true`. Tenant y titularidad. | `s3_upload_id` activo. | Aborta la subida multipart en S3 (`AbortMultipartUploadCommand`) y limpia partes huérfanas. |
| **13 (Admin Org)** | **GET, POST, DELETE** | `/api/keys` | API Key Maestra (`can_manage_keys=true`) o `x-admin-secret` | Llave Maestra de la organización (`user_id` nulo). | Cupo máximo `max_api_keys` (3 por defecto), anti-escalada de permisos, prohibido auto-eliminarse (`CANNOT_DELETE_SELF`). | Lista, crea o revoca API Keys secundarias (`sk_live_...`) de la organización. |
| **14 (Admin Org)** | **GET, PATCH** | `/api/organizations` | API Key Maestra (`can_manage_keys=true`) o `x-admin-secret` | Con API Key: consulta cuotas y actualiza únicamente `webhookUrl` y `webhookSecret` de su propia organización. | Validación anti-SSRF estricta en `webhookUrl` (solo HTTPS público, bloqueo de IPs privadas/loopback). | Consulta cuotas de la organización y configura Webhooks firmados con HMAC-SHA256. |
| **15 (Auditoría)** | **GET** | `/api/logs` | API Key de Organización (`x-api-key`) o `x-admin-secret` | Con `x-api-key`: devuelve exclusivamente los logs de esa organización (`scope: "organization"`). Con `x-admin-secret`: devuelve todos (`scope: "admin_all"`). | Paginación (`page=1&limit=20`, máx 100), incluye IP real de origen (`ipAddress`). | Consulta de bitácora de auditoría filtrada por organización. |
| **16 (Sistema)** | **GET, HEAD** | `/api/health` | **Pública** (sin credenciales) | Ninguno | Ninguna. | Healthcheck público para balanceadores y monitoreo. |

---

## 2. Estructura de Almacenamiento en S3 por Organización

- **Landing Zone (Subidas en tránsito sin confirmar):** `s3://<bucket>/static/pending/{org_id}/{archivo}`
- **Archivos Públicos Confirmados (CloudFront CDN):** `s3://<bucket>/static/public/{org_id}/{archivo}`
- **Archivos Privados Confirmados (S3 Presigned GET 5m):** `s3://<bucket>/static/private/{org_id}/{archivo}`
