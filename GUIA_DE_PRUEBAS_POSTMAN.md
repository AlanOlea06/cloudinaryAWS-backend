# Guía Rápida y Completa de Pruebas (Postman y cURL)

> **Servicio:** Cloudinary Clone Backend (Vercel Serverless)  
> **URL Base:** `https://cloudinary-aws-backend.vercel.app`  
> **Versión Actual:** Sección 5 (Subida Directa a S3, Range GET 32b, S3 Checksum SHA-256, Estados `uploaded`/`not_scanned`, y **Cero Archivos por Vercel**)  
> **Fecha:** 26 de Octubre de 2026

---

## 🔑 1. MAPA DE AUTENTICACIÓN (¿Qué credencial va en qué ruta?)

| Ruta | Método | Cabecera Requerida | Propósito / Quién la usa |
|---|---|---|---|
| `/api/keys` | POST, GET, DELETE | `x-admin-secret: <ADMIN_API_SECRET>` | Creación, listado y revocación de API Keys de organización |
| `/api/logs` | GET, PATCH, DELETE | `x-admin-secret: <ADMIN_API_SECRET>` | Consulta y limpieza de auditoría |
| `/api/records` | GET, DELETE | `x-admin-secret: <ADMIN_API_SECRET>` | Consulta y limpieza de base de datos (`files`) |
| `/api/test/cleanup`| POST, DELETE | `x-admin-secret: <ADMIN_API_SECRET>` | Limpieza de pruebas en S3 y base de datos |
| `/api/users` | GET | `x-admin-secret: <ADMIN_API_SECRET>` | Catálogo de usuarios y organizaciones |
| `/api/cron/maintenance` | GET, POST | `Authorization: Bearer <CRON_SECRET>` | Tareas periódicas automatizadas de mantenimiento |
| `/api/upload` | POST, PUT | `x-api-key: sk_live_...`<br>`x-user-id: <UUID_usuario>` | Solicitud y confirmación de subida directa |
| `/api/upload/multipart` | POST, GET, DELETE | `x-api-key: sk_live_...`<br>`x-user-id: <UUID_usuario>` | Subida multipart para archivos grandes (>25 MB) |
| `/api/files` | GET, DELETE | `x-api-key: sk_live_...` | Listar archivos de la organización o borrado |
| `/api/files/:id` | GET, DELETE | `x-api-key: sk_live_...`<br>*(+ `x-user-id` si es privado)* | Descargar URL de archivo o eliminarlo |
| `/api/files/:id/status`| GET | `x-api-key: sk_live_...` | Consultar estado del archivo |

---

## 📋 2. DATOS DE PRUEBA LISTOS PARA USAR

* **Organización 1 (ID):** `11111111-1111-1111-1111-111111111111`
  * **Usuario 1 (Admin con permiso):** `a1111111-0000-0000-0000-000000000001` (Carlos Mendoza)
  * **Usuario 2 (Editor con permiso):** `a1111111-0000-0000-0000-000000000002` (Ana Beltrán)
  * **Usuario 3 (Sin permiso de subida):** `a1111111-0000-0000-0000-000000000010` (Valeria Ruiz, `can_upload = false` -> para probar rechazo 403)
* **Organización 2 (ID):** `22222222-2222-2222-2222-222222222222`
  * **Usuario Org 2:** `b2222222-0000-0000-0000-000000000001` (Mateo Delgado -> para probar rechazo 403 por cruce de organización)

---

## 🚀 3. FLUJO COMPLETO PASO A PASO (De 0 a 100)

```
[0. Crear API Key] ──> [1. Solicitar Ticket] ──> [2. PUT Binario a S3] ──> [3. Confirmar Subida] ──> [4. Consumir / Descargar]
 (x-admin-secret)       (x-api-key + x-user-id)      (Directo a AWS S3)      (Range GET 32b + SHA-256)   (S3 Presigned vs CloudFront)
```

---

