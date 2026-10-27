# Guía Completa de Pruebas: Doble Autenticación de API Keys, Delegación Segura y AWS S3 Directo

> **Servicio:** Cloudinary Clone Backend (Vercel Serverless)  
> **URL Base:** `https://cloudinary-aws-backend.vercel.app`  
> **Versión Actual:** Sección 3 Reforzada (Doble Autenticación de Llaves: Raíz + Delegadas, Control Atómico de Cupos con Bloqueo de Fila) y Sección 5 (Subida Directa a S3, Range GET 32b, S3 Checksum SHA-256, Estados `uploaded`/`not_scanned`, y **Cero Archivos por Vercel**)  
> **Fecha:** 26 de Octubre de 2026

---

## 🔑 1. MAPA DE AUTENTICACIÓN (¿Qué credencial va en qué ruta?)

| Ruta | Método | Credencial / Cabecera Requerida | Propósito / Quién la usa |
|---|---|---|---|
| `/api/keys` | POST, GET, PATCH, DELETE | `x-admin-secret: <ADMIN_API_SECRET>`<br>-- **O** --<br>`x-api-key: sk_live_...` *(con `can_manage_keys=true`)* | **Doble Autenticación:**<br>1. **Administrador de plataforma (`x-admin-secret`):** Control total entre organizaciones, puede otorgar `canManageKeys=true` y convertir llaves existentes vía `PATCH`.<br>2. **Llave Maestra de Organización (`x-api-key` con `can_manage_keys=true`):** Autoservicio para su propia organización (ignora `orgId` del body, siempre crea con `can_manage_keys=false`, anti-escalada y anti-autoeliminación). |
| `/api/logs` | GET, PATCH, DELETE | `x-admin-secret: <ADMIN_API_SECRET>` | Consulta y limpieza de auditoría global en `service_logs`. |
| `/api/records` | GET, DELETE | `x-admin-secret: <ADMIN_API_SECRET>` | Consulta y limpieza administrativa de `public.files`. |
| `/api/users` | GET | `x-admin-secret: <ADMIN_API_SECRET>` | Catálogo de usuarios y organizaciones registradas. |
| `/api/cron/maintenance` | GET, POST | `Authorization: Bearer <CRON_SECRET>` | Limpieza de tickets expirados y multiparts abortados. |
| `/api/upload` | POST, PUT | `x-api-key: sk_live_...`<br>`x-user-id: <UUID_usuario>` | Solicitud de ticket prefirmado y confirmación con Range GET 32b. |
| `/api/upload/multipart` | POST, GET, DELETE | `x-api-key: sk_live_...`<br>`x-user-id: <UUID_usuario>` | Subida multipart para archivos grandes (>25 MB). |
| `/api/files` | GET, DELETE | `x-api-key: sk_live_...` | Listar archivos de la organización o eliminación. |
| `/api/files/:id` | GET, DELETE | `x-api-key: sk_live_...`<br>*(+ `x-user-id` si es privado)* | Descargar URL prefirmada de S3 (5 min) o CDN CloudFront. |
| `/api/files/:id/status`| GET | `x-api-key: sk_live_...` | Consultar estado del archivo en base de datos. |

---

## 🛡️ 2. REGLAS DE SEGURIDAD EN LA GESTIÓN DE LLAVES

1. **Higienización de Cabeceras (Anti-Spoofing):**
   El middleware elimina incondicionalmente cualquier cabecera interna (`x-validated-*`, `x-can-manage-keys`, `x-caller-*`, `x-api-key-*`) que provenga del cliente antes de inyectar las del servidor. Además, `/api/keys` **no confía en cabeceras inyectadas**: siempre re-consulta Supabase directamente por el hash SHA-256 de la llave llamante.
2. **Llaves Vinculadas a Usuario:**
   Una llave atada a un usuario (`user_id IS NOT NULL`) **jamás puede gestionar llaves** (`can_manage_keys` forzado a `false` en la BD por restricción `CHECK`). Solo las llaves de organización (`user_id IS NULL`) pueden ser maestras.
3. **Cupo Atómico (`max_api_keys`):**
   Se valida en PostgreSQL mediante un Trigger `BEFORE INSERT OR UPDATE` con bloqueo exclusivo de fila:
   `SELECT COALESCE(max_api_keys, 3) FROM public.organizations WHERE id = NEW.org_id FOR UPDATE;`
   Esto serializa transacciones concurrentes y elimina condiciones de carrera (TOCTOU).
4. **Anti-Escalada de Privilegios:**
   Una llave delegada solo puede otorgar los permisos que ella misma posee (`can_read`, `can_upload`, `can_delete`). Si solicita permisos adicionales, el servidor responde `403 Forbidden` y registra `PRIVILEGE_ESCALATION_BLOCKED` en `service_logs`.
