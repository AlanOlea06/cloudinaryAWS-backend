# Guía Rápida de Integración (Quickstart) — Servicio de Almacenamiento S3 / CloudFront

> **URL Base de Producción (AWS CloudFront sin caché):** `https://d1nuawu3owad6c.cloudfront.net` *(Espejo en Vercel: `https://cloudinary-aws-backend.vercel.app`)*  
> **Documentación Interactiva (OpenAPI 3.0):** `https://d1nuawu3owad6c.cloudfront.net/docs` | `https://cloudinary-aws-backend.vercel.app/docs`  
> **Especificación YAML:** `https://d1nuawu3owad6c.cloudfront.net/docs/openapi.yaml` | `https://cloudinary-aws-backend.vercel.app/docs/openapi.yaml`

Esta guía está diseñada para que puedas integrar el servicio de almacenamiento en **tu propio servidor (backend)** de principio a fin sin necesidad de soporte externo.

---

## 1. ¿Qué es el servicio y qué NO hace?

### Qué ES y qué HACE:
Es un servicio de plano de control (*control plane*) para almacenamiento de imágenes (`.jpg`, `.jpeg`, `.png`, `.webp`, `.gif`) y documentos (`.pdf`) con aislamiento **Multi-Tenant** por organización y usuario:
- **Subida directa a Amazon S3 sin pasar por el backend:** Nuestro servidor valida permisos, tipos y cuotas, y te entrega una **URL prefirmada de S3 (`uploadUrl`)** junto con un token criptográfico (`confirmToken`). Tu servidor envía el binario directamente a Amazon S3.
- **Verificación de integridad y formato real:** Al confirmar la subida, el servicio verifica en S3 el tamaño exacto (`HeadObject`), el checksum criptográfico **SHA-256** (`x-amz-checksum-sha256`) y los primeros **32 bytes binarios (*Magic Bytes*)** para impedir archivos falsificados.
- **Entrega diferenciada por visibilidad:**
  - Archivos `public`: Se entregan mediante **Amazon CloudFront CDN**.
  - Archivos `private`: Solo el usuario propietario puede solicitar una **URL prefirmada de S3 con vigencia de 5 minutos (300 s)**.
- **Notificaciones vía Webhooks firmados:** Envía eventos HTTP `POST` firmados con **HMAC-SHA256** (`x-webhook-signature`) a tu servidor cuando un archivo termina de confirmarse.

### Qué NO hace actualmente (ver [Sección 9: Limitaciones Conocidas](#9-limitaciones-conocidas)):
- **No recibe archivos binarios en Vercel:** Ningún endpoint de la API recibe `multipart/form-data` con el archivo; los bytes siempre viajan de tu backend a la URL prefirmada de Amazon S3.
- **No permite subida directa desde el navegador (Frontend):** Por restricciones de permisos sobre la configuración CORS del bucket S3 actual, el `PUT` hacia S3 debe ejecutarse desde **tu backend**.
- **No ejecuta antivirus profundo (`scan_status = "not_scanned"`):** Solo valida estructura binaria (*Magic Bytes* de 32 bytes) y checksum SHA-256.
- **No limpia metadatos EXIF ni transforma imágenes en producción:** La limpieza de EXIF y el redimensionamiento dinámico (`/api/img`) pertenecen a una etapa futura y están deshabilitados en producción.

---

## 2. Cómo obtener una API Key

Actualmente el alta inicial de organizaciones, usuarios y la primera API Key la realiza el **administrador de la plataforma**.

### ¿Qué debes solicitar al administrador para empezar?
Solicita al administrador los siguientes datos para tu entorno:
1. **`orgId` (UUID de tu Organización):** Identificador único de tu organización (y los límites de cuota que requieras).
2. **Lista de `userId` (UUIDs de tus usuarios registrados):** Cada archivo subido debe asociarse a un usuario registrado en tu organización con permiso de subida (`can_upload = true`).
3. **Tu `API Key` inicial (`sk_live_...`):**
   - Pide una **API Key Maestra de Organización** (`can_manage_keys = true`, `can_read = true`, `can_upload = true`, `can_delete = true`).
   - **Importante:** Por arquitectura *Zero-Knowledge*, el servidor solo almacena el hash SHA-256 de la llave. Guarda tu `sk_live_...` en tus variables de entorno (`TU_API_KEY`) en cuanto la recibas, ya que no es posible recuperarla en texto plano después.

