# Guía Completa de Pruebas en Postman: Doble Autenticación, Webhooks, Checksum SHA-256, Multipart y S3 Directo

> **Servicio:** Cloudinary Clone Backend (Vercel Serverless)  
> **URL Base:** `https://cloudinary-aws-backend.vercel.app`  
> **Versión Actual:** 2.0.0 (Hardening Batch — Verificado en Producción)  
> **Fecha:** 27 de Octubre de 2026  
> **Colección Postman Lista para Importar:** [`postman_collection.json`](file:///C:/Users/alano/Desktop/github/cloudinary-project/servicio/postman_collection.json)

---

## 🔑 1. MAPA DE AUTENTICACIÓN Y MÉTODOS DISPONIBLES

| Ruta | Método | Credencial / Cabecera Requerida | Propósito / Quién la usa |
| :--- | :--- | :--- | :--- |
| `/api/health` | `GET`, `HEAD` | **Pública** (sin credenciales) | Healthcheck público (`{ status: "ok", service: "cloudinary-aws-backend" }`). |
| `/api/organizations` | `GET`, `PATCH` | `x-admin-secret: <ADMIN_API_SECRET>`<br>-- **O** --<br>`x-api-key: sk_live_...` *(con `can_manage_keys=true`)* | **Doble Autenticación:**<br>1. **Administrador (`x-admin-secret`):** Modifica cuotas (`maxStorageBytes`, `maxPendingTickets`, `maxApiKeys`), nombres y webhooks de cualquier organización.<br>2. **Llave Maestra (`can_manage_keys=true`):** Autoservicio para consultar su organización y actualizar **únicamente** `webhookUrl` (con validación anti-SSRF) y `webhookSecret`. Si intenta tocar cuotas recibe `403 FORBIDDEN_QUOTA_MODIFICATION`. |
| `/api/keys` | `POST`, `GET`, `PATCH`, `DELETE` | `x-admin-secret: <ADMIN_API_SECRET>`<br>-- **O** --<br>`x-api-key: sk_live_...` *(con `can_manage_keys=true`)* | **Doble Autenticación:**<br>1. **Administrador (`x-admin-secret`):** Control total entre organizaciones, puede otorgar `canManageKeys=true` y promover llaves existentes vía `PATCH`.<br>2. **Llave Maestra (`can_manage_keys=true`):** Autoservicio para su propia organización (ignora `orgId` del body, siempre crea con `can_manage_keys=false`, anti-escalada, anti-autoeliminación y aislamiento multi-tenant). |
| `/api/upload` | `POST`, `PUT` | `x-api-key: sk_live_...`<br>`x-user-id: <UUID_usuario>` | `POST`: Limpieza oportunista de tickets vencidos, control de cuotas (`413` / `429`) y emisión de URL prefirmada S3 con soporte de `sha256Hash`.<br>`PUT`: Confirmación con `HeadObject`, `Range GET` de 32 bytes (`422 MAGIC_BYTES_MISMATCH` si discrepa), validación `sha256Verified` y despacho de webhook `file.uploaded` con IP fijada. |
| `/api/upload/multipart` | `POST`, `GET`, `PUT`, `DELETE` | `x-api-key: sk_live_...`<br>`x-user-id: <UUID_usuario>` | `POST (action="create")`: Inicia subida multipart en S3.<br>`POST (action="presign_part")`: Firma URL para cada parte (mín. 5 MB).<br>`GET`: Lista partes subidas en S3 (`ListPartsCommand`).<br>`PUT`: Ensambla partes en S3, valida 32 bytes (`Range GET`) y despacha webhook.<br>`DELETE`: Aborta subida multipart en S3 (`AbortMultipartUploadCommand`). |
| `/api/files` | `GET` | `x-api-key: sk_live_...`<br>`x-user-id: <UUID_usuario>` | Lista archivos confirmados (`fileStatus: "uploaded"`) de la organización. Oculta `cloudfront_url` en archivos privados (`null`). |
| `/api/files/:id` | `GET`, `DELETE` | `x-api-key: sk_live_...`<br>`x-user-id: <UUID_usuario>` | `GET`: Para privados entrega URL prefirmada de S3 (`delivery: "s3_presigned"`, TTL 5 min, `cloudfrontUrl: null`) solo al dueño (`403 FORBIDDEN_PRIVATE_NOT_OWNER` a otros usuarios). Para públicos entrega CDN CloudFront (`delivery: "cloudfront"`).<br>`DELETE`: Borra objeto de S3 (deduplicando claves) y registro en BD. |
| `/api/files/:id/status` | `GET`, `POST` | `x-api-key: sk_live_...`<br>`x-user-id: <UUID_usuario>` | `GET`: Consulta estado transaccional (`fileStatus`, `scanStatus`, `sha256Verified`).<br>`POST`: Re-despacha manualmente el webhook usando la URL configurada en la organización. |
| `/api/webhooks/test-receiver` | `POST`, `GET` | `POST`: `x-webhook-signature` (HMAC-SHA256)<br>`GET`: `x-admin-secret` | Receptor de pruebas integrado para verificar entregas reales de webhooks y validez criptográfica de la firma HMAC. |
| `/api/logs` | `GET`, `PATCH`, `DELETE` | `x-admin-secret: <ADMIN_API_SECRET>` | Consulta y mantenimiento de bitácora de auditoría en `public.service_logs`. |
| `/api/records` | `GET`, `DELETE` | `x-admin-secret: <ADMIN_API_SECRET>` | Consulta y limpieza administrativa de `public.files`. |
| `/api/users` | `GET` | `x-admin-secret: <ADMIN_API_SECRET>` | Catálogo de usuarios y organizaciones registradas. |
| `/api/cron/maintenance` | `GET`, `POST` | `Authorization: Bearer <CRON_SECRET>` | Ejecuta 5 tareas: limpieza de tickets expirados, multiparts huérfanos, reintento de webhooks pendientes, limpieza de `rate_limit_buckets` (>1 día) y anonimización de IPs (>30 días). |

---

## 🛡️ 2. REGLAS DE SEGURIDAD VERIFICADAS EN PRODUCCIÓN

1. **Higienización de Cabeceras (Anti-Spoofing):**
   El middleware elimina incondicionalmente cualquier cabecera interna (`x-validated-*`, `x-can-manage-keys`, `x-caller-*`, `x-api-key-*`) enviada por el cliente antes de inyectar contexto verificado. Además, `/api/keys` y `/api/organizations` re-consultan Supabase directamente por el hash SHA-256 (`hashed_key`) de la llave llamante.
2. **Llaves Vinculadas a Usuario vs Organización:**
   Una llave atada a un usuario (`user_id IS NOT NULL`) jamás puede gestionar llaves (`can_manage_keys = false` forzado por constraint `CHECK` en PostgreSQL). Solo las llaves de organización (`user_id IS NULL`) pueden ser maestras.
3. **Cupo Atómico (`max_api_keys`):**
   Se valida en PostgreSQL mediante el trigger `trigger_check_api_keys_quota` con bloqueo exclusivo `SELECT COALESCE(max_api_keys, 3) FROM public.organizations WHERE id = NEW.org_id FOR UPDATE;`. Serializa peticiones concurrentes (`Promise.all`) y devuelve `409 MAX_API_KEYS_LIMIT_REACHED` al alcanzar el tope.
4. **Rate Limiting Compartido en PostgreSQL (Fail-Open):**
   Límite de **20 peticiones / 60s** en `/api/keys` (`429 KEYS_RATE_LIMIT_EXCEEDED` con cabecera `Retry-After`) y **60 peticiones / 60s** en `/api/upload`. Utiliza la función atómica `check_rate_limit_atomic` sobre `public.rate_limit_buckets` guardando solo el UUID de la llave o el hash SHA-256 directo de la IP (`<scope>:<kind>:h:<sha256hex>`). Si la BD falla, opera en modo **Fail-Open** (`allowed: true`) respaldado por el limitador en memoria del Edge.
5. **Protección Anti-SSRF con Socket Fijado a la IP y Circuit Breaker en Webhooks:**
   - `isIpBlocked()` rechaza por defecto cualquier cadena no interpretable como IP y bloquea loopback (`127.0.0.0/8`, `::1`), red cero (`0.0.0.0/8`), IPv4-mapped IPv6 (`::ffff:127.0.0.1`, `::ffff:7f00:1`), redes privadas (`10/8`, `172.16/12`, `192.168/16`, `fc00::/7`), link-local (`169.254/16`) y notaciones octales/hexadecimales/decimales.
   - `executePinnedHttpsPost()` abre la conexión HTTPS fijando la función `lookup` a la IP ya validada (`[{ address: pinnedIp, family: pinnedFamily }]` cuando `options.all === true`), conservando `Host` y SNI TLS sin segundo DNS lookup (mitigación total contra DNS Rebinding / TOCTOU).
   - **Circuit Breaker:** Si las últimas 3 entregas de la organización no fueron entregadas (`status !== 'delivered'`), la siguiente subida encola el webhook inmediatamente (`error: "CIRCUIT_BREAKER_QUEUED"`) sin bloquear la respuesta HTTP del usuario.

---

## 📋 3. VARIABLES DE LA COLECCIÓN POSTMAN

Al importar [`postman_collection.json`](file:///C:/Users/alano/Desktop/github/cloudinary-project/servicio/postman_collection.json) en Postman, configura estas variables en la pestaña **Variables** de la colección:

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

## 🚀 4. GUÍA PASO A PASO DE TODOS LOS MÉTODOS EN POSTMAN

---

### SECCIÓN 0: Salud, Organizaciones, Webhooks y Protección Anti-SSRF (`/api/health`, `/api/organizations`)

#### Método 0.0: Healthcheck Público (`GET /api/health`)
* **Método:** `GET`
* **URL:** `{{baseUrl}}/api/health`
* **Headers:** Ninguno (ruta pública).
* **Respuesta Esperada (`200 OK`):**
  ```json
  {
    "status": "ok",
    "service": "cloudinary-aws-backend",
    "timestamp": "2026-10-27T15:30:00.000Z"
  }
  ```

#### Método 0.0A: Consultar Mi Organización (`GET /api/organizations`)
* **Método:** `GET`
* **URL:** `{{baseUrl}}/api/organizations`
* **Headers:**
  ```http
  x-api-key: {{apiKey}}
  ```
  *(También acepta `x-admin-secret: {{adminSecret}}` para listar todas las organizaciones).*
* **Respuesta Esperada (`200 OK`):** Devuelve los límites de cuota (`max_storage_bytes`, `max_pending_tickets`, `max_api_keys`) y el `webhook_url` actual de la organización.

#### Método 0.0B: Configurar Webhook en Autoservicio (`PATCH /api/organizations` con `x-api-key`)
* **Método:** `PATCH`
* **URL:** `{{baseUrl}}/api/organizations`
* **Headers:**
  ```http
  Content-Type: application/json
  x-api-key: {{apiKey}}
  ```
* **Body (raw JSON):**
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
    "message": "Configuración de webhook actualizada exitosamente.",
    "organization": {
      "id": "11111111-1111-1111-1111-111111111111",
      "webhook_url": "https://cloudinary-aws-backend.vercel.app/api/webhooks/test-receiver",
      "has_webhook_secret": true
    }
  }
  ```

#### Método 0.0C: [Seguridad] Bloqueo de Modificación de Cuotas con Llave Maestra (`PATCH /api/organizations`)
* **Método:** `PATCH`
* **URL:** `{{baseUrl}}/api/organizations`
* **Headers:**
  ```http
  Content-Type: application/json
  x-api-key: {{apiKey}}
  ```
* **Body (raw JSON):**
  ```json
  {
    "maxStorageBytes": 999999999999,
    "maxApiKeys": 50
  }
  ```
* **Respuesta Esperada (`403 Forbidden`):**
  ```json
  {
    "error": "Forbidden",
    "code": "FORBIDDEN_QUOTA_MODIFICATION",
    "message": "Las llaves de organización solo pueden modificar webhookUrl y webhookSecret. La modificación de cuotas requiere x-admin-secret."
  }
  ```

#### Método 0.0D: [Seguridad SSRF] Bloqueo de Webhook hacia IP Interna/Loopback (`PATCH /api/organizations`)
* **Método:** `PATCH`
* **URL:** `{{baseUrl}}/api/organizations`
* **Headers:**
  ```http
  Content-Type: application/json
  x-api-key: {{apiKey}}
  ```
* **Body (raw JSON):**
  *(Puedes probar cualquiera de los vectores bloqueados: `https://[::1]/`, `https://[::ffff:127.0.0.1]/`, `https://[::ffff:7f00:1]/`, `https://[fd00::1]/`, `https://127.1/`, `https://0x7f.1/`, `https://2130706433/`, `https://0177.0.0.1/` o `https://localtest.me/`)*:
  ```json
  {
    "webhookUrl": "https://[::ffff:127.0.0.1]/internal"
  }
  ```
* **Respuesta Esperada (`400 Bad Request`):**
  ```json
  {
    "error": "Bad Request",
    "code": "INVALID_WEBHOOK_URL",
    "message": "SSRF bloqueado: la IP literal '::ffff:7f00:1' pertenece a un rango privado, loopback o reservado."
  }
  ```

#### Método 0.0E: Modificar Cuotas o Restaurar Webhook como Admin (`PATCH /api/organizations` con `x-admin-secret`)
* **Método:** `PATCH`
* **URL:** `{{baseUrl}}/api/organizations`
* **Headers:**
  ```http
  Content-Type: application/json
  x-admin-secret: {{adminSecret}}
  ```
* **Body (raw JSON):**
  ```json
  {
    "id": "11111111-1111-1111-1111-111111111111",
    "maxApiKeys": 3,
    "maxPendingTickets": 20,
    "maxStorageBytes": 5368709120,
    "webhookUrl": null
  }
  ```
* **Respuesta Esperada (`200 OK`):** Actualiza las cuotas y limpia `webhook_url` a `null`.

---

### SECCIÓN 0.1 - 0.3: Gestión de API Keys con Doble Autenticación (`/api/keys`)

#### Método 0.1A: Crear API Key Maestra de Organización (`POST /api/keys` con `x-admin-secret`)
* **Método:** `POST`
* **URL:** `{{baseUrl}}/api/keys`
* **Headers:**
  ```http
  Content-Type: application/json
  x-admin-secret: {{adminSecret}}
  ```
* **Body (raw JSON):**
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
* **Respuesta Esperada (`201 Created`):** Guarda automáticamente `apiKey` y `keyId` en las variables de la colección Postman.

#### Método 0.1B: Delegación — Crear API Key Secundaria (`POST /api/keys` con `x-api-key` maestra)
* **Método:** `POST`
* **URL:** `{{baseUrl}}/api/keys`
* **Headers:**
  ```http
  Content-Type: application/json
  x-api-key: {{apiKey}}
  ```
* **Body (raw JSON):**
  ```json
  {
    "name": "Llave Secundaria de Subida",
    "canRead": true,
    "canUpload": true,
    "canDelete": false
  }
  ```
* **Respuesta Esperada (`201 Created`):** Crea la llave subordinada con `can_manage_keys: false` y guarda `secondaryApiKey` y `secondaryKeyId`. Si la organización ya tiene 3 llaves activas (`max_api_keys = 3`), el trigger atómico en PostgreSQL la rechaza con **`409 Conflict` (`MAX_API_KEYS_LIMIT_REACHED`)**.

#### Método 0.1C: [Seguridad] Intento de Escalada de Privilegios (`POST /api/keys`)
* **Método:** `POST`
* **URL:** `{{baseUrl}}/api/keys`
* **Headers:**
  ```http
  Content-Type: application/json
  x-api-key: {{secondaryApiKey}}
  ```
* **Body (raw JSON):**
  ```json
  {
    "name": "Intento Escalada",
    "canRead": true,
    "canUpload": true,
    "canDelete": true
  }
  ```
* **Respuesta Esperada (`403 Forbidden`):** Código `CANNOT_MANAGE_KEYS` (si llama una llave con `can_manage_keys=false`) o `PRIVILEGE_ESCALATION_BLOCKED` (si una llave maestra intenta otorgar un permiso que ella no tiene).

#### Método 0.1D: Promover Llave Existente a Maestra (`PATCH /api/keys` con `x-admin-secret`)
* **Método:** `PATCH`
* **URL:** `{{baseUrl}}/api/keys`
* **Headers:**
  ```http
  Content-Type: application/json
  x-admin-secret: {{adminSecret}}
  ```
* **Body (raw JSON):**
  ```json
  {
    "id": "{{keyId}}",
    "canManageKeys": true
  }
  ```
* **Respuesta Esperada (`200 OK`):** Actualiza `can_manage_keys: true` sin ser bloqueado por el trigger de cupo aunque la organización esté al límite de llaves activas.

#### Métodos 0.2A y 0.2B: Listar API Keys (`GET /api/keys`)
* **Con `x-admin-secret`:** `GET {{baseUrl}}/api/keys?org_id={{orgId}}`
* **Con `x-api-key` maestra:** `GET {{baseUrl}}/api/keys`
* **Respuesta Esperada (`200 OK`):** Lista metadatos de las llaves sin exponer jamás la llave en claro ni el hash completo.

#### Métodos 0.3A, 0.3B y 0.3C: Revocar o Eliminar API Keys (`DELETE /api/keys`)
* **0.3A (Auto-eliminación bloqueada):** `DELETE {{baseUrl}}/api/keys?id={{keyId}}&mode=revoke` con `x-api-key: {{apiKey}}` -> **`403 CANNOT_DELETE_SELF`**.
* **0.3B (Aislamiento entre organizaciones):** `DELETE {{baseUrl}}/api/keys?id={{otherOrgKeyId}}&mode=revoke` con `x-api-key: {{apiKey}}` -> **`404 API_KEY_NOT_FOUND`** (impide revocar llaves de otra organización).
* **0.3C (Revocación legítima de llave secundaria):** `DELETE {{baseUrl}}/api/keys?id={{secondaryKeyId}}&mode=revoke` con `x-api-key: {{apiKey}}` -> **`200 OK`**.

---

### SECCIÓN 1 - 3: Subida Simple Directa a S3, Checksum SHA-256, Magic Bytes y Entrega (`/api/upload`, `/api/files`)

#### Método 1 (y 1.0B): Solicitar Ticket de Subida (`POST /api/upload`)
* **Método:** `POST`
* **URL:** `{{baseUrl}}/api/upload`
* **Headers:**
  ```http
  Content-Type: application/json
  x-api-key: {{apiKey}}
  x-user-id: {{userId}}
  ```
* **Body (raw JSON — Subida Simple o con Checksum SHA-256):**
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
  *(Nota: `sha256Hash` es opcional y acepta SHA-256 en Hex de 64 caracteres o Base64 de 44 caracteres. Si se envía, la URL prefirmada de S3 firmará `x-amz-checksum-sha256` en `X-Amz-SignedHeaders`).*
* **Respuestas de Control de Cuotas (cuando se exceden límites):**
  * Si supera `max_storage_bytes`: **`413 Payload Too Large` (`STORAGE_QUOTA_EXCEEDED`)**.
  * Si supera `max_pending_tickets` (después de ejecutar la limpieza oportunista de tickets vencidos): **`429 Too Many Requests` (`PENDING_TICKETS_QUOTA_EXCEEDED`)**.
* **Respuesta Esperada (`200 OK`):** Guarda automáticamente `ticketId`, `fileId`, `confirmToken` y `uploadUrl` en las variables de la colección.

#### Método 2: Subida Directa Binaria a AWS S3 (`PUT {{uploadUrl}}`)
* **Método:** `PUT`
* **URL:** `{{uploadUrl}}`
* **Headers:** Copia exactamente las cabeceras devueltas en `requiredHeaders` del Paso 1:
  ```http
  Content-Type: image/png
  Cache-Control: private, no-store, no-cache, max-age=0, must-revalidate
  ```
  *(Si usaste el Paso 1.0B con `sha256Hash`, incluye también `x-amz-checksum-sha256: <valor_base64_devuelto_en_requiredHeaders>`).*
* **Verificación de Integridad en S3:**
  * Si envías un `x-amz-checksum-sha256` distinto al firmado, **AWS S3 rechaza la subida con `403 Forbidden` (`SignatureDoesNotMatch` / `BadDigest`)**.
  * Si el checksum y las cabeceras coinciden, **AWS S3 responde `200 OK`**.

#### Método 3: Confirmar Subida en el Backend (`PUT /api/upload`)
* **Método:** `PUT`
* **URL:** `{{baseUrl}}/api/upload`
* **Headers:**
  ```http
  Content-Type: application/json
  x-api-key: {{apiKey}}
  x-user-id: {{userId}}
  ```
* **Body (raw JSON):**
  ```json
  {
    "ticketId": "{{ticketId}}",
    "confirmToken": "{{confirmToken}}"
  }
  ```
* **Respuesta Esperada (`200 OK`):**
  ```json
  {
    "status": "success",
    "fileId": "...",
    "fileStatus": "uploaded",
    "scanStatus": "not_scanned",
    "visibility": "private",
    "sha256Verified": true,
    "cloudfrontUrl": null,
    "verification": {
      "magicBytesVerified": true,
      "detectedMimeType": "image/png",
      "sha256Verified": true
    },
    "webhook": {
      "delivered": true,
      "attempts": 1,
      "lastStatusCode": 200,
      "deliveryId": "..."
    }
  }
  ```
* **Respuesta de Rechazo por Seguridad de Magic Bytes (`422 Unprocessable Entity`):**
  Si el archivo subido a S3 no tiene la firma binaria real del MIME declarado (por ejemplo, texto plano subido como `image/png`), el backend lee los primeros 32 bytes mediante `Range: bytes=0-31`, elimina el objeto de S3, marca el registro como `failed` y responde:
  ```json
  {
    "error": "Unprocessable Entity",
    "code": "MAGIC_BYTES_MISMATCH",
    "method": "PUT",
    "message": "Cabecera binaria inválida: detectado 'desconocido' no coincide con el tipo MIME declarado 'image/png'.",
    "detectedMime": "desconocido",
    "declaredMime": "image/png"
  }
  ```

#### Método 3.1: Listar Archivos de la Organización (`GET /api/files`)
* **Método:** `GET`
* **URL:** `{{baseUrl}}/api/files?limit=20&offset=0`
* **Headers:** `x-api-key: {{apiKey}}`, `x-user-id: {{userId}}`
* **Respuesta Esperada (`200 OK`):** Lista los archivos con `fileStatus: "uploaded"` y `sha256_verified`. Los archivos privados tienen siempre `cloudfront_url: null`.

#### Métodos 3.2 y 3.2B: Obtener URL de Entrega Privada vs Pública (`GET /api/files/{{fileId}}`)
* **3.2 Como Propietario (`x-user-id: {{userId}}`):**
  * **Si el archivo es `private`:** Devuelve `200 OK` con `delivery: "s3_presigned"`, `cloudfrontUrl: null`, `expiresInSeconds: 300` y una URL prefirmada directa de S3 (`practicas-alan-418272802078.s3.us-east-1.amazonaws.com/static/private/...`).
  * **Si el archivo es `public`:** Devuelve `200 OK` con `delivery: "cloudfront"` y `cloudfrontUrl: "https://d1nuawu3owad6c.cloudfront.net/static/files/..."`.
* **3.2B Como Otro Usuario (`x-user-id: {{otherSameOrgUserId}}`) sobre un archivo `private`:**
  * Devuelve **`403 Forbidden`** con `"code": "FORBIDDEN_PRIVATE_NOT_OWNER"`.

#### Métodos 3.4, 3.5 y 3.6: Estado, Re-despacho de Webhook y Eliminación (`/api/files/{{fileId}}`)
* **3.4 Consultar Estado (`GET /api/files/{{fileId}}/status`):** Devuelve `fileStatus: "uploaded"`, `scanStatus: "not_scanned"`, `sha256Verified`.
* **3.5 Re-despachar Webhook (`POST /api/files/{{fileId}}/status`):** Re-envía el evento `file.uploaded` al `webhook_url` configurado en la organización.
* **3.6 Eliminar Archivo (`DELETE /api/files/{{fileId}}`):** Borra el objeto en S3 (deduplicando `s3_pending_key` y `s3_processed_key`) y elimina la fila en base de datos (`200 OK`).

---

### SECCIÓN 4: Subida Multipart para Archivos Grandes (`/api/upload/multipart`)

> **Nota de AWS S3:** En subidas multipart de más de 1 parte, AWS S3 exige que cada parte (excepto la última) tenga un tamaño mínimo de **5 MB (`5,242,880` bytes)**. Además, la **Parte 1** debe iniciar con los magic bytes reales del formato declarado (ej. cabecera PNG `89 50 4E 47 0D 0A 1A 0A`).

1. **Método 4.1 — Iniciar Subida Multipart (`POST /api/upload/multipart`):**
   * **Body:**
     ```json
     {
       "action": "create",
       "fileName": "archivo-grande.png",
       "fileType": "image/png",
       "fileSize": 10485760,
       "visibility": "private"
     }
     ```
   * **Resultado (`200 OK`):** Guarda automáticamente `multipartTicketId`, `multipartFileId`, `multipartUploadId` y `multipartConfirmToken`.
2. **Métodos 4.2 y 4.3 — Obtener URLs Prefirmadas por Parte (`POST /api/upload/multipart`):**
   * **Body:** `{ "action": "presign_part", "ticketId": "{{multipartTicketId}}", "partNumber": 1 }` (y luego `partNumber: 2`).
   * **Resultado (`200 OK`):** Guarda `part1UploadUrl` y `part2UploadUrl`.
3. **Métodos 4.4 y 4.5 — Subir Binario de Parte 1 y Parte 2 a S3 (`PUT {{part1UploadUrl}}` y `PUT {{part2UploadUrl}}`):**
   * Adjunta el binario de 5 MB en `Body -> binary` y envía el `PUT` directo a S3.
   * El script de test de Postman captura automáticamente la cabecera `ETag` devuelta por S3 en `part1ETag` y `part2ETag`.
4. **Método 4.6 — Listar Partes Subidas en S3 (`GET /api/upload/multipart?ticketId={{multipartTicketId}}`):**
   * Consulta en tiempo real a S3 (`ListPartsCommand`) las partes recibidas y sus `ETag`.
5. **Método 4.7 — Completar Subida Multipart (`PUT /api/upload/multipart`):**
   * **Body:**
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
   * **Resultado (`200 OK`):** S3 ensambla el objeto de 10 MB, el backend verifica los primeros 32 bytes mediante `Range GET` (`magicBytesVerified: true`), actualiza `fileStatus: "uploaded"` y despacha el webhook.
6. **Método 4.8 — Abortar Subida Multipart (`DELETE /api/upload/multipart?ticketId={{multipartTicketId}}`):**
   * Cancela una subida multipart en curso (`AbortMultipartUploadCommand`) y elimina el ticket pendiente.

---

### SECCIÓN 5 - 9: Receptor de Webhooks, Auditoría y Cron de Mantenimiento

* **Método 5 (`GET /api/webhooks/test-receiver` con `x-admin-secret`):** Devuelve los últimos webhooks recibidos en el endpoint de pruebas junto con `"signatureValid": true` y el payload verificado.
* **Método 6 (`GET /api/logs` con `x-admin-secret`):** Consulta la bitácora `service_logs`.
* **Método 7 (`GET /api/records` con `x-admin-secret`):** Consulta registros administrativos de `public.files`.
* **Método 8 (`GET /api/users` con `x-admin-secret`):** Lista organizaciones y usuarios registrados.
* **Método 9 (`GET /api/cron/maintenance` con `Authorization: Bearer {{cronSecret}}`):** Ejecuta las 5 tareas de limpieza (tickets expirados, multiparts abandonados, reintentos de webhooks pendientes, limpieza de `rate_limit_buckets` > 1 día y anonimización de IPs en logs > 30 días).

---

## ✅ 5. RESUMEN DE VERIFICACIÓN EN PRODUCCIÓN (FASE 2 COMPLETADA)

Todas las pruebas de la Fase 2 fueron ejecutadas y verificadas contra el despliegue en producción (`https://cloudinary-aws-backend.vercel.app`) usando la Organización 1 de prueba y restaurando todos los límites y registros al finalizar:

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