5. **Anti-Autoeliminación y Protección de la Última Llave Raíz:**
   Una llave no puede eliminarse ni revocarse a sí misma (`403 CANNOT_DELETE_SELF`). Tampoco se puede revocar la última llave con `can_manage_keys=true` de la organización sin `x-admin-secret` (`403 CANNOT_DELETE_LAST_MANAGE_KEY`).
6. **Políticas de Caché y Cero Divulgación:**
   `/api/keys` responde con `Cache-Control: private, no-store, no-cache, max-age=0, must-revalidate`. Jamás se imprime la llave en texto claro ni su hash completo en logs ni errores.
7. **Rate Limiting:**
   Límite estricto de 20 peticiones por minuto por llave/IP en `/api/keys` *(en memoria por instancia serverless de Vercel)*.

---

## 📋 3. DATOS DE PRUEBA LISTOS PARA USAR

* **Organización 1 (ID):** `11111111-1111-1111-1111-111111111111`
  * **Usuario 1 (Admin org):** `a1111111-0000-0000-0000-000000000001` (Carlos Mendoza)
  * **Usuario 2 (Editor):** `a1111111-0000-0000-0000-000000000002` (Ana Beltrán)
  * **Usuario 3 (Sin permiso de subida):** `a1111111-0000-0000-0000-000000000010` (Valeria Ruiz, `can_upload = false`)
* **Organización 2 (ID):** `22222222-2222-2222-2222-222222222222`
  * **Usuario Org 2:** `b2222222-0000-0000-0000-000000000001` (Mateo Delgado)

---

## 🚀 4. FLUJO COMPLETO DE PRUEBAS PASO A PASO

### PASO 0A: Crear la Primera Llave Maestra de la Organización (POST /api/keys con x-admin-secret)
> **Objetivo:** El administrador de la plataforma crea la llave raíz de la Organización 1 con `canManageKeys: true`.

* **Método:** `POST`
* **URL:** `https://cloudinary-aws-backend.vercel.app/api/keys`
* **Headers:**
  ```http
  Content-Type: application/json
  x-admin-secret: <TU_ADMIN_API_SECRET>
  ```
* **Body (raw JSON):**
  ```json
  {
    "orgId": "11111111-1111-1111-1111-111111111111",
    "name": "Llave Maestra Org 1",
    "canRead": true,
    "canUpload": true,
    "canDelete": true,
    "canManageKeys": true
  }
  ```
* **cURL:**
  ```bash
  curl -X POST https://cloudinary-aws-backend.vercel.app/api/keys \
    -H "Content-Type: application/json" \
    -H "x-admin-secret: <TU_ADMIN_API_SECRET>" \
    -d "{\"orgId\":\"11111111-1111-1111-1111-111111111111\",\"name\":\"Llave Maestra Org 1\",\"canRead\":true,\"canUpload\":true,\"canDelete\":true,\"canManageKeys\":true}"
  ```
* **Respuesta Esperada (HTTP 201 Created):**
  ```json
  {
    "status": "created",
    "message": "IMPORTANTE: Guarda esta API Key en el backend...",
    "apiKey": "sk_live_master_...",
    "keyMetadata": {
      "id": "uuid-llave-maestra",
      "org_id": "11111111-1111-1111-1111-111111111111",
      "user_id": null,
      "name": "Llave Maestra Org 1",
      "can_read": true,
      "can_upload": true,
      "can_delete": true,
      "can_manage_keys": true,
      "is_active": true
    }
  }
  ```

---

### PASO 0B: Crear Llave Secundaria Delegada SIN Admin Secret (POST /api/keys con x-api-key)
> **Objetivo:** La organización crea una llave subordinada usando su propia llave maestra, sin requerir intervención de la administración de la plataforma.

* **Método:** `POST`
* **URL:** `https://cloudinary-aws-backend.vercel.app/api/keys`
* **Headers:**
  ```http
  Content-Type: application/json
  x-api-key: sk_live_master_...
  ```
* **Body (raw JSON):**
  *(Observa que no es necesario enviar `orgId`; el servidor toma el `org_id` de la llave maestra)*:
  ```json
  {
    "name": "Llave Delegada Microservicio Subidas",
    "canRead": true,
    "canUpload": true,
    "canDelete": false
  }
  ```
* **cURL:**
  ```bash
  curl -X POST https://cloudinary-aws-backend.vercel.app/api/keys \
    -H "Content-Type: application/json" \
    -H "x-api-key: sk_live_master_..." \
    -d "{\"name\":\"Llave Delegada Microservicio Subidas\",\"canRead\":true,\"canUpload\":true,\"canDelete\":false}"
  ```
