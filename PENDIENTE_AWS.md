# PENDIENTE_AWS.md: Requerimientos de Infraestructura AWS, Deuda Técnica y Limitaciones

> **Versión:** 2.0.0  
> **Fecha:** 27 de Octubre de 2026  
> **Alcance:** Proyecto Cloudinary Clone (Backend Next.js en Vercel)  
> **Cuenta AWS:** `418272802078` | **Región:** `us-east-1`  
> **Bucket S3 Actual:** `practicas-alan-418272802078`  
> **Distribución CloudFront Actual:** `ECM92CKF7EZPC` (Dominio: `d1nuawu3owad6c.cloudfront.net`)  
> **Regla de Arquitectura Fundamental:** *Ningún archivo binario pasa por Vercel*. Los bytes viajan exclusivamente entre Cliente y AWS S3 / CloudFront. El backend solo procesa y valida permisos (tickets, firmas, Range GET de 32 bytes y checksums). Este documento es de **referencia técnica**: nada en el código operativo ni en el plan de pruebas depende de que AWS realice estos cambios ahora.

---

## ÍNDICE
1. [SECCIÓN A: Requerimientos y Texto del Pedido al Administrador de AWS](#sección-a-requerimientos-y-texto-del-pedido-al-administrador-de-aws)
   - [Prioridad 1: CloudFront (Key Group, Comportamiento Privado, OAC, Políticas)](#prioridad-1-cloudfront)
   - [Prioridad 2: S3 (CORS, Regla de Multipart, Block Public Access, ListBucket)](#prioridad-2-s3)
   - [Plan B: Bucket S3 Dedicado (Alternativa para Bucket Compartido)](#plan-b-bucket-s3-dedicado)
2. [SECCIÓN B: Inventario de Código [TEMPORARY-LAMBDA-FALLBACK] y [TEST-ONLY]](#sección-b-inventario-de-código-temporary-lambda-fallback-y-test-only)
3. [SECCIÓN C: Limitaciones Conocidas de Seguridad y Privacidad en Fase Interina](#sección-c-limitaciones-conocidas-de-seguridad-y-privacidad-en-fase-interina)

---

## SECCIÓN A: Requerimientos y Texto del Pedido al Administrador de AWS

### Prioridad 1: CloudFront

#### 1.1 Registro de Clave Pública y Creación de Key Group
* **Problema Actual:** La entrega de archivos privados se realiza mediante URLs prefirmadas de S3 generadas por el backend con 5 minutos de TTL. Esto expone el endpoint directo de S3 y no aprovecha la caché perimetral ni la validación de firmas en el Edge de CloudFront.
* **Solución Más Simple:**
  - El administrador crea el Key Group en CloudFront y registra la clave pública PEM provista por el equipo de desarrollo.
  - *Alternativa de permisos IAM delegados:*
    - `cloudfront:CreatePublicKey`
    - `cloudfront:UpdatePublicKey`
    - `cloudfront:CreateKeyGroup`
    - `cloudfront:UpdateKeyGroup`
    - `cloudfront:GetKeyGroup`

#### 1.2 Comportamiento Aislado para Archivos Privados (`/static/private/*`)
* **Configuración Requerida:**
  - **Path Pattern:** `/static/private/*`
  - **Viewer Access:** *Restrict Viewer Access = Yes* (Trusted Key Groups: seleccionar el Key Group creado en el punto 1.1).
  - **Origin:** S3 Bucket `practicas-alan-418272802078` con **Origin Access Control (OAC)** habilitado.
  - **Allowed HTTP Methods:** `GET, HEAD, OPTIONS`.
  - **Cache Policy:** Política administrada `Managed-UseOriginCacheControlHeaders` (ID: `83da9c43-98f4-4e18-9e68-1888706240b6`) con TTL mínimo = 0 para respetar `Cache-Control: private, no-store`.

#### 1.3 Política de Cabeceras de Respuesta de Seguridad (Response Headers Policy)
* **Asociar a todos los comportamientos de entrega de archivos (`/static/*`):**
  - `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`
  - `X-Content-Type-Options: nosniff`
  - `X-Frame-Options: DENY`
  - `Content-Security-Policy: default-src 'none'; sandbox; base-uri 'none'; form-action 'none';`

#### 1.4 Permiso de Invalidación en CloudFront
* **Permiso IAM requerido:** `cloudfront:CreateInvalidation`
* **Recurso exacto:** `arn:aws:cloudfront::418272802078:distribution/ECM92CKF7EZPC`
* **Justificación:** Permitir que la API purgue el caché perimetral cuando un archivo público sea eliminado o actualizado sin esperar el TTL de 300 segundos, garantizando el derecho de supresión de datos.

---

### Prioridad 2: S3

#### 2.1 Configuración de CORS en el Bucket (`s3:PutBucketCors`)
* **Problema Actual:** Las subidas directas desde navegadores hacia URLs prefirmadas de S3 fallan si el origen web no está autorizado por la política CORS del bucket.
* **JSON de Configuración CORS listo para aplicar:**
```json
[
  {
    "AllowedHeaders": [
      "Content-Type",
      "Cache-Control",
      "Content-Disposition",
      "x-amz-checksum-sha256",
      "x-amz-meta-*"
    ],
    "AllowedMethods": [
      "PUT",
      "POST",
      "GET",
      "HEAD"
    ],
    "AllowedOrigins": [
      "https://cloudinary-aws-backend.vercel.app",
      "http://localhost:3000"
    ],
    "ExposeHeaders": [
      "ETag",
      "x-amz-checksum-sha256"
    ],
    "MaxAgeSeconds": 3600
  }
]
```

#### 2.2 Reglas de Ciclo de Vida (S3 Lifecycle Rules)
* **Regla 1 (Abortar Multipart Incompletos):**
  - **Nombre:** `AbortIncompleteMultipartUploads`
  - **Prefijo:** Todo el bucket o `static/`
  - **Acción:** Abortar subidas multipart no finalizadas tras **1 día** (o máximo 7 días) para evitar acumulación de costos por partes huérfanas en S3.
* **Regla 2 (Expiración de zona pending/):**
  - **ESTADO: OBSOLETA Y REEMPLAZADA.**
  - *Justificación:* Al haberse eliminado la zona transitoria `static/pending/` y subir directamente a las rutas finales (`static/files/` para públicos y `static/private/` para privados), ya no se aplica una regla de expiración sobre `pending/`. La limpieza de tickets huérfanos sin confirmar se gestiona a nivel de aplicación mediante el Cron de Mantenimiento y la limpieza oportunista.

#### 2.3 Confirmación de S3 Block Public Access
* **Auditoría Requerida:** Confirmar que los 4 parámetros de Block Public Access estén activados (`true`):
  1. `BlockPublicAcls: true`
  2. `IgnorePublicAcls: true`
  3. `BlockPublicPolicy: true`
  4. `RestrictPublicBuckets: true`
* **Impacto:** Ningún objeto en S3 debe tener ACL pública directa; todo el tráfico público debe fluir a través de CloudFront OAC.

#### 2.4 Justificación de `s3:ListBucket`
* **¿Es estrictamente necesario en producción?** **NO.**
* **Justificación técnica:**
  - Las subidas simples (`PutObjectCommand`, `HeadObjectCommand`, `DeleteObjectCommand`) no requieren `ListBucket`.
  - Las subidas multipart (`UploadPartCommand`, `ListPartsCommand`, `CompleteMultipartUploadCommand`, `AbortMultipartUploadCommand`) operan sobre la clave exacta y el `UploadId`.
  - El backend almacena todas las claves en Supabase PostgreSQL. Las operaciones de eliminación y mantenimiento se ejecutan por clave explícita (`DeleteObjectCommand`).
  - Si el administrador deniega `s3:ListBucket` por ser un bucket compartido, el servicio funcionará al 100% en producción.

---

### Plan B: Bucket S3 Dedicado

Si el administrador no puede aplicar la política CORS, reglas de ciclo de vida ni OAC porque `practicas-alan-418272802078` es compartido:

1. **Creación de Bucket Exclusivo:** `cloudinary-prod-418272802078` (o `alano-cloudinary-storage`).
2. **Política Mínima del Bucket:**
   - Todo el acceso bloqueado (`BlockPublicAccess` total).
   - Acceso exclusivo al IAM User del proyecto y a CloudFront OAC.
3. **Plan de Migración:**
   - Actualizar `AWS_S3_BUCKET_NAME` en Vercel. Cero tiempo de inactividad.

---

### Texto del Mensaje Listo para Enviar al Administrador

```text
Estimado Administrador de AWS,

Para la finalización y puesta en producción del proyecto de almacenamiento (Cloudinary Clone), solicito amablemente su apoyo con las siguientes configuraciones en la cuenta 418272802078:

1. CloudFront (Distribución ECM92CKF7EZPC):
   a) Crear un Key Group llamado "cloudinary-trusted-keygroup" y asociar la clave pública PEM que adjunto (o bien otorgar permisos cloudfront:CreatePublicKey y CreateKeyGroup a mi usuario IAM).
   b) Crear un comportamiento (behavior) para el patrón "/static/private/*" con:
      - Viewer Access restringido al Key Group anterior.
      - Origen hacia el bucket S3 mediante Origin Access Control (OAC).
      - Política de caché administrada "Managed-UseOriginCacheControlHeaders".
   c) Aplicar Response Headers Policy con HSTS, X-Content-Type-Options: nosniff, X-Frame-Options: DENY y CSP sandbox a /static/*.
   d) Otorgar el permiso cloudfront:CreateInvalidation sobre la distribución arn:aws:cloudfront::418272802078:distribution/ECM92CKF7EZPC.

2. S3 (Bucket practicas-alan-418272802078):
   a) Aplicar la regla CORS con AllowedHeaders: ["Content-Type", "Cache-Control", "Content-Disposition", "x-amz-checksum-sha256", "x-amz-meta-*"], ExposeHeaders: ["ETag", "x-amz-checksum-sha256"], AllowedMethods: ["PUT", "POST", "GET", "HEAD"], AllowedOrigins: ["https://cloudinary-aws-backend.vercel.app", "http://localhost:3000"].
   b) Configurar una regla de ciclo de vida para abortar subidas multipart incompletas (AbortIncompleteMultipartUploads) tras 1 día (o máximo 7 días).
   c) Confirmar que las 4 opciones de Block Public Access continúan activas en el bucket.
   (Nota: No es necesario habilitar s3:ListBucket; nuestro servicio opera 100% por clave directa).

*PLAN B ALTERNATIVO:* Si las reglas de CORS o ciclo de vida interfieren con otros proyectos en este bucket compartido, agradecería la creación de un bucket exclusivo (ej. "cloudinary-prod-418272802078") donde podamos aplicar estas configuraciones sin afectar a nadie más.

Quedo a su disposición. Muchas gracias por su apoyo.
```

---

## SECCIÓN B: Inventario de Código [TEMPORARY-LAMBDA-FALLBACK] y [TEST-ONLY]

| Etiqueta | Archivo | Función / Bloque | Función de AWS que sustituye | Estado | Instrucciones de Retiro |
|---|---|---|---|:---:|---|
| `[TEMPORARY-LAMBDA-FALLBACK: RANGE-GET-32B]` | `servicio/lib/s3.ts` y `servicio/lib/magic-bytes.ts` | `getS3ObjectRangeBytes()` y `detectMagicBytesMime()` | AWS Lambda (EventBridge / S3 Notification al crearse el objeto) | **Activo** | Retirar la inspección por Range GET en la API cuando la Lambda ejecute la inspección y etiquetado de Magic Bytes de forma asíncrona. |
| `[TEMPORARY-LAMBDA-FALLBACK: OPPORTUNISTIC-TICKET-CLEANUP]` | `servicio/app/api/upload/route.ts` | Bloque en `POST /api/upload` | Regla de ciclo de vida de S3 y trigger de expiración en AWS | **Activo** | Retirar cuando el ciclo de vida de S3 y DynamoDB/TTL o Lambda limpien automáticamente los tickets huérfanos. |
| `[TEMPORARY-LAMBDA-FALLBACK: CRON-MULTIPART-ABORT]` | `servicio/app/api/cron/maintenance/route.ts` | Bloque 2 en `runMaintenanceCron` | Regla de ciclo de vida S3 `AbortIncompleteMultipartUpload` | **Activo** | Eliminar el bloque cuando el administrador de AWS active la regla de ciclo de vida nativa en el bucket S3. |
| `[TEMPORARY-LAMBDA-FALLBACK: WEBHOOK-DISPATCHER]` | `servicio/lib/lambda-fallback/webhook-dispatcher.ts` | `dispatchFileWebhook()` con protección SSRF y reintentos | AWS EventBridge / SQS / Lambda de notificación | **Activo** | Mover la llamada HTTP de webhooks hacia una cola SQS consumida por una Lambda en AWS. |
| `[TEMPORARY-LAMBDA-FALLBACK: WEBHOOK-CIRCUIT-BREAKER]` | `servicio/lib/lambda-fallback/webhook-dispatcher.ts` | `dispatchFileWebhook()` circuit breaker tras 3 fallos | Manejo de fallos en colas SQS / Dead Letter Queue (DLQ) en AWS | **Activo** | Retirar cuando el despacho de webhooks sea 100% asíncrono vía SQS + Lambda sin impacto en la API. |
| `[TEMPORARY: S3-PRESIGNED-PRIVATE-DELIVERY]` | `servicio/app/api/files/[id]/route.ts` | `GET /api/files/[id]` (rama privada) | CloudFront Signed URLs con Trusted Key Group en el Edge | **Activo** | Reemplazar `generatePresignedReadUrl()` de S3 por `getSignedUrl()` de `@aws-sdk/cloudfront-signer` apuntando a `/static/private/*`. |
| `[TEST-ONLY: TASK-B6-PROCESS-UPLOAD]` | `servicio/lib/lambda-fallback/process-upload.ts` | `processUpload()` y `ENABLE_SERVER_PROCESSING_FALLBACK` | Pipeline de transformación de imágenes en AWS Lambda con Sharp | **Apagado** (`false`) | Mover el código a la función AWS Lambda y eliminar la carpeta `lib/lambda-fallback/`. |
| `[TEST-ONLY: TRIGGER-CONFIRM]` | `servicio/app/api/upload/route.ts` | Bloque `if (ENABLE_SERVER_PROCESSING_FALLBACK)` en `PUT /api/upload` | Disparador automático de Lambda post-subida | **Apagado** (`false`) | Retirar el bloque condicional. |
| `[TEST-ONLY: MULTIPART-TRIGGER]` | `servicio/app/api/upload/multipart/route.ts` | Bloque `if (ENABLE_SERVER_PROCESSING_FALLBACK)` en `handleCompleteMultipart` | Disparador automático de Lambda post-ensamblaje | **Apagado** (`false`) | Retirar el bloque condicional. |
| `[TEST-ONLY: STATUS-ENDPOINT-TRIGGER]` | `servicio/app/api/files/[id]/status/route.ts` | `POST /api/files/[id]/status` | Re-procesamiento asíncrono manual vía Lambda | **Apagado** (`false`) | Desactivar o restringir exclusivamente al rol admin de monitoreo. |

---

## SECCIÓN C: Limitaciones Conocidas de Seguridad y Privacidad en Fase Interina

Al haber adoptado estrictamente la regla arquitectónica **"Ningún archivo binario pasa por Vercel"** y al no contar aún con AWS Lambda ni permisos de administración en CloudFront/S3:

1. **Persistencia de Metadata EXIF en Imágenes:**
   - *Estado:* Las imágenes subidas conservan su metadata EXIF intacta (incluyendo posibles coordenadas GPS y fecha de captura).
   - *Causa:* Vercel no descarga ni procesa los bytes de las imágenes para evitar costos de cómputo serverless y cumplir la regla de cero archivos por Vercel.
   - *Mitigación final:* La función AWS Lambda se encargará de ejecutar `sharp(buffer).rotate().toBuffer()` en la nube de AWS.

2. **Escaneo de Antivirus y Malware Profundo:**
   - *Estado:* Todos los archivos confirmados mantienen `scan_status = 'not_scanned'`.
   - *Validación actual:* El backend valida exitosamente el formato binario real inspeccionando los primeros 32 bytes (`magic bytes`) vía HTTP Range GET y el checksum SHA-256 de S3. Sin embargo, no se realiza análisis heurístico o de firmas de virus.
   - *Mitigación final:* Integración de AWS GuardDuty for S3 o contenedor ClamAV en Lambda/Fargate.

3. **Exposición Residual de Clave S3 en Archivos Privados:**
   - *Estado:* La URL prefirmada de S3 generada para archivos privados incluye en la query string el bucket y la clave S3 (`static/private/<rand128>.<ext>`).
   - *Riesgo:* Si un usuario malintencionado copia esa clave y la solicita directamente al dominio de CloudFront (`https://d1nuawu3owad6c.cloudfront.net/static/private/<rand128>.<ext>`), CloudFront podría responder con el objeto si el comportamiento `/static/private/*` aún no tiene el Key Group asignado.
   - *Mitigación actual:* El backend firma `Cache-Control: private, no-store, no-cache, max-age=0, must-revalidate` en el objeto y en la respuesta HTTP, y las claves S3 son de alta entropía (128 bits aleatorios, imposibles de adivinar).
   - *Mitigación definitiva:* Se resolverá al 100% cuando el administrador de AWS configure el comportamiento `/static/private/*` con Trusted Key Group y OAC.

4. **Objetos sin Confirmar Viven hasta el Siguiente Ciclo:**
   - *Estado:* Si un cliente solicita un ticket prefirmado y sube bytes a S3 pero abandona el flujo antes de llamar a `PUT /api/upload`, el objeto huérfano permanece en S3.
   - *Mitigación actual:* La limpieza oportunista elimina hasta 3 tickets vencidos en cada emisión de ticket de la misma organización, y el cron de mantenimiento diario actúa como respaldo global.

5. **Invalidez de Caché en Eliminación de Archivos Públicos (Derecho de Supresión / Borrado):**
   - *Estado:* Sin el permiso `cloudfront:CreateInvalidation`, cuando se elimina un archivo público (`DELETE /api/files/[id]`), el objeto se borra inmediatamente de S3, pero la copia en caché en los puntos perimetrales (Edge PoPs) de CloudFront sigue viva hasta que expire el TTL (hasta 300 segundos).
   - *Impacto:* Durante ese lapso residual, solicitudes HTTP con la URL directa de CloudFront aún podrían ser respondidas desde la caché del Edge. Afecta temporalmente el derecho de supresión inmediata.

6. **Integridad Criptográfica: ETags vs Checksum SHA-256:**
   - *Corrección técnica:* Los ETags en Amazon S3 **no prueban integridad de extremo a extremo contra el cliente**. En subidas multipart, el ETag es un hash compuesto de partes (`hash(part1_md5 + ...) - N`) que no coincide con el MD5 del archivo original; y en subidas simples, S3 solo calcula el MD5 de lo que recibió sin contrastarlo contra el cliente a menos que se use `Content-MD5` o un checksum explícito.
   - *Solución implementada:* Se utiliza la cabecera nativa de S3 `x-amz-checksum-sha256` y se valida mediante `HeadObject` en modo `ChecksumMode: 'ENABLED'`. Se registra en base de datos la columna `sha256_verified` para dar certeza matemática de la integridad del archivo.