### ¿Cómo crear llaves adicionales tú mismo (Delegación)?
Si tu llave inicial tiene `can_manage_keys: true`, puedes crear llaves operativas secundarias (con `can_manage_keys: false`) desde tu propio backend sin contactar al administrador, hasta el límite `max_api_keys` de tu organización (por defecto **3 llaves activas**):

```bash
curl -X POST "https://cloudinary-aws-backend.vercel.app/api/keys" \
  -H "Content-Type: application/json" \
  -H "x-api-key: TU_API_KEY" \
  -d '{
    "name": "Backend Subidas Producción",
    "canRead": true,
    "canUpload": true,
    "canDelete": false
  }'
```

### Cabeceras de autenticación en tus peticiones:
- `x-api-key: TU_API_KEY` *(Obligatoria en todas las rutas protegidas)*.
- `x-user-id: TU_USER_UUID` *(Obligatoria cuando usas una llave de organización para indicar en nombre de qué usuario estás subiendo o leyendo un archivo)*.

---

## 3. Flujo de Subida Simple (archivos <= 25 MB)

El flujo consta siempre de **3 pasos**:
1. **Pedir ticket (`POST /api/upload`):** Envías nombre, tipo MIME, tamaño en bytes, visibilidad (`private` o `public`) y el hash **SHA-256 en hexadecimal** (64 caracteres). Recibes `ticketId`, `fileId`, `uploadUrl`, `requiredHeaders` y `confirmToken`.
2. **Subir binario a S3 (`PUT <uploadUrl>`):** Envías el archivo crudo directamente a `uploadUrl` incluyendo **exactamente** las cabeceras de `requiredHeaders` (`Content-Type`, `Cache-Control`, `Content-Length` y `x-amz-checksum-sha256` en **Base64**). **Nunca envíes `x-api-key` ni `x-user-id` a S3.**
3. **Confirmar subida (`PUT /api/upload?ticketId=<ticketId>`):** Envías el `confirmToken`. Nuestro servidor verifica el objeto en S3 (`HeadObject`, *Magic Bytes* y SHA-256) y marca el archivo como `uploaded`.

### ¿Por qué la cabecera `x-amz-checksum-sha256` debe coincidir exactamente?
Cuando declaras `sha256Hash` (en hexadecimal) al pedir el ticket en el Paso 1:
1. Nuestro servidor convierte ese hash SHA-256 a **Base64** y **lo incrusta dentro de la firma criptográfica de la URL prefirmada de S3** (`X-Amz-SignedHeaders=...;x-amz-checksum-sha256`).
2. Si en el Paso 2 omites la cabecera `x-amz-checksum-sha256` o envías un valor distinto al de `requiredHeaders["x-amz-checksum-sha256"]`, Amazon S3 rechazará la petición inmediatamente con **`403 Forbidden (SignatureDoesNotMatch)`**.
3. Si envías la cabecera firmada pero los bytes del archivo fueron alterados en tránsito, Amazon S3 calcula el SHA-256 real al recibir el flujo y rechaza la subida con **`400 Bad Request (BadDigest)`**.

---

### Ejemplo 3.A — Subida Simple con `curl` (Bash)