### PASO 0: Crear una API Key de Organización (POST /api/keys)
> **Objetivo:** Obtener la llave `sk_live_...` que usarás en todas tus peticiones siguientes.

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
    "name": "Llave de Pruebas Postman",
    "canRead": true,
    "canUpload": true,
    "canDelete": true
  }
  ```
* **cURL:**
  ```bash
  curl -X POST https://cloudinary-aws-backend.vercel.app/api/keys \
    -H "Content-Type: application/json" \
    -H "x-admin-secret: <TU_ADMIN_API_SECRET>" \
    -d "{\"orgId\":\"11111111-1111-1111-1111-111111111111\",\"name\":\"Llave de Pruebas\",\"canRead\":true,\"canUpload\":true,\"canDelete\":true}"
  ```
* **Respuesta Esperada (HTTP 201 Created):**
  ```json
  {
    "status": "success",
    "apiKey": "sk_live_...",
    "keyId": "uuid-de-la-llave",
    "orgId": "11111111-1111-1111-1111-111111111111",
    "name": "Llave de Pruebas",
    "permissions": {
      "canRead": true,
      "canUpload": true,
      "canDelete": true
    }
  }
  ```
  *(💡 **Copia la `apiKey` generada (`sk_live_...`)** para los pasos siguientes).*

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
  *(Asegúrate de colocar el tamaño EXACTO en bytes del archivo que vas a subir en `fileSize`)*:
  ```json
  {
    "fileName": "prueba.png",
    "fileType": "image/png",
    "fileSize": 289159,
    "visibility": "private"
  }
  ```
  *(Opcional: Si quieres probar la integridad criptográfica de S3, agrega el campo `"sha256Hash": "<hash_hex_64_chars>"`)*.
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
  *(💡 **Copia `uploadUrl`, `ticketId`, `fileId` y `confirmToken`**).*

---

### PASO 2: Subir el Binario Directamente a AWS S3 (PUT a la uploadUrl)
> **Objetivo:** Enviar los bytes directamente desde tu máquina a Amazon S3. **Ningún archivo pasa por Vercel.**

* **Método:** `PUT`
* **URL:** *(Pega la `uploadUrl` completa devuelta en el Paso 1)*
* **Headers:** *(Deben coincidir EXACTAMENTE con las devueltas en `requiredHeaders`)*:
  ```http
  Content-Type: image/png
  Cache-Control: private, no-store, no-cache, max-age=0, must-revalidate
  ```
  *(Si subes un PDF, agrega también: `Content-Disposition: attachment`).*  
  *(Si enviaste `sha256Hash`, agrega la cabecera indicada en requiredHeaders: `x-amz-checksum-sha256: <base64>`).*
* **Body en Postman:** Selecciona `binary` y adjunta tu archivo local (el tamaño en disco debe ser idéntico al `fileSize` declarado).
* **cURL:**
  ```bash
  curl -X PUT "<uploadUrl>" \
    -H "Content-Type: image/png" \
    -H "Cache-Control: private, no-store, no-cache, max-age=0, must-revalidate" \
    --data-binary @"./prueba.png"
  ```
* **Respuesta Esperada:**
  * **HTTP 200 OK** (Cuerpo vacío, devuelto directamente por los servidores de Amazon S3).

---

### PASO 3: Confirmar la Subida en el Backend (PUT /api/upload)
> **Objetivo:** El servidor valida en S3: (1) HeadObject, (2) Range GET de los primeros 32 bytes para certificar los `magic bytes` reales de la imagen sin descargarla a Vercel, y (3) Checksum SHA-256. Actualiza el estado a `uploaded` y `scan_status: not_scanned`.

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
    "method": "PUT",
    "message": "File upload confirmed for ticket ab9ceee4-1bfe-4ed3-a3c0-c026f9aa1e37",
    "ticketId": "ab9ceee4-1bfe-4ed3-a3c0-c026f9aa1e37",
    "fileId": "e435ab1d-2c81-4c89-b956-12618e8c7c01",
    "fileStatus": "uploaded",
    "scanStatus": "not_scanned",
    "visibility": "private",
    "ownerUserId": "a1111111-0000-0000-0000-000000000001",
    "cacheControl": "private, no-store, no-cache, max-age=0, must-revalidate",
    "cloudfrontUrl": null,
    "tokenVerified": true,
    "headVerification": {
      "verified": true,
      "actualSizeBytes": 289159,
      "actualContentType": "image/png",
      "actualCacheControl": "private, no-store, no-cache, max-age=0, must-revalidate",
      "actualContentDisposition": "inline",
      "eTag": "\"567c52f9e9f0b3317eb83b27900af74e\""
    },
    "verification": {
      "magicBytesVerified": true,
      "detectedMimeType": "image/png",
      "checksumVerified": false
    }
  }
  ```
  *(💡 Observa que `fileStatus` es `uploaded`, `scanStatus` es `not_scanned` y no se filtra ninguna clave interna de S3).*

---

### PASO 4: Consumir / Descargar el Archivo (GET /api/files/:id)
> **Objetivo:** Obtener el enlace de descarga seguro. Para archivos privados, entrega una URL prefirmada de S3 válida por 5 minutos con `no-store`. Para archivos públicos, entrega el enlace CDN de CloudFront.

* **Método:** `GET`
* **URL:** `https://cloudinary-aws-backend.vercel.app/api/files/<fileId>`
* **Headers:**
  ```http
  x-api-key: sk_live_...
  x-user-id: a1111111-0000-0000-0000-000000000001
  ```
