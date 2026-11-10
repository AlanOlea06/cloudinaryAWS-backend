# Documentación de Consumo e Integración del Servicio (S3 + CloudFront + PostgreSQL)

> **URL Base de Producción:** `https://d1nuawu3owad6c.cloudfront.net`  
> **Documentación OpenAPI Interactiva:** `https://d1nuawu3owad6c.cloudfront.net/docs`  
> **Especificación YAML:** `https://d1nuawu3owad6c.cloudfront.net/docs/openapi.yaml`

---

## 1. Endpoints Principales Ordenados por Frecuencia de Uso del Desarrollador

| Orden | Operación | Endpoint | Cabeceras |
| :---: | :--- | :--- | :--- |
| **1** | **Solicitar ticket de subida (`<= 25 MB`)** | `POST /api/upload` | `x-api-key`, `x-user-id` |
| **2** | **Confirmar subida y mover de `pending` a `public`/`private`** | `PUT /api/upload?ticketId=<uuid>` | `x-api-key`, `x-user-id` |
| **3** | **Pedir archivo y obtener link (CloudFront o S3 Presigned)** | `GET /api/files/:id` | `x-api-key`, `x-user-id` |
| **4** | **Listar archivos de tu organización** | `GET /api/files` | `x-api-key` |
| **5** | **Eliminar archivo de S3 y liberar cuota** | `DELETE /api/files/:id` | `x-api-key`, `x-user-id` |
| **6** | **Crear organización y API Key Maestra (Onboarding)** | `POST /api/organizations` | Body con `inviteCode` |
| **7** | **Registrar o listar usuarios de tu organización** | `POST /api/users` y `GET /api/users` | `x-api-key` |
| **8** | **Subida Multipart para archivos grandes (`> 25 MB` a `500 MB`)** | `POST /api/upload/multipart` | `x-api-key`, `x-user-id` |
| **9** | **Consultar logs de tu organización** | `GET /api/logs` | `x-api-key` |
| **10** | **Crear API Keys secundarias y configurar Webhooks** | `POST /api/keys` y `PATCH /api/organizations` | `x-api-key` (Maestra) |

---

## 2. Uso Diario #1: Subir un Archivo (`POST /api/upload` -> `PUT S3` -> `PUT /api/upload`)

### Paso 1: Solicitar Ticket (`POST /api/upload`)
```http
POST https://d1nuawu3owad6c.cloudfront.net/api/upload
Content-Type: application/json
x-api-key: TU_API_KEY
x-user-id: TU_USER_ID

{
  "fileName": "Captura para pruebas.png",
  "fileType": "image/png",
  "fileSize": 289159,
  "visibility": "public",
  "sha256Hash": "8c44e6f2915666a4ad83dcf5aaf620cd51e5657eba5a01f4fe6fd5037b345345"
}
```
* El servicio genera una URL prefirmada hacia `static/pending/{org_id}/` y te devuelve `ticketId`, `fileId`, `uploadUrl`, `requiredHeaders` y `confirmToken`.

### Paso 2: Subir el binario directo a S3 (`PUT <uploadUrl>`)
Envía el binario del archivo a `uploadUrl` incluyendo exactamente las cabeceras de `requiredHeaders`.

### Paso 3: Confirmar la Subida (`PUT /api/upload?ticketId=<ticketId>`)
```http
PUT https://d1nuawu3owad6c.cloudfront.net/api/upload?ticketId=130828db-9a08-4cf3-9829-4ebdfcfbbb75
Content-Type: application/json
x-api-key: TU_API_KEY
x-user-id: TU_USER_ID

{
  "confirmToken": "TU_CONFIRM_TOKEN"
}
```
* El servidor verifica en S3 el tamaño (`HeadObject`), el checksum **SHA-256** y los primeros 32 bytes (**Magic Bytes**), y mueve el archivo de `static/pending/{org_id}/` hacia:
  * `static/public/{org_id}/` si es `public`.
  * `static/private/{org_id}/` si es `private`.

---

## 3. Uso Diario #2: Consumir / Pedir un Archivo (`GET /api/files/:id`)

```http
GET https://d1nuawu3owad6c.cloudfront.net/api/files/27ebb714-e03c-4a55-bcaa-0232a2391ef9
x-api-key: TU_API_KEY
x-user-id: TU_USER_ID
```
* **Si es `public`:** Devuelve `url` permanente de **Amazon CloudFront CDN** (`https://d1nuawu3owad6c.cloudfront.net/static/public/{org_id}/{archivo}`).
* **Si es `private`:** Verifica que `x-user-id` sea el propietario y devuelve una **URL prefirmada de S3 válida por 5 minutos (300 s)** (`https://practicas-alan-418272802078.s3.us-east-1.amazonaws.com/static/private/{org_id}/{archivo}?X-Amz-Expires=300...`).

---

## 4. Onboarding: Crear Organización (`POST /api/organizations`) y Usuarios (`POST /api/users`)

### 1. Crear una Organización Nueva
```http
POST https://d1nuawu3owad6c.cloudfront.net/api/organizations
Content-Type: application/json

{
  "name": "Mi Plataforma",
  "slug": "mi-plataforma",
  "inviteCode": "TU_CODIGO_DE_INVITACION",
  "keyLabel": "Master Key"
}
```
Devuelve `201 Created` con tu `apiKey` Maestra (`sk_live_...`), los datos de `organization` y `defaultUser`.

### 2. Crear o Resolver un Usuario (`POST /api/users` o Automático vía `x-user-id`)
* **Automático:** Puedes enviar cualquier identificador de tu sistema en la cabecera `x-user-id` (ej. `"1"`, `"cliente_001"` o un UUID) al subir un archivo y el servicio calculará su UUID determinista por organización (`UUID_SHA256(org_id + ":" + x-user-id)`) y lo registrará al vuelo sin colisiones con otras organizaciones.
* **Explícito (`POST /api/users`):**
```http
POST https://d1nuawu3owad6c.cloudfront.net/api/users
Content-Type: application/json
x-api-key: TU_API_KEY

{
  "externalUserId": "cliente_001",
  "name": "Nombre del Usuario",
  "role": "editor",
  "canUpload": true
}
```
*(Roles soportados: `"editor"`, `"admin"`, `"viewer"`).*