```bash
# Variables de configuración
BASE_URL="https://cloudinary-aws-backend.vercel.app"
API_KEY="TU_API_KEY"
USER_ID="TU_USER_UUID"
ARCHIVO="./documento.jpg"

# 0. Calcular tamaño en bytes, SHA-256 en Hex (para el ticket) y SHA-256 en Base64 (para S3)
FILE_SIZE=$(wc -c < "$ARCHIVO" | tr -d ' ')
SHA256_HEX=$(openssl dgst -sha256 "$ARCHIVO" | awk '{print $NF}')
SHA256_B64=$(openssl dgst -sha256 -binary "$ARCHIVO" | openssl base64)

echo "Tamaño: $FILE_SIZE bytes | SHA-256 Hex: $SHA256_HEX | SHA-256 Base64: $SHA256_B64"

# PASO 1: Solicitar ticket de subida
TICKET_RESPONSE=$(curl -s -X POST "$BASE_URL/api/upload" \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  -H "x-user-id: $USER_ID" \
  -d "{
    \"fileName\": \"documento.jpg\",
    \"fileType\": \"image/jpeg\",
    \"fileSize\": $FILE_SIZE,
    \"visibility\": \"private\",
    \"sha256Hash\": \"$SHA256_HEX\"
  }")

TICKET_ID=$(echo "$TICKET_RESPONSE" | jq -r '.ticketId')
FILE_ID=$(echo "$TICKET_RESPONSE" | jq -r '.fileId')
UPLOAD_URL=$(echo "$TICKET_RESPONSE" | jq -r '.uploadUrl')
CONFIRM_TOKEN=$(echo "$TICKET_RESPONSE" | jq -r '.confirmToken')

# PASO 2: Subir el archivo binario directamente a Amazon S3 (SIN x-api-key)
# Nota: Para PDFs (.pdf) agrega también: -H "Content-Disposition: attachment"
curl -i -X PUT "$UPLOAD_URL" \
  -H "Content-Type: image/jpeg" \
  -H "Cache-Control: private, no-store, no-cache, max-age=0, must-revalidate" \
  -H "Content-Length: $FILE_SIZE" \
  -H "x-amz-checksum-sha256: $SHA256_B64" \
  --data-binary "@$ARCHIVO"

# PASO 3: Confirmar la subida enviando ticketId en query y confirmToken en el body
curl -s -X PUT "$BASE_URL/api/upload?ticketId=$TICKET_ID" \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  -H "x-user-id: $USER_ID" \
  -d "{
    \"confirmToken\": \"$CONFIRM_TOKEN\"
  }" | jq .
```

---

### Ejemplo 3.B — Subida Simple en `Node.js` (v18+ / v20+)

```javascript
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const BASE_URL = 'https://cloudinary-aws-backend.vercel.app';
const API_KEY = process.env.STORAGE_API_KEY || 'TU_API_KEY';
const USER_ID = process.env.STORAGE_USER_ID || 'TU_USER_UUID';

export async function uploadSingleFile(filePath, mimeType = 'image/jpeg', visibility = 'private') {
  const fileBuffer = fs.readFileSync(filePath);
  const fileName = path.basename(filePath);
  const fileSize = fileBuffer.byteLength;

  // 1. Calcular SHA-256 en hexadecimal para declarar en el ticket
  const sha256Hex = crypto.createHash('sha256').update(fileBuffer).digest('hex');

  // PASO 1: Solicitar ticket de subida
  const ticketRes = await fetch(`${BASE_URL}/api/upload`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      'x-user-id': USER_ID,
    },
    body: JSON.stringify({
      fileName,
      fileType: mimeType,
      fileSize,
      visibility,
      sha256Hash: sha256Hex,
    }),
  });

  const ticketData = await ticketRes.json();
  if (!ticketRes.ok) {
    throw new Error(`Error al pedir ticket (${ticketRes.status}): ${ticketData.code} - ${ticketData.message}`);
  }

  const { ticketId, fileId, uploadUrl, requiredHeaders, confirmToken } = ticketData;

  // PASO 2: PUT directo a Amazon S3 usando exactamente las cabeceras firmadas en requiredHeaders
  const s3Res = await fetch(uploadUrl, {
    method: 'PUT',
    headers: requiredHeaders, // Incluye Content-Type, Cache-Control, Content-Length y x-amz-checksum-sha256
    body: fileBuffer,
  });

  if (!s3Res.ok) {
    const s3ErrorXml = await s3Res.text();
    throw new Error(`Error subiendo bytes a S3 (${s3Res.status}): ${s3ErrorXml}`);
  }

  // PASO 3: Confirmar subida en el backend (?ticketId=... es obligatorio en la query string)
  const confirmRes = await fetch(`${BASE_URL}/api/upload?ticketId=${encodeURIComponent(ticketId)}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      'x-user-id': USER_ID,
    },
    body: JSON.stringify({ confirmToken }),
  });

  const confirmData = await confirmRes.json();
  if (!confirmRes.ok) {
    throw new Error(`Error al confirmar subida (${confirmRes.status}): ${confirmData.code} - ${confirmData.message}`);
  }

  return confirmData; // Contiene fileId, fileStatus: 'uploaded', sha256Verified: true, cloudfrontUrl (si public)
}
```

---

## 4. Flujo Multipart para Archivos Grandes (> 25 MB y hasta 500 MB)

Cuando un archivo supera los **25 MB** (`26,214,400` bytes), debes usar `/api/upload/multipart`.
- **Regla de Amazon S3:** Cada parte (excepto la última) debe tener un tamaño mínimo de **5 MB (`5,242,880` bytes)**.
- **Pasos del flujo:**
  1. **Iniciar (`POST /api/upload/multipart` con `action: "create"`):** Devuelve `ticketId`, `fileId`, `uploadId` y `confirmToken` (vigente por 60 minutos).
  2. **Pedir URL por cada parte (`POST /api/upload/multipart` con `action: "presign_part"`):** Envías `ticketId` y `partNumber` (`1..10000`). Devuelve `uploadPartUrl` (vigente por 15 minutos).
  3. **Subir los bytes de cada parte a S3 (`PUT <uploadPartUrl>`):** S3 responde `200 OK` con una cabecera HTTP `ETag` (ej. `"b54357faf0632cce46e942fa68356b38"`). Guarda `{ PartNumber, ETag }` de cada parte.
  4. **Completar (`PUT /api/upload/multipart` o `POST` con `action: "complete"`):** Envías `ticketId`, `confirmToken` y el arreglo `parts`. S3 ensambla el archivo y nuestro servidor verifica tamaño y *Magic Bytes*.
  5. *(Opcional)* **Listar partes (`GET /api/upload/multipart?ticketId=...`)** para reanudar una subida interrumpida, o **Abortar (`DELETE /api/upload/multipart?ticketId=...`)** para cancelar y limpiar partes en S3.

### Ejemplo en `Node.js` — Subida Multipart Fragmentada

```javascript
import fs from 'node:fs';
import path from 'node:path';