* **cURL:**
  ```bash
  curl -X GET https://cloudinary-aws-backend.vercel.app/api/files/<fileId> \
    -H "x-api-key: sk_live_..." \
    -H "x-user-id: a1111111-0000-0000-0000-000000000001"
  ```
* **Respuesta Esperada para Archivo Privado (HTTP 200 OK):**
  ```json
  {
    "url": "https://practicas-alan-418272802078.s3.us-east-1.amazonaws.com/static/files/567c52f9e9f0b3317eb83b27900af74e.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Expires=300&response-cache-control=private%2C%20no-store...",
    "delivery": "s3_presigned",
    "expiresInSeconds": 300,
    "cloudfrontUrl": null,
    "visibility": "private",
    "cacheControl": "private, no-store, no-cache, max-age=0, must-revalidate",
    "fileId": "e435ab1d-2c81-4c89-b956-12618e8c7c01",
    "ownerUserId": "a1111111-0000-0000-0000-000000000001",
    "status": "uploaded",
    "scanStatus": "not_scanned"
  }
  ```
  *(💡 Puedes abrir la propiedad `url` en tu navegador para ver o descargar el archivo directo de S3).*

---

## 🛠 4. PRUEBAS DE SEGURIDAD Y RECHAZO (Casos Negativos)

| Caso de Prueba | Qué enviar | Respuesta Esperada | Qué valida el sistema |
|---|---|---|---|
| **1. Sin API Key** | Cualquier petición a `/api/upload` sin `x-api-key` | **HTTP 401 Unauthorized**<br>`code: MISSING_API_KEY` | El middleware Edge protege todas las rutas |
| **2. Suplantación de Tenant** | Enviar `x-api-key` de Org 1 pero `x-user-id` de Mateo Delgado (`b222...` de Org 2) | **HTTP 403 Forbidden**<br>`code: FORBIDDEN_USER_NOT_IN_ORG` | Cierra la suplantación de usuarios entre organizaciones |
| **3. Usuario sin permiso de subida** | Enviar `x-user-id` de Valeria Ruiz (`a111...10`) que tiene `can_upload=false` | **HTTP 403 Forbidden**<br>`code: UPLOAD_PERMISSION_DENIED` | Valida permisos RBAC del usuario |
| **4. Tipo de archivo malicioso (XSS)** | Enviar `fileName: "script.html"` o `fileType: "image/svg+xml"` en el ticket | **HTTP 400 Bad Request**<br>`code: XSS_DANGEROUS_FILE_TYPE` | Lista blanca estricta anti-XSS |
| **5. Falsificación de Magic Bytes** | Declarar `image/png` en el ticket pero subir un archivo de texto o ejecutable en el PUT | **HTTP 400 Bad Request**<br>`code: INVALID_MAGIC_BYTES` | El Range GET de 32 bytes detecta la cabecera real y borra el objeto de S3 |
| **6. Confirmar dos veces el mismo ticket** | Ejecutar el Paso 3 dos veces con el mismo `ticketId` | **HTTP 409 Conflict**<br>`code: TICKET_ALREADY_COMPLETED` | Idempotencia y protección anti-repetición |
| **7. Descargar archivo privado de otro usuario** | Consultar `GET /api/files/:id` enviando el `x-user-id` de Ana Beltrán para un archivo de Carlos | **HTTP 403 Forbidden**<br>`code: FORBIDDEN_PRIVATE_NOT_OWNER` | Aislamiento estricto de privacidad |

---

## ⚙️ 5. ENDPOINTS ADMINISTRATIVOS Y DE MANTENIMIENTO

### Ejecutar Mantenimiento Manual (POST /api/cron/maintenance)
* **Método:** `POST`
* **URL:** `https://cloudinary-aws-backend.vercel.app/api/cron/maintenance`
* **Headers:**
  ```http
  Authorization: Bearer <TU_CRON_SECRET>
  ```
* **Respuesta Esperada (HTTP 200 OK):**
  Devuelve el resumen de tickets vencidos eliminados en S3 y BD, y multiparts abandonados abortados.

### Consultar Registros de Archivos (GET /api/records)
* **Método:** `GET`
* **URL:** `https://cloudinary-aws-backend.vercel.app/api/records`
* **Headers:**
  ```http
  x-admin-secret: <TU_ADMIN_API_SECRET>
  ```
* **Respuesta:** Lista de todos los registros en `files` con sus estados y tamaños.

### Consultar Bitácora de Auditoría (GET /api/logs)
* **Método:** `GET`
* **URL:** `https://cloudinary-aws-backend.vercel.app/api/logs?limit=50`
* **Headers:**
  ```http
  x-admin-secret: <TU_ADMIN_API_SECRET>
  ```
* **Respuesta:** Historial de eventos de seguridad (`UPLOAD_CONFIRMED`, `ACCESS_DENIED`, etc.) en Tercera Forma Normal.
