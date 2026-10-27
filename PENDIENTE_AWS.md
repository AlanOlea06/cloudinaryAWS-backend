# PENDIENTE_AWS.md: Requerimientos de Infraestructura AWS, Deuda Técnica y Limitaciones

> **Versión:** 1.0.0 (Fase Subida y Entrega - Sección 5)  
> **Alcance:** Proyecto Cloudinary Clone (Backend Next.js en Vercel)  
> **Cuenta AWS:** `418272802078` | **Región:** `us-east-1`  
> **Bucket S3 Actual:** `practicas-alan-418272802078`  
> **Distribución CloudFront Actual:** `ECM92CKF7EZPC` (Dominio: `d1nuawu3owad6c.cloudfront.net`)  
> **Regla de Arquitectura Fundamental:** *Ningún archivo binario pasa por Vercel*. Los bytes viajan exclusivamente entre Cliente y AWS S3 / CloudFront. El backend solo procesa y valida permisos (tickets, firmas, Range GET de 32 bytes y checksums).

---

## ÍNDICE
1. [SECCIÓN A: Requerimientos y Texto del Pedido al Administrador de AWS](#sección-a-requerimientos-y-texto-del-pedido-al-administrador-de-aws)
   - [Prioridad 1: CloudFront (Key Group, Comportamiento Privado, OAC, Políticas)](#prioridad-1-cloudfront)
   - [Prioridad 2: S3 (CORS, Ciclo de Vida, Block Public Access, ListBucket)](#prioridad-2-s3)
   - [Plan B: Bucket S3 Dedicado (Alternativa para Bucket Compartido)](#plan-b-bucket-s3-dedicado)
2. [SECCIÓN B: Inventario de Código [TEST-ONLY] y [TEMPORARY]](#sección-b-inventario-de-código-test-only-y-temporary)
3. [SECCIÓN C: Limitaciones Conocidas de Seguridad y Privacidad en Fase Interina](#sección-c-limitaciones-conocidas-de-seguridad-y-privacidad-en-fase-interina)

---

## SECCIÓN A: Requerimientos y Texto del Pedido al Administrador de AWS

### Prioridad 1: CloudFront

#### 1.1 Registro de Clave Pública y Creación de Key Group
* **Problema Actual:** La entrega de archivos privados se realiza mediante URLs prefirmadas de S3 generadas por el backend con 5 minutos de TTL. Esto expone el endpoint directo de S3 y no aprovecha la caché perimetral ni la validación de firmas en el Edge de CloudFront.
* **Solución Más Simple:**
  - El administrador crea el Key Group en CloudFront y registra la clave pública PEM provista por el equipo de desarrollo.
  - *Alternativa de permisos:* Si el administrador prefiere delegar la gestión, otorgar a la identidad IAM del proyecto (`arn:aws:iam::418272802078:user/alan-api-user` o similar):
    - `cloudfront:CreatePublicKey`
    - `cloudfront:UpdatePublicKey`
    - `cloudfront:CreateKeyGroup`
    - `cloudfront:UpdateKeyGroup`
    - `cloudfront:GetKeyGroup`

#### 1.2 Comportamiento Aislado para Archivos Privados (`/static/private/*` o `/private/*`)
* **Configuración Requerida:**
  - **Path Pattern:** `/static/private/*` (o `/private/*` según prefijo S3 convenido).
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
* **Justificación:** Permitir que la API purgue el caché perimetral cuando un archivo público sea eliminado o actualizado sin esperar el TTL de 300 segundos.

---

### Prioridad 2: S3

#### 2.1 Configuración de CORS en el Bucket (`s3:PutBucketCors`)
* **Problema Actual:** Las subidas directas desde navegadores de clientes hacia las URLs prefirmadas de S3 fallan si el origen web no está autorizado por la política CORS del bucket.
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
* **Regla 2 (Limpieza de zona de aterrizaje temporal):**
  - **Nombre:** `ExpirePendingUploads`
  - **Prefijo:** `static/pending/`
  - **Acción:** Expirar/eliminar objetos tras **1 día**.

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
  - Las subidas multipart (`UploadPartCommand`, `ListPartsCommand`, `CompleteMultipartUploadCommand`, `AbortMultipartUploadCommand`) tampoco requieren `ListBucket`; operan sobre la clave exacta y el `UploadId`.
  - El backend almacena todas las claves (`s3_pending_key`, `s3_processed_key`) en Supabase PostgreSQL. Las operaciones de eliminación y mantenimiento se ejecutan por clave explícita (`DeleteObjectCommand`).
  - *Conclusión:* Si el administrador deniega `s3:ListBucket` por ser un bucket compartido, el servicio funcionará al 100% en producción. Solo los scripts de diagnóstico o cleanup global sin BD requieren `ListBucket`.

---

### Plan B: Bucket S3 Dedicado

Si el administrador no puede aplicar la política CORS, reglas de ciclo de vida ni OAC porque `practicas-alan-418272802078` es compartido con otros alumnos/proyectos:

1. **Creación de Bucket Exclusivo:** `cloudinary-prod-418272802078` (o `alano-cloudinary-storage`).
2. **Política Mínima del Bucket:**
   - Todo el acceso bloqueado (`BlockPublicAccess` total).
   - Política de bucket permitiendo acceso exclusivamente a:
     - IAM User del proyecto (`arn:aws:iam::418272802078:user/alan-api-user`).
     - CloudFront OAC (`Service: cloudfront.amazonaws.com` condicionado a `SourceArn: arn:aws:cloudfront::418272802078:distribution/ECM92CKF7EZPC`).
3. **Plan de Migración Transparente:**
   - La variable `AWS_S3_BUCKET_NAME` en Vercel se actualiza al nuevo nombre de bucket.
   - No se tocan archivos históricos del bucket compartido; los nuevos archivos entran directo al bucket dedicado.
   - Cero tiempo de inactividad y aislamiento de seguridad total.

---

### Texto del Mensaje Listo para Enviar al Administrador

```text
Estimado Administrador de AWS,

Para la finalización y puesta en producción del proyecto de gestión de almacenamiento (Cloudinary Clone), solicito amablemente su apoyo con las siguientes configuraciones en la cuenta 418272802078:

1. CloudFront (Distribución ECM92CKF7EZPC):
   a) Crear un Key Group llamado "cloudinary-trusted-keygroup" y asociar la clave pública PEM que adjunto (o bien otorgar permisos cloudfront:CreatePublicKey y CreateKeyGroup a mi usuario IAM).
   b) Crear un comportamiento (behavior) para el patrón "/static/private/*" con:
      - Viewer Access restringido al Key Group anterior.
      - Origen hacia el bucket S3 mediante Origin Access Control (OAC).
      - Política de caché "Managed-UseOriginCacheControlHeaders".
   c) Aplicar una Response Headers Policy que añada X-Content-Type-Options: nosniff, X-Frame-Options: DENY y Content-Security-Policy: sandbox a los comportamientos de entrega de archivos.
   d) Otorgar el permiso cloudfront:CreateInvalidation sobre la distribución arn:aws:cloudfront::418272802078:distribution/ECM92CKF7EZPC.

2. S3 (Bucket practicas-alan-418272802078):
   a) Aplicar la siguiente regla CORS para permitir subidas directas desde el navegador:
      [{"AllowedHeaders":["*"],"AllowedMethods":["PUT","POST","GET","HEAD"],"AllowedOrigins":["https://cloudinary-aws-backend.vercel.app","http://localhost:3000"],"ExposeHeaders":["ETag","x-amz-checksum-sha256"],"MaxAgeSeconds":3600}]
   b) Configurar una regla de ciclo de vida para abortar subidas multipart incompletas tras 1 día y expirar static/pending/ tras 1 día.
   c) Confirmar que las 4 opciones de Block Public Access continúan activas en el bucket.
   (Nota: No es necesario habilitar s3:ListBucket; nuestro servicio opera 100% por clave directa).

*PLAN B ALTERNATIVO:* Si las reglas de CORS o ciclo de vida interfieren con otros proyectos en este bucket compartido, agradecería la creación de un bucket exclusivo (ej. "cloudinary-prod-418272802078") donde podamos aplicar estas configuraciones sin afectar a nadie más.

Quedo a su disposición para cualquier duda. Muchas gracias por su apoyo.
```

---

## SECCIÓN B: Inventario de Código [TEST-ONLY] y [TEMPORARY]

| Etiqueta | Archivo | Función / Bloque | Propósito Actual | Instrucciones de Retiro / Migración cuando exista AWS Lambda |
|---|---|---|---|---|
| `[TEST-ONLY: TASK-B6-PROCESS-UPLOAD]` | `servicio/lib/lambda-fallback/process-upload.ts` | `processUpload(fileId, options)` y constante `ENABLE_SERVER_PROCESSING_FALLBACK` | Permite pruebas locales de procesamiento de imágenes con Sharp (limpieza de EXIF y validación). Desactivado por defecto (`false`) en producción. | 1. Trasladar el código de este handler a la función AWS Lambda disparada por S3 Event Notifications.<br>2. Eliminar la carpeta `lib/lambda-fallback/` del repo.<br>3. Retirar la variable `ENABLE_SERVER_PROCESSING_FALLBACK`. |
| `[TEST-ONLY: WEBHOOK-DISPATCHER]` | `servicio/lib/lambda-fallback/webhook-dispatcher.ts` | `dispatchFileWebhook(options)` | Envío de notificaciones webhook firmadas con HMAC-SHA256 desde Vercel en pruebas manuales. | Mover la lógica de emisión de webhooks al final del pipeline de la función AWS Lambda. |
| `[TEST-ONLY: TRIGGER-CONFIRM]` | `servicio/app/api/upload/route.ts` | Bloque `if (ENABLE_SERVER_PROCESSING_FALLBACK)` en `PUT /api/upload` | Disparador de pruebas para invocar `processUpload` tras la confirmación si la bandera de entorno está activa. | Eliminar el bloque condicional una vez que S3 dispare la Lambda de forma asíncrona. |
| `[TEST-ONLY: MULTIPART-TRIGGER]` | `servicio/app/api/upload/multipart/route.ts` | Bloque `if (ENABLE_SERVER_PROCESSING_FALLBACK)` en `handleCompleteMultipart` | Disparador de pruebas tras el ensamblaje multipart. | Eliminar el bloque condicional. |
| `[TEST-ONLY: STATUS-ENDPOINT-TRIGGER]` | `servicio/app/api/files/[id]/status/route.ts` | `POST /api/files/[id]/status` | Permite reprocesamiento manual y disparo de webhooks en desarrollo. | Desactivar o restringir exclusivamente al rol admin de monitoreo. |
| `[TEMPORARY: S3-PRESIGNED-PRIVATE-DELIVERY]` | `servicio/app/api/files/[id]/route.ts` | `GET /api/files/[id]` (rama privada) | Genera URL prefirmada de S3 con 5 min de TTL (`ResponseCacheControl: no-store`) para entrega de archivos privados. | Reemplazar por la generación de CloudFront Signed URLs firmadas con la clave privada RSA del Key Group (`getSignedUrl` de `@aws-sdk/cloudfront-signer`). |

---

## SECCIÓN C: Limitaciones Conocidas de Seguridad y Privacidad en Fase Interina

Al haber adoptado estrictamente la regla arquitectónica **"Ningún archivo binario pasa por Vercel"** y al no contar aún con AWS Lambda desplegado en la cuenta de AWS:

1. **Persistencia de Metadata EXIF en Imágenes:**
   - *Estado:* Las imágenes subidas por los usuarios conservan su metadata EXIF intacta (incluyendo posibles coordenadas GPS, modelo de cámara y fecha de captura).
   - *Causa:* Vercel no descarga ni procesa los bytes de las imágenes para evitar costos de ancho de banda y latencia de cómputo serverless.
   - *Mitigación final:* La función AWS Lambda se encargará de ejecutar `sharp(buffer).rotate().toBuffer()` en la nube de AWS antes de publicar el asset definitivo.

2. **Escaneo de Antivirus y Malware Profundo:**
   - *Estado:* Todos los archivos confirmados mantienen `scan_status = 'not_scanned'`.
   - *Validación actual:* El backend valida exitosamente el formato binario real inspeccionando los primeros 32 bytes (`magic bytes`) vía HTTP Range GET y el hash SHA-256 en subidas simples. Sin embargo, no se realiza análisis heurístico o de firmas de virus.
   - *Mitigación final:* Integración de AWS GuardDuty for S3 o contenedor ClamAV en Lambda/Fargate.

3. **Exposición Residual de Clave S3 en Archivos Privados:**
   - *Estado:* La URL prefirmada de S3 generada para archivos privados incluye en la query string el bucket y la clave S3 (`static/files/<rand128>.<ext>`).
   - *Riesgo:* Si un usuario malintencionado copia esa clave y la solicita directamente al dominio de CloudFront (`https://d1nuawu3owad6c.cloudfront.net/static/files/<rand128>.<ext>`), CloudFront podría responder con el objeto si el archivo no está protegido en el Edge.
   - *Mitigación actual:* El backend firma `Cache-Control: private, no-store, no-cache, max-age=0, must-revalidate` en el objeto y en la respuesta HTTP, y las claves S3 son de alta entropía (128 bits aleatorios, imposibles de adivinar).
   - *Mitigación definitiva:* Se resolverá al 100% cuando el administrador de AWS configure el comportamiento `/static/private/*` con Trusted Key Group y OAC.