const BASE_URL = 'https://cloudinary-aws-backend.vercel.app';
const API_KEY = process.env.STORAGE_API_KEY || 'TU_API_KEY';
const USER_ID = process.env.STORAGE_USER_ID || 'TU_USER_UUID';
const PART_SIZE = 10 * 1024 * 1024; // 10 MB por parte (debe ser >= 5 MB)

export async function uploadMultipartFile(filePath, mimeType = 'application/pdf', visibility = 'private') {
  const fileBuffer = fs.readFileSync(filePath);
  const fileName = path.basename(filePath);
  const fileSize = fileBuffer.byteLength;

  // 1. Iniciar sesión Multipart (action: "create")
  const createRes = await fetch(`${BASE_URL}/api/upload/multipart`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      'x-user-id': USER_ID,
    },
    body: JSON.stringify({
      action: 'create',
      fileName,
      fileType: mimeType,
      fileSize,
      visibility,
    }),
  });

  const createData = await createRes.json();
  if (!createRes.ok) {
    throw new Error(`Error al iniciar multipart (${createRes.status}): ${createData.code} - ${createData.message}`);
  }

  const { ticketId, fileId, confirmToken } = createData;
  const uploadedParts = [];

  try {
    // 2. Dividir el archivo en bloques y subir cada parte
    const totalParts = Math.ceil(fileSize / PART_SIZE);

    for (let partNumber = 1; partNumber <= totalParts; partNumber++) {
      const start = (partNumber - 1) * PART_SIZE;
      const end = Math.min(start + PART_SIZE, fileSize);
      const chunk = fileBuffer.subarray(start, end);

      // 2.a Pedir URL prefirmada para esta parte (action: "presign_part")
      const presignRes = await fetch(`${BASE_URL}/api/upload/multipart`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': API_KEY,
          'x-user-id': USER_ID,
        },
        body: JSON.stringify({
          action: 'presign_part',
          ticketId,
          partNumber,
        }),
      });

      const { uploadPartUrl, code, message } = await presignRes.json();
      if (!presignRes.ok) {
        throw new Error(`Error firmando parte ${partNumber}: ${code} - ${message}`);
      }

      // 2.b Subir el bloque binario directo a S3 (SIN x-api-key)
      const s3PartRes = await fetch(uploadPartUrl, {
        method: 'PUT',
        body: chunk,
      });

      if (!s3PartRes.ok) {
        throw new Error(`Fallo en S3 al subir parte ${partNumber} (HTTP ${s3PartRes.status})`);
      }

      const eTag = s3PartRes.headers.get('etag');
      uploadedParts.push({ PartNumber: partNumber, ETag: eTag });
    }

    // 3. Completar el Multipart Upload en S3 y verificar Magic Bytes
    const completeRes = await fetch(`${BASE_URL}/api/upload/multipart`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'x-user-id': USER_ID,
      },
      body: JSON.stringify({
        ticketId,
        confirmToken,
        parts: uploadedParts,
      }),
    });

    const completeData = await completeRes.json();
    if (!completeRes.ok) {
      throw new Error(`Error al completar multipart: ${completeData.code} - ${completeData.message}`);
    }

    return completeData;
  } catch (err) {
    // Si algo falla, abortar para no dejar partes huérfanas ocupando espacio en S3
    await fetch(`${BASE_URL}/api/upload/multipart?ticketId=${encodeURIComponent(ticketId)}&deleteRow=true`, {
      method: 'DELETE',
      headers: {
        'x-api-key': API_KEY,
        'x-user-id': USER_ID,
      },
    }).catch(() => {});
    throw err;
  }
}
```

---

## 5. Cómo Obtener un Archivo (Públicos vs Privados)

Para obtener la URL de descarga o visualización de cualquier archivo confirmado, llama a **`GET /api/files/{id}`**:

```bash
curl -s -X GET "https://cloudinary-aws-backend.vercel.app/api/files/b087905a-00fd-4bcf-812c-5d8ba159d6c1" \
  -H "x-api-key: TU_API_KEY" \
  -H "x-user-id: TU_USER_UUID"