* **Respuesta Esperada (HTTP 201 Created):**
  ```json
  {
    "status": "created",
    "apiKey": "sk_live_subordinada_...",
    "keyMetadata": {
      "id": "uuid-llave-subordinada",
      "org_id": "11111111-1111-1111-1111-111111111111",
      "name": "Llave Delegada Microservicio Subidas",
      "can_read": true,
      "can_upload": true,
      "can_delete": false,
      "can_manage_keys": false
    }
  }
  ```
  *(💡 La llave subordinada tiene forzosamente `can_manage_keys: false`).*

---

### PASO 0C: [Seguridad] Rechazo por Intento de Escalada de Privilegios
> **Objetivo:** Probar que una llave con `can_delete: false` no pueda crear otra llave con `can_delete: true`.

* **Método:** `POST`
* **URL:** `https://cloudinary-aws-backend.vercel.app/api/keys`
* **Headers:**
  ```http
  Content-Type: application/json
  x-api-key: sk_live_subordinada_...
  ```
* **Body:**
  ```json
  {
    "name": "Intento de Escalada",
    "canDelete": true
  }
  ```
* **Respuesta Esperada (HTTP 403 Forbidden):**
  ```json
  {
    "error": "Forbidden",
    "code": "CANNOT_MANAGE_KEYS",
    "message": "La API Key no tiene permisos de administración de llaves (can_manage_keys=false)."
  }
  ```
  *(Y si una llave maestra intenta otorgar permisos que no posee, se rechaza con `403 PRIVILEGE_ESCALATION_BLOCKED` y se audita en `service_logs`).*

---

### PASO 0D: Promover una Llave Existente a Maestra (PATCH /api/keys con x-admin-secret)
> **Objetivo:** Si una organización ya tenía llaves creadas antes de la migración (todas arrancan con `can_manage_keys=false`), el admin de plataforma puede promoverla a maestra sin tener que crear una llave nueva.

* **Método:** `PATCH`
* **URL:** `https://cloudinary-aws-backend.vercel.app/api/keys`
* **Headers:**
  ```http
  Content-Type: application/json
  x-admin-secret: <TU_ADMIN_API_SECRET>
  ```
* **Body:**
  ```json
  {
    "id": "uuid-de-la-llave-existente",
    "canManageKeys": true
  }
  ```
* **Respuesta Esperada (HTTP 200 OK):**
  ```json
  {
    "status": "updated",
    "message": "API Key actualizada exitosamente.",
    "key": {
      "id": "uuid-de-la-llave-existente",
      "can_manage_keys": true
    }
  }
  ```

---

### PASO 0E: [Seguridad] Rechazo de Auto-eliminación (DELETE /api/keys)
> **Objetivo:** Una llave no puede eliminarse ni revocarse a sí misma.

* **Método:** `DELETE`
* **URL:** `https://cloudinary-aws-backend.vercel.app/api/keys?id=<uuid_de_la_llave_maestra>&mode=revoke`
* **Headers:**
  ```http
  x-api-key: sk_live_master_...
  ```
* **Respuesta Esperada (HTTP 403 Forbidden):**
  ```json
  {
    "error": "Forbidden",
    "code": "CANNOT_DELETE_SELF",
    "message": "Una API Key no puede eliminarse ni revocarse a sí misma. Utiliza otra llave administradora o solicita al administrador con x-admin-secret."
  }
  ```

---

### PASO 1: Solicitar Ticket de Subida (POST /api/upload)
> **Objetivo:** Registrar el ticket en la BD y obtener la `uploadUrl` prefirmada de AWS S3. El archivo subirá directo a `static/files/<rand128>.<ext>`.

* **Método:** `POST`
* **URL:** `https://cloudinary-aws-backend.vercel.app/api/upload`
* **Headers:**
  ```http
  Content-Type: application/json
  x-api-key: sk_live_...
  x-user-id: a1111111-0000-0000-0000-000000000001
  ```
* **Body (raw JSON):**
  ```json
  {
    "fileName": "prueba.png",
    "fileType": "image/png",
    "fileSize": 289159,
    "visibility": "private"
  }
  ```
* **cURL:**
  ```bash
  curl -X POST https://cloudinary-aws-backend.vercel.app/api/upload \
    -H "Content-Type: application/json" \
    -H "x-api-key: sk_live_..." \
    -H "x-user-id: a1111111-0000-0000-0000-000000000001" \
    -d "{\"fileName\":\"prueba.png\",\"fileType\":\"image/png\",\"fileSize\":289159,\"visibility\":\"private\"}"
  ```
