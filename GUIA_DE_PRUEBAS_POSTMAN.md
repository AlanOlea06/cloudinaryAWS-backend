# Guía Completa de Pruebas en Postman: Cabeceras (Headers), Métodos, Bodies y Respuestas

> **Servicio:** Cloudinary Clone Backend (Vercel Serverless)  
> **URL Base:** `https://cloudinary-aws-backend.vercel.app`  
> **Versión Actual:** 2.0.0 (Hardening Batch — Verificado en Producción)  
> **Fecha:** 27 de Octubre de 2026  
> **Colección Postman Lista para Importar:** [`postman_collection.json`](file:///C:/Users/alano/Desktop/github/cloudinary-project/servicio/postman_collection.json)

---

## 🔑 1. TABLA RÁPIDA DE CABECERAS (HEADERS) POR CADA PETICIÓN DE POSTMAN

Aquí tienes **exactamente qué cabeceras (`Key` y `Value`) debes poner en la pestaña `Headers` de Postman** para cada una de las 31 peticiones:

| # en Postman | Método y Ruta | Cabeceras Obligatorias en Postman (`Key: Value`) |
| :--- | :--- | :--- |
| **0.0** | `GET /api/health` | *(Ninguna cabecera — Ruta pública)* |
| **0.0A** | `GET /api/organizations` | `x-api-key: <TU_API_KEY_MAESTRA>`<br>*(O bien: `x-admin-secret: <TU_ADMIN_API_SECRET>`)* |
| **0.0B** | `PATCH /api/organizations` *(Configurar Webhook)* | `Content-Type: application/json`<br>`x-api-key: <TU_API_KEY_MAESTRA>` |
| **0.0C** | `PATCH /api/organizations` *(Prueba 403 Cuotas)* | `Content-Type: application/json`<br>`x-api-key: <TU_API_KEY_MAESTRA>` |
| **0.0D** | `PATCH /api/organizations` *(Prueba 400 SSRF)* | `Content-Type: application/json`<br>`x-api-key: <TU_API_KEY_MAESTRA>` |
| **0.0E** | `PATCH /api/organizations` *(Admin Cuotas)* | `Content-Type: application/json`<br>`x-admin-secret: <TU_ADMIN_API_SECRET>` |
| **0.1A** | `POST /api/keys` *(Crear Llave Maestra)* | `Content-Type: application/json`<br>`x-admin-secret: <TU_ADMIN_API_SECRET>` |
| **0.1B** | `POST /api/keys` *(Crear Llave Delegada)* | `Content-Type: application/json`<br>`x-api-key: <TU_API_KEY_MAESTRA>` |
| **0.1C** | `POST /api/keys` *(Prueba 403 Escalada)* | `Content-Type: application/json`<br>`x-api-key: <TU_API_KEY_SECUNDARIA>` |
| **0.1D** | `PATCH /api/keys` *(Promover a Maestra)* | `Content-Type: application/json`<br>`x-admin-secret: <TU_ADMIN_API_SECRET>` |
| **0.2A** | `GET /api/keys?org_id=...` *(Admin)* | `x-admin-secret: <TU_ADMIN_API_SECRET>` |
| **0.2B** | `GET /api/keys` *(Organización)* | `x-api-key: <TU_API_KEY_MAESTRA>` |
| **0.3A** | `DELETE /api/keys?id=...` *(Prueba 403 Auto-borrado)* | `x-api-key: <TU_API_KEY_MAESTRA>` |
| **0.3B** | `DELETE /api/keys?id=...` *(Prueba 404 Otra Org)* | `x-api-key: <TU_API_KEY_MAESTRA>` |
| **0.3C** | `DELETE /api/keys?id=...` *(Revocar Secundaria)* | `x-api-key: <TU_API_KEY_MAESTRA>` |
| **1** | `POST /api/upload` *(Ticket Simple)* | `Content-Type: application/json`<br>`x-api-key: <TU_API_KEY>`<br>`x-user-id: a1111111-0000-0000-0000-000000000001` |
| **1.0B** | `POST /api/upload` *(Ticket con SHA-256)* | `Content-Type: application/json`<br>`x-api-key: <TU_API_KEY>`<br>`x-user-id: a1111111-0000-0000-0000-000000000001` |
| **1.1** | `POST /api/upload` *(Prueba 403 Usuario Otra Org)* | `Content-Type: application/json`<br>`x-api-key: <TU_API_KEY>`<br>`x-user-id: b2222222-0000-0000-0000-000000000001` |
| **1.2** | `POST /api/upload` *(Prueba 400 Sin x-user-id)* | `Content-Type: application/json`<br>`x-api-key: <TU_API_KEY>` *(Sin `x-user-id`)* |
| **2** | `PUT <uploadUrl>` *(Subir Binario a S3)* | **Privado:**<br>`Content-Type: image/png`<br>`Cache-Control: private, no-store, no-cache, max-age=0, must-revalidate`<br>*(+ `x-amz-checksum-sha256: <base64>` si enviaste `sha256Hash` en el Paso 1.0B)*<br>**Público:**<br>`Content-Type: image/png`<br>`Cache-Control: public, max-age=31536000, immutable`<br>⚠️ **NO enviar `x-api-key` ni `x-user-id` a S3.** |
| **3** | `PUT /api/upload` *(Confirmar Subida)* | `Content-Type: application/json`<br>`x-api-key: <TU_API_KEY>`<br>`x-user-id: a1111111-0000-0000-0000-000000000001` |
| **3.1** | `GET /api/files` *(Listar Archivos)* | `x-api-key: <TU_API_KEY>`<br>`x-user-id: a1111111-0000-0000-0000-000000000001` |
| **3.2** | `GET /api/files/:id` *(Leer como Dueño)* | `x-api-key: <TU_API_KEY>`<br>`x-user-id: a1111111-0000-0000-0000-000000000001` |
| **3.2B** | `GET /api/files/:id` *(Prueba 403 No Dueño)* | `x-api-key: <TU_API_KEY>`<br>`x-user-id: a1111111-0000-0000-0000-000000000002` |
| **3.3** | `GET <downloadUrl>` *(Descargar de S3/CDN)* | *(Ninguna cabecera — La firma ya va en la URL de S3)* |
| **3.4** | `GET /api/files/:id/status` *(Ver Estado)* | `x-api-key: <TU_API_KEY>`<br>`x-user-id: a1111111-0000-0000-0000-000000000001` |
| **3.5** | `POST /api/files/:id/status` *(Re-enviar Webhook)* | `Content-Type: application/json`<br>`x-api-key: <TU_API_KEY>`<br>`x-user-id: a1111111-0000-0000-0000-000000000001` |
| **3.6** | `DELETE /api/files/:id` *(Borrar Archivo)* | `x-api-key: <TU_API_KEY>`<br>`x-user-id: a1111111-0000-0000-0000-000000000001` |
| **4.1** | `POST /api/upload/multipart` *(action=create)* | `Content-Type: application/json`<br>`x-api-key: <TU_API_KEY>`<br>`x-user-id: a1111111-0000-0000-0000-000000000001` |
| **4.2 / 4.3**| `POST /api/upload/multipart` *(action=presign_part)*| `Content-Type: application/json`<br>`x-api-key: <TU_API_KEY>`<br>`x-user-id: a1111111-0000-0000-0000-000000000001` |
| **4.4 / 4.5**| `PUT <partUploadUrl>` *(Subir Parte a S3)* | *(Ninguna cabecera extra — Solo `Body -> binary` con el archivo de 5 MB. NO enviar `x-api-key` a S3)* |
| **4.6** | `GET /api/upload/multipart?ticketId=...` | `x-api-key: <TU_API_KEY>`<br>`x-user-id: a1111111-0000-0000-0000-000000000001` |
| **4.7** | `PUT /api/upload/multipart` *(Completar)* | `Content-Type: application/json`<br>`x-api-key: <TU_API_KEY>`<br>`x-user-id: a1111111-0000-0000-0000-000000000001` |
| **4.8** | `DELETE /api/upload/multipart?ticketId=...` | `x-api-key: <TU_API_KEY>`<br>`x-user-id: a1111111-0000-0000-0000-000000000001` |
| **5** | `GET /api/webhooks/test-receiver` | `x-admin-secret: <TU_ADMIN_API_SECRET>` |
| **6** | `GET /api/logs` | `x-admin-secret: <TU_ADMIN_API_SECRET>` |
| **7** | `GET /api/records` | `x-admin-secret: <TU_ADMIN_API_SECRET>` |
| **8** | `GET /api/users` | `x-admin-secret: <TU_ADMIN_API_SECRET>` |
| **9** | `GET /api/cron/maintenance` | `Authorization: Bearer <TU_CRON_SECRET>` |

---

## 📋 2. VARIABLES DE LA COLECCIÓN POSTMAN

Al importar [`postman_collection.json`](file:///C:/Users/alano/Desktop/github/cloudinary-project/servicio/postman_collection.json) en Postman, todas las cabeceras anteriores **ya están preconfiguradas** usando estas variables en la pestaña **Variables** de la colección:

| Variable | Valor por Defecto / Ejemplo | Descripción |
| :--- | :--- | :--- |
| `baseUrl` | `https://cloudinary-aws-backend.vercel.app` | URL de producción en Vercel. |
| `adminSecret` | *(Tu `ADMIN_API_SECRET`)* | Secreto administrativo de plataforma. |
| `cronSecret` | *(Tu `CRON_SECRET`)* | Secreto Bearer para `/api/cron/maintenance`. |
| `apiKey` | *(Se autoguarda en Paso 0.1A)* | API Key Maestra (`sk_live_...`) con `can_manage_keys=true`. |
| `keyId` | *(Se autoguarda en Paso 0.1A)* | UUID de la API Key Maestra. |
| `secondaryApiKey` | *(Se autoguarda en Paso 0.1B)* | API Key Secundaria delegada (`can_manage_keys=false`). |
| `secondaryKeyId` | *(Se autoguarda en Paso 0.1B)* | UUID de la API Key Secundaria. |
| `orgId` | `11111111-1111-1111-1111-111111111111` | UUID de la Organización 1 de prueba. |
| `userId` | `a1111111-0000-0000-0000-000000000001` | Usuario propietario en Org 1 (Carlos Mendoza). |
| `otherSameOrgUserId` | `a1111111-0000-0000-0000-000000000002` | Segundo usuario en Org 1 (Ana Beltrán, para probar `403` en privados). |
| `otherOrgUserId` | `b2222222-0000-0000-0000-000000000001` | Usuario de Org 2 (Mateo Delgado, para probar `403` cross-org). |
| `webhookSecret` | `whsec_test_secret_123456` | Secreto para firmar webhooks con HMAC-SHA256. |

---

## 🚀 3. DETALLE PASO A PASO DE CADA PETICIÓN (CON CABECERAS EXACTAS)

---

### SECCIÓN 0: Salud, Organizaciones, Webhooks y Protección Anti-SSRF

#### 0.0 Healthcheck Público (`GET /api/health`)
* **Método:** `GET`
* **URL:** `https://cloudinary-aws-backend.vercel.app/api/health`
* **Cabeceras (Headers en Postman):**
  *(Ninguna cabecera requerida)*
* **Respuesta Esperada (`200 OK`):**
  ```json
  {
    "status": "ok",
    "service": "cloudinary-aws-backend",
    "timestamp": "2026-10-27T15:30:00.000Z"
  }
  ```

---

#### 0.0A Consultar Mi Organización (`GET /api/organizations`)
* **Método:** `GET`
* **URL:** `https://cloudinary-aws-backend.vercel.app/api/organizations`
* **Cabeceras (Headers en Postman):**
  | Key | Value | Descripción |
  | :--- | :--- | :--- |
  | `x-api-key` | `{{apiKey}}` *(ej. `sk_live_...`)* | Llave maestra con `can_manage_keys=true` (o usa `x-admin-secret: {{adminSecret}}`) |
* **Respuesta Esperada (`200 OK`):** Devuelve cuotas (`max_storage_bytes`, `max_pending_tickets`, `max_api_keys`) y `webhook_url` de la organización.

---

#### 0.0B Configurar Webhook de Organización (`PATCH /api/organizations` con `x-api-key`)
* **Método:** `PATCH`
* **URL:** `https://cloudinary-aws-backend.vercel.app/api/organizations`
* **Cabeceras (Headers en Postman):**
  | Key | Value |
  | :--- | :--- |
  | `Content-Type` | `application/json` |
  | `x-api-key` | `{{apiKey}}` *(Llave maestra con `can_manage_keys=true`)* |
* **Body (`raw` -> `JSON`):**
  ```json
  {
    "webhookUrl": "https://cloudinary-aws-backend.vercel.app/api/webhooks/test-receiver",
    "webhookSecret": "whsec_test_secret_123456"
  }
  ```
* **Respuesta Esperada (`200 OK`):**
  ```json
  {
    "status": "updated",
    "message": "Configuración de webhook actualizada exitosamente."
  }
  ```

---

#### 0.0C [Seguridad] Intento de Modificar Cuotas con Llave Maestra (`PATCH /api/organizations`)
* **Método:** `PATCH`
* **URL:** `https://cloudinary-aws-backend.vercel.app/api/organizations`
* **Cabeceras (Headers en Postman):**
  | Key | Value |
  | :--- | :--- |
  | `Content-Type` | `application/json` |
  | `x-api-key` | `{{apiKey}}` |
* **Body (`raw` -> `JSON`):**
  ```json
  {
    "maxStorageBytes": 999999999999,
    "maxApiKeys": 50
  }
  ```
* **Respuesta Esperada (`403 Forbidden`):** `"code": "FORBIDDEN_QUOTA_MODIFICATION"`.

---

#### 0.0D [Seguridad SSRF] Bloqueo de Webhook hacia IP Interna/Loopback (`PATCH /api/organizations`)
* **Método:** `PATCH`
* **URL:** `https://cloudinary-aws-backend.vercel.app/api/organizations`
* **Cabeceras (Headers en Postman):**
  | Key | Value |
  | :--- | :--- |
  | `Content-Type` | `application/json` |
  | `x-api-key` | `{{apiKey}}` |
* **Body (`raw` -> `JSON`):**
  ```json
  {
    "webhookUrl": "https://[::ffff:127.0.0.1]/internal"
  }
  ```
* **Respuesta Esperada (`400 Bad Request`):** `"code": "INVALID_WEBHOOK_URL"`.

---

#### 0.0E Modificar Cuotas o Restaurar Webhook como Admin (`PATCH /api/organizations` con `x-admin-secret`)
* **Método:** `PATCH`
* **URL:** `https://cloudinary-aws-backend.vercel.app/api/organizations`
* **Cabeceras (Headers en Postman):**
  | Key | Value |
  | :--- | :--- |
  | `Content-Type` | `application/json` |
  | `x-admin-secret` | `{{adminSecret}}` *(Tu `ADMIN_API_SECRET`)* |
* **Body (`raw` -> `JSON`):**
  ```json
  {
    "id": "11111111-1111-1111-1111-111111111111",
    "maxApiKeys": 3,
    "maxPendingTickets": 20,
    "maxStorageBytes": 5368709120,
    "webhookUrl": null
  }
  ```
* **Respuesta Esperada (`200 OK`):** Actualiza cuotas y restaura `webhook_url` a `null`.

---

### SECCIÓN 0.1 - 0.3: Gestión de API Keys con Doble Autenticación (`/api/keys`)

#### 0.1A Crear API Key Maestra de Organización (`POST /api/keys` con `x-admin-secret`)
* **Método:** `POST`
* **URL:** `https://cloudinary-aws-backend.vercel.app/api/keys`
* **Cabeceras (Headers en Postman):**
  | Key | Value |
  | :--- | :--- |
  | `Content-Type` | `application/json` |
  | `x-admin-secret` | `{{adminSecret}}` |
* **Body (`raw` -> `JSON`):**
  ```json
  {
    "orgId": "11111111-1111-1111-1111-111111111111",
    "userId": null,
    "name": "Llave Maestra Organización 1",
    "canRead": true,
    "canUpload": true,
    "canDelete": true,
    "canManageKeys": true
  }
  ```
* **Respuesta Esperada (`201 Created`):** Devuelve `apiKey` (`sk_live_...`) y `keyMetadata.id`.

---

#### 0.1B Delegación: Crear API Key Secundaria (`POST /api/keys` con `x-api-key`)
* **Método:** `POST`
* **URL:** `https://cloudinary-aws-backend.vercel.app/api/keys`
* **Cabeceras (Headers en Postman):**
  | Key | Value |
  | :--- | :--- |
  | `Content-Type` | `application/json` |
  | `x-api-key` | `{{apiKey}}` *(Llave maestra con `can_manage_keys=true`)* |
* **Body (`raw` -> `JSON`):**
  ```json
  {
    "name": "Llave Secundaria de Subida",
    "canRead": true,
    "canUpload": true,
    "canDelete": false
  }
  ```
* **Respuesta Esperada (`201 Created` o `409 Conflict` si ya hay 3 llaves activas):** Crea la llave subordinada con `can_manage_keys: false`.

---

#### 0.1C [Seguridad] Intento de Escalada de Privilegios (`POST /api/keys`)
* **Método:** `POST`
* **URL:** `https://cloudinary-aws-backend.vercel.app/api/keys`
* **Cabeceras (Headers en Postman):**
  | Key | Value |
  | :--- | :--- |
  | `Content-Type` | `application/json` |
  | `x-api-key` | `{{secondaryApiKey}}` *(Llave secundaria sin permiso `can_delete` ni `can_manage_keys`)* |
* **Body (`raw` -> `JSON`):**
  ```json
  {
    "name": "Intento Escalada",
    "canRead": true,
    "canUpload": true,
    "canDelete": true
  }
  ```
* **Respuesta Esperada (`403 Forbidden`):** `"code": "CANNOT_MANAGE_KEYS"` o `"PRIVILEGE_ESCALATION_BLOCKED"`.

---

#### 0.1D Promover Llave Existente a Maestra (`PATCH /api/keys`)
* **Método:** `PATCH`
* **URL:** `https://cloudinary-aws-backend.vercel.app/api/keys`
* **Cabeceras (Headers en Postman):**
  | Key | Value |
  | :--- | :--- |
  | `Content-Type` | `application/json` |
  | `x-admin-secret` | `{{adminSecret}}` |
* **Body (`raw` -> `JSON`):**
  ```json
  {
    "id": "{{keyId}}",
    "canManageKeys": true
  }
  ```
* **Respuesta Esperada (`200 OK`):** Actualiza `can_manage_keys: true`.

---

#### 0.2A Listar API Keys como Administrador (`GET /api/keys`)
* **Método:** `GET`
* **URL:** `https://cloudinary-aws-backend.vercel.app/api/keys?org_id=11111111-1111-1111-1111-111111111111`
* **Cabeceras (Headers en Postman):**
  | Key | Value |
  | :--- | :--- |
  | `x-admin-secret` | `{{adminSecret}}` |

---

#### 0.2B Listar API Keys como Organización (`GET /api/keys`)
* **Método:** `GET`
* **URL:** `https://cloudinary-aws-backend.vercel.app/api/keys`
* **Cabeceras (Headers en Postman):**
  | Key | Value |
  | :--- | :--- |
  | `x-api-key` | `{{apiKey}}` *(Llave maestra con `can_manage_keys=true`)* |

---

#### 0.3A [Seguridad] Auto-eliminación Bloqueada (`DELETE /api/keys`)
* **Método:** `DELETE`
* **URL:** `https://cloudinary-aws-backend.vercel.app/api/keys?id={{keyId}}&mode=revoke`
* **Cabeceras (Headers en Postman):**
  | Key | Value |
  | :--- | :--- |
  | `x-api-key` | `{{apiKey}}` |
* **Respuesta Esperada (`403 Forbidden`):** `"code": "CANNOT_DELETE_SELF"`.

---

#### 0.3B [Seguridad] Revocar Llave de Otra Organización Bloqueado (`DELETE /api/keys`)
* **Método:** `DELETE`
* **URL:** `https://cloudinary-aws-backend.vercel.app/api/keys?id=00000000-0000-4000-8000-000000000099&mode=revoke`
* **Cabeceras (Headers en Postman):**
  | Key | Value |
  | :--- | :--- |
  | `x-api-key` | `{{apiKey}}` |
* **Respuesta Esperada (`404 Not Found`):** `"code": "API_KEY_NOT_FOUND"`.

---

#### 0.3C Revocar o Eliminar Llave Secundaria (`DELETE /api/keys`)
* **Método:** `DELETE`
* **URL:** `https://cloudinary-aws-backend.vercel.app/api/keys?id={{secondaryKeyId}}&mode=revoke`
* **Cabeceras (Headers en Postman):**
  | Key | Value |
  | :--- | :--- |
  | `x-api-key` | `{{apiKey}}` |
* **Respuesta Esperada (`200 OK`):** Llave secundaria revocada.

---

### SECCIÓN 1 - 3: Subida Simple Directa a S3, Checksum SHA-256, Magic Bytes y Entrega

#### 1 (y 1.0B) Solicitar Ticket de Subida (`POST /api/upload`)
* **Método:** `POST`
* **URL:** `https://cloudinary-aws-backend.vercel.app/api/upload`
* **Cabeceras (Headers en Postman):**
  | Key | Value | Descripción |
  | :--- | :--- | :--- |
  | `Content-Type` | `application/json` | Formato JSON del body |
  | `x-api-key` | `{{apiKey}}` | API Key activa de la organización con `can_upload=true` |
  | `x-user-id` | `a1111111-0000-0000-0000-000000000001` | UUID del usuario dueño del archivo (obligatorio en llaves de organización) |
* **Body (`raw` -> `JSON`):**
  ```json
  {
    "fileName": "prueba.png",
    "extension": ".png",
    "fileType": "image/png",
    "fileSize": 68,
    "visibility": "private",
    "sha256Hash": "r8b2eb9f79a5cf26d2a4943e8a0cd6ed4c65fb949956c3b6f6a5646f0e49e13d"
  }
  ```
  *(Nota: `sha256Hash` es opcional. Si lo envías, la respuesta incluirá `x-amz-checksum-sha256` dentro de `requiredHeaders`).*
* **Respuesta Esperada (`200 OK`):** Devuelve `ticketId`, `fileId`, `uploadUrl`, `requiredHeaders` y `confirmToken`.

---

#### 1.1 [Seguridad] Rechazo por Usuario de Otra Organización (`POST /api/upload`)
* **Método:** `POST`
* **URL:** `https://cloudinary-aws-backend.vercel.app/api/upload`
* **Cabeceras (Headers en Postman):**
  | Key | Value |
  | :--- | :--- |
  | `Content-Type` | `application/json` |
  | `x-api-key` | `{{apiKey}}` *(Org 1)* |
  | `x-user-id` | `b2222222-0000-0000-0000-000000000001` *(Usuario de Org 2)* |
* **Respuesta Esperada (`403 Forbidden`):** `"code": "FORBIDDEN_USER_ORG_MISMATCH"`.

---

#### 1.2 [Seguridad] Rechazo por Omitir `x-user-id` (`POST /api/upload`)
* **Método:** `POST`
* **URL:** `https://cloudinary-aws-backend.vercel.app/api/upload`
* **Cabeceras (Headers en Postman):**
  | Key | Value |
  | :--- | :--- |
  | `Content-Type` | `application/json` |
  | `x-api-key` | `{{apiKey}}` *(Sin cabecera `x-user-id`)* |
* **Respuesta Esperada (`400 Bad Request`):** `"code": "MISSING_END_USER_ID"`.

---

#### 2 Subida Directa Binaria a AWS S3 (`PUT {{uploadUrl}}`)
* **Método:** `PUT`
* **URL:** `{{uploadUrl}}` *(La URL larga de S3 devuelta en el Paso 1)*
* **Cabeceras (Headers en Postman) — Deben coincidir EXACTAMENTE con `requiredHeaders` del Paso 1:**
  * **Si el archivo es `private`:**
    | Key | Value |
    | :--- | :--- |
    | `Content-Type` | `image/png` *(o el `fileType` solicitado)* |
    | `Cache-Control` | `private, no-store, no-cache, max-age=0, must-revalidate` |
    | `x-amz-checksum-sha256` | *(Solo si enviaste `sha256Hash` en el Paso 1.0B: poner el valor Base64 devuelto en `requiredHeaders["x-amz-checksum-sha256"]`)* |
  * **Si el archivo es `public`:**
    | Key | Value |
    | :--- | :--- |
    | `Content-Type` | `image/png` |
    | `Cache-Control` | `public, max-age=31536000, immutable` |
  > ⚠️ **IMPORTANTE EN S3:** No envíes `x-api-key` ni `x-user-id` en esta petición porque va directo a Amazon S3.
* **Body en Postman:** Selecciona `binary` y elige tu archivo `.png` o `.jpg`.
* **Respuesta Esperada (`200 OK`):** Cuerpo vacío devuelto por S3 (o `403 SignatureDoesNotMatch` si enviaste un checksum incorrecto).

---

#### 3 Confirmar Subida y Verificar Magic Bytes + Webhook (`PUT /api/upload`)
* **Método:** `PUT`
* **URL:** `https://cloudinary-aws-backend.vercel.app/api/upload`
* **Cabeceras (Headers en Postman):**
  | Key | Value |
  | :--- | :--- |
  | `Content-Type` | `application/json` |
  | `x-api-key` | `{{apiKey}}` |
  | `x-user-id` | `a1111111-0000-0000-0000-000000000001` |
* **Body (`raw` -> `JSON`):**
  ```json
  {
    "ticketId": "{{ticketId}}",
    "confirmToken": "{{confirmToken}}"
  }
  ```
* **Respuesta Esperada (`200 OK`):** Devuelve `fileStatus: "uploaded"`, `sha256Verified: true` y el resultado de `webhook`. Si el archivo subido en el Paso 2 tenía bytes falsos (ej. texto plano en vez de PNG), devuelve **`422 Unprocessable Entity` (`MAGIC_BYTES_MISMATCH`)**.

---

#### 3.1 Listar Archivos de la Organización (`GET /api/files`)
* **Método:** `GET`
* **URL:** `https://cloudinary-aws-backend.vercel.app/api/files?limit=20&offset=0`
* **Cabeceras (Headers en Postman):**
  | Key | Value |
  | :--- | :--- |
  | `x-api-key` | `{{apiKey}}` |
  | `x-user-id` | `a1111111-0000-0000-0000-000000000001` |

---

#### 3.2 Obtener URL de Entrega como Propietario (`GET /api/files/:id`)
* **Método:** `GET`
* **URL:** `https://cloudinary-aws-backend.vercel.app/api/files/{{fileId}}`
* **Cabeceras (Headers en Postman):**
  | Key | Value |
  | :--- | :--- |
  | `x-api-key` | `{{apiKey}}` |
  | `x-user-id` | `a1111111-0000-0000-0000-000000000001` *(Propietario del archivo)* |
* **Respuesta Esperada (`200 OK`):**
  * Si es `private`: `delivery: "s3_presigned"`, `cloudfrontUrl: null`, `expiresInSeconds: 300`.
  * Si es `public`: `delivery: "cloudfront"`, `cloudfrontUrl: "https://d1nuawu3owad6c.cloudfront.net/static/files/..."`.

---

#### 3.2B [Seguridad] Acceso Denegado a Archivo Privado por Otro Usuario (`GET /api/files/:id`)
* **Método:** `GET`
* **URL:** `https://cloudinary-aws-backend.vercel.app/api/files/{{fileId}}`
* **Cabeceras (Headers en Postman):**
  | Key | Value |
  | :--- | :--- |
  | `x-api-key` | `{{apiKey}}` |
  | `x-user-id` | `a1111111-0000-0000-0000-000000000002` *(Otro usuario que NO es el dueño)* |
* **Respuesta Esperada (`403 Forbidden`):** `"code": "FORBIDDEN_PRIVATE_NOT_OWNER"`.

---

#### 3.3 Descargar Archivo Directo de S3 / CloudFront (`GET {{downloadUrl}}`)
* **Método:** `GET`
* **URL:** `{{downloadUrl}}`
* **Cabeceras (Headers en Postman):**
  *(Ninguna cabecera requerida — descarga directa de S3 o CloudFront).*

---

#### 3.4 Consultar Estado Transaccional del Archivo (`GET /api/files/:id/status`)
* **Método:** `GET`
* **URL:** `https://cloudinary-aws-backend.vercel.app/api/files/{{fileId}}/status`
* **Cabeceras (Headers en Postman):**
  | Key | Value |
  | :--- | :--- |
  | `x-api-key` | `{{apiKey}}` |
  | `x-user-id` | `a1111111-0000-0000-0000-000000000001` |

---

#### 3.5 Re-despachar Webhook Manualmente (`POST /api/files/:id/status`)
* **Método:** `POST`
* **URL:** `https://cloudinary-aws-backend.vercel.app/api/files/{{fileId}}/status`
* **Cabeceras (Headers en Postman):**
  | Key | Value |
  | :--- | :--- |
  | `Content-Type` | `application/json` |
  | `x-api-key` | `{{apiKey}}` |
  | `x-user-id` | `a1111111-0000-0000-0000-000000000001` |
* **Body (`raw` -> `JSON`):** `{}`

---

#### 3.6 Eliminar Archivo de S3 y Base de Datos (`DELETE /api/files/:id`)
* **Método:** `DELETE`
* **URL:** `https://cloudinary-aws-backend.vercel.app/api/files/{{fileId}}`
* **Cabeceras (Headers en Postman):**
  | Key | Value |
  | :--- | :--- |
  | `x-api-key` | `{{apiKey}}` |
  | `x-user-id` | `a1111111-0000-0000-0000-000000000001` |

---

### SECCIÓN 4: Subida Multipart Completa (`/api/upload/multipart`)

#### 4.1 Iniciar Subida Multipart (`POST /api/upload/multipart`)
* **Método:** `POST`
* **URL:** `https://cloudinary-aws-backend.vercel.app/api/upload/multipart`
* **Cabeceras (Headers en Postman):**
  | Key | Value |
  | :--- | :--- |
  | `Content-Type` | `application/json` |
  | `x-api-key` | `{{apiKey}}` |
  | `x-user-id` | `a1111111-0000-0000-0000-000000000001` |
* **Body (`raw` -> `JSON`):**
  ```json
  {
    "action": "create",
    "fileName": "archivo-grande.png",
    "fileType": "image/png",
    "fileSize": 10485760,
    "visibility": "private"
  }
  ```

---

#### 4.2 y 4.3 Firmar URL para Parte 1 y Parte 2 (`POST /api/upload/multipart`)
* **Método:** `POST`
* **URL:** `https://cloudinary-aws-backend.vercel.app/api/upload/multipart`
* **Cabeceras (Headers en Postman):**
  | Key | Value |
  | :--- | :--- |
  | `Content-Type` | `application/json` |
  | `x-api-key` | `{{apiKey}}` |
  | `x-user-id` | `a1111111-0000-0000-0000-000000000001` |
* **Body (`raw` -> `JSON`):**
  ```json
  {
    "action": "presign_part",
    "ticketId": "{{multipartTicketId}}",
    "partNumber": 1
  }
  ```
  *(En el paso 4.3 cambia `"partNumber": 2`).*

---

#### 4.4 y 4.5 Subir Binario de Parte 1 y Parte 2 a S3 (`PUT {{part1UploadUrl}}` y `PUT {{part2UploadUrl}}`)
* **Método:** `PUT`
* **URL:** `{{part1UploadUrl}}` (y luego `{{part2UploadUrl}}`)
* **Cabeceras (Headers en Postman):**
  *(Ninguna cabecera manual — No envíes `x-api-key` ni `x-user-id` a S3).*
* **Body en Postman:** Selecciona `binary` y adjunta el archivo de cada parte (mín. 5 MB en la Parte 1). El script de Postman guarda automáticamente la cabecera `ETag` de respuesta de S3 en `{{part1ETag}}` y `{{part2ETag}}`.

---

#### 4.6 Consultar Partes Subidas en S3 (`GET /api/upload/multipart`)
* **Método:** `GET`
* **URL:** `https://cloudinary-aws-backend.vercel.app/api/upload/multipart?ticketId={{multipartTicketId}}`
* **Cabeceras (Headers en Postman):**
  | Key | Value |
  | :--- | :--- |
  | `x-api-key` | `{{apiKey}}` |
  | `x-user-id` | `a1111111-0000-0000-0000-000000000001` |

---

#### 4.7 Completar Subida Multipart (`PUT /api/upload/multipart`)
* **Método:** `PUT`
* **URL:** `https://cloudinary-aws-backend.vercel.app/api/upload/multipart`
* **Cabeceras (Headers en Postman):**
  | Key | Value |
  | :--- | :--- |
  | `Content-Type` | `application/json` |
  | `x-api-key` | `{{apiKey}}` |
  | `x-user-id` | `a1111111-0000-0000-0000-000000000001` |
* **Body (`raw` -> `JSON`):**
  ```json
  {
    "ticketId": "{{multipartTicketId}}",
    "confirmToken": "{{multipartConfirmToken}}",
    "parts": [
      { "PartNumber": 1, "ETag": "{{part1ETag}}" },
      { "PartNumber": 2, "ETag": "{{part2ETag}}" }
    ]
  }
  ```

---

#### 4.8 Abortar Subida Multipart en Curso (`DELETE /api/upload/multipart`)
* **Método:** `DELETE`
* **URL:** `https://cloudinary-aws-backend.vercel.app/api/upload/multipart?ticketId={{multipartTicketId}}`
* **Cabeceras (Headers en Postman):**
  | Key | Value |
  | :--- | :--- |
  | `x-api-key` | `{{apiKey}}` |
  | `x-user-id` | `a1111111-0000-0000-0000-000000000001` |

---

### SECCIÓN 5 - 9: Receptor de Webhooks, Auditoría y Cron de Mantenimiento

#### 5 Inspeccionar Webhooks Recibidos (`GET /api/webhooks/test-receiver`)
* **Método:** `GET`
* **URL:** `https://cloudinary-aws-backend.vercel.app/api/webhooks/test-receiver`
* **Cabeceras (Headers en Postman):**
  | Key | Value |
  | :--- | :--- |
  | `x-admin-secret` | `{{adminSecret}}` |

---

#### 6, 7 y 8 Consultas Administrativas (`GET /api/logs`, `GET /api/records`, `GET /api/users`)
* **Método:** `GET`
* **URL:** `https://cloudinary-aws-backend.vercel.app/api/logs` *(o `/api/records`, `/api/users`)*
* **Cabeceras (Headers en Postman):**
  | Key | Value |
  | :--- | :--- |
  | `x-admin-secret` | `{{adminSecret}}` |

---

#### 9 Ejecutar Cron de Mantenimiento (`GET /api/cron/maintenance`)
* **Método:** `GET`
* **URL:** `https://cloudinary-aws-backend.vercel.app/api/cron/maintenance`
* **Cabeceras (Headers en Postman):**
  | Key | Value |
  | :--- | :--- |
  | `Authorization` | `Bearer {{cronSecret}}` |

---

## ✅ 4. RESUMEN DE VERIFICACIÓN EN PRODUCCIÓN (FASE 2 COMPLETADA)

| # | Prueba Verificada en Producción | Endpoint / Acción | Código HTTP Obtenido | Resultado y Evidencia |
| :-: | :--- | :--- | :-: | :--- |
| **1A** | **Webhook Real con Firma HMAC e IP Fijada** | `PATCH /api/organizations` + `POST/PUT /api/upload` -> `/api/webhooks/test-receiver` | **`200 OK`** | `webhook: { delivered: true, lastStatusCode: 200, deliveryId: "32d6a22d-041e-464f-9cf9-237be4d64984" }`, firma HMAC-SHA256 válida y `lookup` devolviendo `[{ address, family }]` cuando `all: true`. |
| **1B** | **Circuit Breaker de Webhooks** | 3 entregas fallidas (`500`) + 4ta subida | **`200 OK`** | La 4ta subida no esperó en línea: `webhook: { delivered: false, attempts: 0, error: "CIRCUIT_BREAKER_QUEUED", deliveryId: "916bf3f9-12cf-4e30-8e75-6b12245bcfcd" }`. `webhook_url` restaurado a `null`. |
| **1C** | **Bloqueo SSRF Completo (9 Vectores)** | `PATCH /api/organizations` con IPs internas/octales/hex/DNS | **`400 Bad Request`** | Bloqueados los 9 vectores (`[::1]`, `[::ffff:127.0.0.1]`, `[::ffff:7f00:1]`, `[fd00::1]`, `127.1`, `0x7f.1`, `2130706433`, `0177.0.0.1` y `localtest.me`) con `INVALID_WEBHOOK_URL`. |
| **2** | **Checksum SHA-256 en S3 (Incorrecto vs Correcto)** | `PUT uploadUrl` con `x-amz-checksum-sha256` | **`403`** / **`200 OK`** | Checksum alterado rechazado por S3 con `403 SignatureDoesNotMatch`. Checksum real aceptado por S3 (`200 OK`) y confirmado en backend con `sha256Verified: true`. |
| **3** | **Visibilidad Privada vs Pública** | `GET /api/files/:id` (Dueño, Otro Usuario y Público) | **`200`** / **`403`** / **`200`** | Privado al dueño: `200 OK` (`delivery: "s3_presigned"`, `cloudfrontUrl: null`). Privado a otro usuario: `403 FORBIDDEN_PRIVATE_NOT_OWNER`. Público: `200 OK` (`delivery: "cloudfront"`, URL en `d1nuawu3owad6c.cloudfront.net/static/files/...`). |
| **4** | **Multipart Completo (2 partes x 5 MB = 10 MB) y Limpieza Oportunista** | `POST/PUT /api/upload/multipart` + S3 `PUT` | **`200 OK`** | 2 partes de `5,242,880` bytes ensambladas en S3 (`10,485,760` bytes), `fileStatus: "uploaded"`, `magicBytesVerified: true`. Tickets vencidos limpiados oportunamente. |
| **5** | **Rate Limit Compartido en PostgreSQL** | 21 peticiones a `GET /api/keys` | **`429 Too Many Requests`** | Peticiones 1–20: `200 OK`. Petición 21: `429 KEYS_RATE_LIMIT_EXCEEDED` (`Retry-After: 43`). |
| **6** | **Cuotas de Tickets Pendientes y Almacenamiento** | `POST /api/upload` con límites bajos temporales | **`429`** y **`413`** | Límite `maxPendingTickets=1`: 2da solicitud rechazada con `429 PENDING_TICKETS_QUOTA_EXCEEDED`. Límite `maxStorageBytes=100`: solicitud rechazada con `413 STORAGE_QUOTA_EXCEEDED`. Cuotas restauradas. |
| **7** | **Seguridad de Llaves y Concurrencia (`Promise.all`)** | `DELETE /api/keys` (otra org) y `POST /api/keys` concurrente | **`404`**, **`201`** y **`409`** | `DELETE` de llave ajena: `404 API_KEY_NOT_FOUND`. Dos `POST /api/keys` simultáneos con 2 llaves activas y cupo 3: una `201 Created` y una `409 MAX_API_KEYS_LIMIT_REACHED`. |
| **8** | **Rechazo de Magic Bytes Corruptos** | `PUT /api/upload` tras subir texto como `image/png` | **`422 Unprocessable Entity`** | Rechazado con `422 MAGIC_BYTES_MISMATCH`, objeto purgado de S3 y fila marcada como `failed`. |