```

### A) Archivos Públicos (`visibility: "public"`)
- La respuesta devuelve `delivery: "cloudfront"` y `url` apuntando a **Amazon CloudFront CDN** (`https://d1nuawu3owad6c.cloudfront.net/static/files/<hash>.<ext>`).
- Esta URL es estable (no tiene firma que caduque a los 5 minutos) y utiliza caché en el Edge (`Cache-Control: public, max-age=300, must-revalidate`).

### B) Archivos Privados (`visibility: "private"`)
- **Validación estricta de propietario:** Debes enviar en `x-user-id` el UUID del usuario propietario que subió el archivo. Si omites `x-user-id` recibirás `403 FORBIDDEN_PRIVATE_USER_REQUIRED`; si envías otro usuario recibirás `403 FORBIDDEN_PRIVATE_NOT_OWNER`.
- **URL Prefirmada de 5 minutos (`300` segundos):** La respuesta devuelve `delivery: "s3_presigned"`, `cloudfrontUrl: null`, `expiresInSeconds: 300` y una URL firmada de S3 en el campo `url`.
- **Expiración y renovación:** **Nunca guardes la `url` de un archivo privado de forma permanente en tu base de datos.** Guarda únicamente el `fileId`. Cada vez que el usuario final necesite ver o descargar el archivo privado y hayan pasado los 5 minutos, tu backend debe llamar nuevamente a `GET /api/files/{id}` para emitir una URL fresca.

---

## 6. Cómo Recibir Webhooks y Verificar la Firma HMAC-SHA256

### Paso 1: Configurar tu `webhookUrl` y `webhookSecret`
Usa tu API Key Maestra (`can_manage_keys = true`) para registrar la URL HTTPS pública de tu servidor:

```bash
curl -X PATCH "https://cloudinary-aws-backend.vercel.app/api/organizations" \
  -H "Content-Type: application/json" \
  -H "x-api-key: TU_API_KEY" \
  -d '{
    "webhookUrl": "https://api.tu-servidor.com/webhooks/storage",
    "webhookSecret": "TU_WEBHOOK_SECRET"
  }'
```
*(La URL debe ser obligatoriamente `https://` y resolver a una IP pública; URLs hacia `localhost` o redes privadas son bloqueadas por protección Anti-SSRF).*