* **Respuesta Esperada (HTTP 200 OK):**
  ```json
  {
    "status": "success",
    "ticketId": "ab9ceee4-1bfe-4ed3-a3c0-c026f9aa1e37",
    "fileId": "e435ab1d-2c81-4c89-b956-12618e8c7c01",
    "uploadUrl": "https://practicas-alan-418272802078.s3.us-east-1.amazonaws.com/static/files/567c52f9e9f0b3317eb83b27900af74e.png?X-Amz-SignedHeaders=cache-control%3Bcontent-length%3Bcontent-type%3Bhost...",
    "requiredHeaders": {
      "Content-Type": "image/png",
      "Cache-Control": "private, no-store, no-cache, max-age=0, must-revalidate"
    },
    "expiresAt": "2026-10-27T01:35:00.000Z",
    "confirmToken": "ZWQ0OWU5MDEtMWUyOC00M2E3...HMAC"
  }
  ```

---

### PASO 2: Subir el Binario Directamente a AWS S3 (PUT a la uploadUrl)
> **Objetivo:** Enviar los bytes directamente desde el cliente hacia Amazon S3. **Cero bytes por Vercel.**

* **Método:** `PUT`
* **URL:** *(Pega la `uploadUrl` devuelta en el Paso 1)*
* **Headers:** *(Idénticas a las devueltas en `requiredHeaders`)*:
  ```http
  Content-Type: image/png
  Cache-Control: private, no-store, no-cache, max-age=0, must-revalidate
  ```
* **Body en Postman:** Selecciona `binary` y adjunta tu archivo local.
* **cURL:**
  ```bash
  curl -X PUT "<uploadUrl>" \
    -H "Content-Type: image/png" \
    -H "Cache-Control: private, no-store, no-cache, max-age=0, must-revalidate" \
    --data-binary @"./prueba.png"
  ```
* **Respuesta Esperada:** **HTTP 200 OK** (Cuerpo vacío devuelto por AWS S3).

---

### PASO 3: Confirmar la Subida en el Backend (PUT /api/upload)
> **Objetivo:** El servidor valida en S3: HeadObject, Range GET de 32 bytes para verificar el magic number real, y checksum SHA-256. Actualiza el estado a `uploaded` y `scan_status: not_scanned`.

* **Método:** `PUT`
* **URL:** `https://cloudinary-aws-backend.vercel.app/api/upload`
* **Headers:**
  ```http
  Content-Type: application/json
  x-api-key: sk_live_...
  x-user-id: a1111111-0000-0000-0000-000000000001
  ```
* **Body (raw JSON):**
  ```json
  {
    "ticketId": "ab9ceee4-1bfe-4ed3-a3c0-c026f9aa1e37",
    "confirmToken": "<tu_confirmToken_del_paso_1>"
  }
  ```
* **cURL:**
  ```bash
  curl -X PUT https://cloudinary-aws-backend.vercel.app/api/upload \
    -H "Content-Type: application/json" \
    -H "x-api-key: sk_live_..." \
    -H "x-user-id: a1111111-0000-0000-0000-000000000001" \
    -d "{\"ticketId\":\"ab9ceee4-1bfe-4ed3-a3c0-c026f9aa1e37\",\"confirmToken\":\"<confirmToken>\"}"
  ```
* **Respuesta Esperada (HTTP 200 OK):**
  ```json
  {
    "status": "success",
    "fileStatus": "uploaded",
    "scanStatus": "not_scanned",
    "visibility": "private",
    "verification": {
      "magicBytesVerified": true,
      "detectedMimeType": "image/png"
    }
  }
  ```

---

### PASO 4: Consumir / Descargar el Archivo (GET /api/files/:id)
> **Objetivo:** Obtener la URL de entrega. Para privados entrega URL prefirmada de S3 de 5 min (`no-store`) verificando propiedad del archivo; para públicos entrega CDN CloudFront.

* **Método:** `GET`
* **URL:** `https://cloudinary-aws-backend.vercel.app/api/files/<fileId>`
* **Headers:**
  ```http
  x-api-key: sk_live_...
  x-user-id: a1111111-0000-0000-0000-000000000001
  ```
* **Respuesta Esperada para Archivo Privado (HTTP 200 OK):**
  ```json
  {
    "url": "https://practicas-alan-418272802078.s3.us-east-1.amazonaws.com/static/files/567c52f9e9f0b3317eb83b27900af74e.png?X-Amz-Expires=300...",
    "delivery": "s3_presigned",
    "expiresInSeconds": 300,
    "visibility": "private",
    "status": "uploaded",
    "scanStatus": "not_scanned"
  }
  ```