### Paso 2: Cabeceras y Cuerpo del Webhook
Cuando un archivo se confirma, nuestro servidor hace un `POST` (timeout de 3.5 s, hasta 5 intentos con backoff exponencial: `60s`, `300s`, `1800s`, `7200s`) con estas cabeceras:
- `Content-Type: application/json`
- `x-webhook-signature: sha256=<hex_hmac>`
- `x-webhook-timestamp: 2026-11-06T18:00:00.000Z`
- `x-webhook-event: file.uploaded` (o `file.processed` / `file.failed`)
- `x-webhook-attempt: 1`
- `x-webhook-delivery-id: <uuid>`

### Paso 3: Verificación Criptográfica en tu Backend (Node.js / Express)
La firma se calcula haciendo `HMAC-SHA256(webhookSecret, "${timestamp}.${rawBody}")` y anteponiendo el prefijo `sha256=`. **Debes calcularla siempre sobre el cuerpo crudo (`rawBody`) antes de parsear el JSON:**

```javascript
import crypto from 'node:crypto';
import express from 'express';

const app = express();
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'TU_WEBHOOK_SECRET';

function verifyWebhookSignature(rawBody, timestampHeader, signatureHeader, secret) {
  if (!rawBody || !timestampHeader || !signatureHeader || !secret) {
    return false;
  }

  // Opcional recomendado: rechazar timestamps con más de 5 minutos de antigüedad (anti-replay)
  const ageMs = Math.abs(Date.now() - new Date(timestampHeader).getTime());
  if (Number.isNaN(ageMs) || ageMs > 5 * 60 * 1000) {
    return false;
  }

  const expectedSignature =
    'sha256=' +
    crypto
      .createHmac('sha256', secret.trim())
      .update(`${timestampHeader}.${rawBody}`)
      .digest('hex');

  const expectedBuf = Buffer.from(expectedSignature, 'utf8');
  const receivedBuf = Buffer.from(signatureHeader.trim(), 'utf8');

  if (expectedBuf.length !== receivedBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(expectedBuf, receivedBuf);
}

// Importante: usar express.raw({ type: 'application/json' }) para conservar los bytes exactos del cuerpo
app.post('/webhooks/storage', express.raw({ type: 'application/json' }), (req, res) => {
  const rawBody = req.body.toString('utf8');
  const signature = req.header('x-webhook-signature') || '';
  const timestamp = req.header('x-webhook-timestamp') || '';

  if (!verifyWebhookSignature(rawBody, timestamp, signature, WEBHOOK_SECRET)) {
    return res.status(401).json({ error: 'Firma HMAC-SHA256 inválida' });
  }

  const eventPayload = JSON.parse(rawBody);
  console.log('Webhook verificado:', eventPayload.event, 'fileId:', eventPayload.fileId);

  // Responde 2xx rápidamente (< 3.5 segundos) para confirmar recepción
  return res.status(200).json({ received: true });
});
```

---

## 7. Tabla de Errores Frecuentes y Cómo Resolverlos

| Código de Error (`code`) | HTTP | Qué significa | Qué debe hacer tu backend |
| :--- | :-: | :--- | :--- |
| `MISSING_API_KEY` | `401` | No enviaste la cabecera `x-api-key`. | Incluye `x-api-key: TU_API_KEY` en la petición. |
| `INVALID_OR_INACTIVE_API_KEY` | `403` | La API Key no existe o fue revocada (`is_active=false`). | Verifica que estés usando una llave activa de tu organización. |
| `INSUFFICIENT_API_KEY_PERMISSIONS` | `403` | La llave no tiene el permiso requerido (`can_read`, `can_upload` o `can_delete`). | Usa una llave que tenga habilitado el permiso para ese método HTTP. |
| `MISSING_END_USER_ID` | `400` | Usaste una llave de organización en subida sin enviar `x-user-id`. | Envía la cabecera `x-user-id` con el UUID v4 del usuario final. |
| `USER_NOT_REGISTERED` | `401` | El UUID enviado en `x-user-id` no existe en la base de datos. | Verifica que el usuario haya sido dado de alta en tu organización. |
| `FORBIDDEN_USER_ORG_MISMATCH` / `FORBIDDEN_CROSS_ORGANIZATION` | `403` | El usuario o recurso pertenece a otra organización. | Asegúrate de que `x-user-id` y el archivo pertenezcan a la organización de tu API Key. |
| `FORBIDDEN_USER_IMPERSONATION` | `403` | El `x-user-id` no coincide con el usuario dueño del ticket o vinculado a la llave. | Confirma el ticket con el mismo `x-user-id` que lo solicitó. |
| `EXTENSION_MIME_MISMATCH` | `400` | La extensión de `fileName` no coincide con `fileType` (ej. `.jpg` con `image/png`). | Envía el MIME exacto de la tabla de tipos permitidos. |
| `UNSUPPORTED_FILE_EXTENSION` / `XSS_DANGEROUS_FILE_TYPE` | `400` | Extensión fuera de la whitelist o bloqueada por XSS (`.svg`, `.html`, `.js`). | Sube únicamente `.jpg`, `.jpeg`, `.png`, `.webp`, `.gif` o `.pdf`. |
| `FILE_SIZE_EXCEEDS_LIMIT` | `413` | El archivo supera los 25 MB en subida simple (`POST /api/upload`). | Usa `/api/upload/multipart` para archivos de más de 25 MB (hasta 500 MB). |
| `MISSING_TICKET_ID` | `400` | En `PUT /api/upload`, falta `?ticketId=<uuid>` en la URL. | Pasa `ticketId` como query param: `PUT /api/upload?ticketId=...`. |
| `MISSING_CONFIRM_TOKEN` / `INVALID_CONFIRM_TOKEN` | `400` / `403` | Falta `confirmToken`, fue alterado o expiró. | Envía el `confirmToken` exacto devuelto al crear el ticket antes de que expire. |
| `FILE_NOT_UPLOADED_TO_S3` | `400` | Llamaste a confirmar antes de hacer el `PUT` binario a `uploadUrl`. | Sube primero los bytes a `uploadUrl` y espera el `200 OK` de S3 antes de confirmar. |
| `UPLOAD_VERIFICATION_MISMATCH` / `MULTIPART_SIZE_MISMATCH` | `400` | El tamaño o MIME real subido a S3 difiere de lo declarado en el ticket. | El objeto fue eliminado de S3. Pide un nuevo ticket declarando el `fileSize` exacto en bytes. |
| `MAGIC_BYTES_MISMATCH` | `422` | Los primeros 32 bytes del archivo en S3 no corresponden al formato binario real del MIME declarado. | El objeto fue eliminado de S3. Sube un archivo real (no renombrado) que coincida con su MIME. |
| `CHECKSUM_MISMATCH` | `400` | El SHA-256 en S3 no coincide con el `sha256Hash` declarado. | Calcula el SHA-256 sobre el buffer exacto que vas a enviar a S3. |
| `TICKET_EXPIRED` | `410` | El ticket de subida simple superó su ventana de vida (5 min + 2 min de gracia). | Solicita un nuevo ticket con `POST /api/upload`. |
| `TICKET_ALREADY_COMPLETED` | `409` | El ticket ya había sido confirmado previamente. | No necesitas repetir la confirmación; consulta el archivo con su `fileId`. |
| `FORBIDDEN_PRIVATE_USER_REQUIRED` / `FORBIDDEN_PRIVATE_NOT_OWNER` | `403` | Intentaste leer un archivo `private` sin `x-user-id` o con un usuario que no es el dueño. | Envía en `x-user-id` el UUID del usuario propietario que subió el archivo. |
| `PENDING_TICKETS_QUOTA_EXCEEDED` | `429` | Tu organización alcanzó el límite de tickets sin confirmar (`max_pending_tickets`). | Confirma tus tickets en curso, abórtalos o espera 5 minutos a que venzan. |
| `STORAGE_QUOTA_EXCEEDED` | `413` | Tu organización alcanzó el límite de almacenamiento (`max_storage_bytes`). | Elimina archivos que ya no necesites (`DELETE /api/files/{id}`) o solicita más cuota. |
| `MAX_API_KEYS_LIMIT_REACHED` | `409` | Ya tienes el máximo de API Keys activas (`max_api_keys`, por defecto 3). | Elimina o revoca una llave secundaria con `DELETE /api/keys?id=<uuid>` antes de crear otra. |
| `RATE_LIMIT_EXCEEDED` / `KEYS_RATE_LIMIT_EXCEEDED` | `429` | Superaste las 100 req/min (operativas) o 20 req/min (`/api/keys`, `/api/organizations`). | Lee la cabecera `Retry-After` (en segundos) y aplica *backoff* antes de reintentar. |
| `SSRF_PROTOCOL_NOT_HTTPS` / `SSRF_BLOCKED_IP` / `SSRF_BLOCKED_HOST` | `400` | La `webhookUrl` no usa `https://` o apunta a una IP privada/localhost. | Usa un dominio público con certificado TLS válido en `https://`. |

---

## 8. Límites y Cuotas del Servicio

| Categoría | Parámetro / Límite | Valor |
| :--- | :--- | :--- |
| **Rate Limit Operativo** | Rutas `/api/upload`, `/api/upload/multipart`, `/api/files/*` | **100 peticiones / 60 s** por API Key |
| **Rate Limit Administrativo** | Rutas `/api/keys` y `/api/organizations` | **20 peticiones / 60 s** por API Key / IP |
| **Cabeceras de Rate Limit** | Devueltas en cada respuesta autenticada | `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, `Retry-After` |
| **Cuota de Almacenamiento** | `max_storage_bytes` por organización (valor por defecto) | **1 GB** (`1,073,741,824` bytes) — configurable por organización |
| **Cuota de Tickets Pendientes** | `max_pending_tickets` simultáneos en `pending_upload` | **20 tickets** por defecto |
| **Cuota de API Keys Activas** | `max_api_keys` con `is_active = true` por organización | **3 llaves activas** por defecto |
| **Tamaño Subida Simple** | `POST /api/upload` | Máximo **25 MB** (`26,214,400` bytes) |
| **Tamaño Subida Multipart** | `/api/upload/multipart` | Máximo **500 MB** (`524,288,000` bytes) · Mínimo **5 MB** por parte (excepto la última) · Hasta `10,000` partes |
| **Tipos Permitidos (Whitelist)** | Extensiones y MIME types aceptados | `.jpg` (`image/jpeg`), `.jpeg` (`image/jpeg`), `.png` (`image/png`), `.webp` (`image/webp`), `.gif` (`image/gif`), `.pdf` (`application/pdf`, fuerza `Content-Disposition: attachment`) |
| **TTL Subida Simple** | Vigencia de `uploadUrl` PUT en S3 | **5 minutos (`300` s)** (+ 2 min de gracia para confirmar el ticket) |
| **TTL Subida Multipart** | Vigencia de sesión multipart / URL por parte | Sesión y `confirmToken`: **60 minutos (`3600` s)** · URL de cada parte (`presign_part`): **15 minutos (`900` s)** |
| **TTL Lectura Privada** | Vigencia de URL prefirmada GET en `GET /api/files/{id}` | **5 minutos (`300` s)** |

---

## 9. Limitaciones Conocidas

> [!IMPORTANT]
> **Limitaciones Operativas Actuales (Leer antes de diseñar tu integración):**
>
> - **(a) La subida directa desde navegador (Frontend) no funciona actualmente:** Debido a que la política CORS del bucket S3 compartido no es configurable con nuestros permisos actuales de AWS, las peticiones `PUT` enviadas desde un navegador web serán bloqueadas por CORS. **Toda subida hacia `uploadUrl` / `uploadPartUrl` debe ejecutarse desde tu propio servidor (backend).**
> - **(b) No hay escaneo antivirus (`scan_status = "not_scanned"`):** El servicio valida estrictamente la extensión, el tamaño, el checksum criptográfico SHA-256 y los primeros 32 bytes (*Magic Bytes*) del binario en S3, pero no ejecuta análisis de firmas de malware. Todos los archivos mantienen `scan_status: "not_scanned"`.
> - **(c) Los metadatos EXIF no se limpian:** Mientras la etapa de procesamiento asíncrono permanezca apagada (para cumplir la regla de que ningún archivo binario pase por Vercel), las imágenes subidas conservan intactos sus metadatos EXIF originales (como orientación o geolocalización GPS). Si necesitas eliminar EXIF por privacidad, hazlo en tu backend antes de subir la imagen a S3.
> - **(d) Las transformaciones dinámicas de imagen son una etapa futura:** El endpoint `/api/img/{id}` se encuentra deshabilitado en producción y responde con `503 Service Unavailable` (`IMAGE_TRANSFORM_DISABLED_IN_PRODUCTION`).
