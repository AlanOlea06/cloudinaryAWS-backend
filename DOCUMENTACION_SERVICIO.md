# Documentación Técnica del Servidor (`servicio`) — Función por Función

Esta documentación explica la arquitectura interna del backend (`servicio`), detallando cada archivo, cada función, qué parámetros recibe, qué validaciones ejecuta y qué devuelve en cada etapa del proceso.

---

## 📁 Estructura General del Proyecto `servicio`

```text
servicio/
├── lib/
│   ├── supabase.ts          # Conexión cliente a PostgreSQL en Supabase
│   ├── s3.ts                # Cliente AWS S3, firma de URLs (Presigned URLs) y borrado por prefijo
│   └── service-logs.ts      # Registro, correlación y consulta de la bitácora (service_logs)
└── app/
    ├── layout.tsx           # Contenedor raíz HTML plano sin estilos decorativos
    ├── page.tsx             # Vista del servidor: Tabla plana de bitácora de eventos (service_logs)
    └── api/
        ├── upload/route.ts          # Flujo principal: Emisión de tickets (POST) y confirmación (PUT)
        ├── logs/route.ts            # Consulta (GET) y limpieza (DELETE) de logs
        ├── records/route.ts         # Consulta (GET) y limpieza (DELETE) de la tabla files
        └── test/cleanup/route.ts    # Limpieza integral de S3 + Supabase para proteger la capa gratuita (5 GB)
```

---

## 1. Módulo de Base de Datos: `lib/supabase.ts`

Este archivo inicializa la conexión administrativa entre el backend en Vercel y tu base de datos PostgreSQL en Supabase.

* **`supabaseUrl` y `supabaseServiceKey`:**
  Lee las variables de entorno `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY`. Usa la llave `service_role` (llave maestra de backend) para poder insertar y consultar en las tablas `files` y `service_logs` sin ser bloqueado por políticas RLS de cliente.
* **`supabase = createClient(...)`:**
  Crea y exporta la instancia única del cliente de Supabase con `persistSession: false` y `autoRefreshToken: false`, ya que en un servidor Serverless (Vercel) cada petición HTTP es independiente y no guarda sesiones de navegador en cookies.

---

## 2. Módulo de AWS S3: `lib/s3.ts`

Este archivo encapsula toda la comunicación con Amazon S3 utilizando el **AWS SDK v3**.

### 2.1. `isAwsConfigured(): boolean`
* **Qué hace:** Verifica que existan las 3 variables de entorno indispensables en el servidor: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` y `AWS_S3_BUCKET_NAME`.
* **Para qué sirve:** Permite saber si el servidor puede conectarse realmente a AWS S3 antes de intentar firmar una URL.

### 2.2. `getS3Client(): S3Client | null`
* **Qué hace:** Si `isAwsConfigured()` es verdadero, instancia y devuelve el objeto `S3Client` configurado con la región (`AWS_REGION`, por defecto `us-east-1`) y las credenciales IAM limpias (`.trim()` para evitar espacios accidentales al copiarlas en Vercel).
* **Retorno:** Devuelve la instancia `S3Client` lista para firmar o enviar comandos, o `null` si faltan credenciales.

### 2.3. `generatePresignedUploadUrl(key, contentType, expiresInSeconds): Promise<string | null>`
* **Parámetros:**
  * `key`: La ruta destino dentro del bucket de S3 (ej. `pending/a1111111.../Reporte.docx`).
  * `contentType`: El tipo MIME del archivo (ej. `image/png`, `text/html`, etc.).
  * `expiresInSeconds`: Tiempo de vida del enlace (por defecto `900` segundos = 15 minutos).
* **Qué pasa internamente:**
  1. Crea un comando `PutObjectCommand` indicando en qué `Bucket`, bajo qué ruta (`Key`) y con qué `ContentType` se subirá el archivo.
  2. Llama a `getSignedUrl(client, command, { expiresIn })`. Esta función **no sube el archivo todavía**, sino que firma criptográficamente una URL temporal con tu llave secreta de AWS (`X-Amz-Signature`).
* **Retorno:** Devuelve el link largo (`uploadUrl`) que se le entrega al cliente para que suba el archivo directamente a S3 mediante el método `PUT`.

### 2.4. `deleteS3ObjectsByPrefix(prefix): Promise<{ count: number; keys: string[] }>`
* **Parámetros:** `prefix` (ej. `pending/` o `pending/{userId}/`).
* **Qué pasa internamente:**
  1. Ejecuta `ListObjectsV2Command` para buscar todos los archivos en el bucket cuya ruta empiece con ese prefijo.
  2. Si encuentra archivos, arma un arreglo con sus llaves (`Key`) y ejecuta `DeleteObjectsCommand` para borrarlos en lote de AWS S3.
* **Para qué sirve:** Lo utiliza el endpoint de limpieza para liberar espacio en tu bucket y proteger el límite de 5 GB de la capa gratuita de AWS.

---

## 3. Módulo de Bitácora y Auditoría: `lib/service-logs.ts`

Gestiona el catálogo de organizaciones/usuarios y las funciones que guardan y leen los eventos en la tabla `service_logs` de Supabase.

### 3.1. Catálogos `ORGANIZATIONS` y `USERS`
* Contienen las organizaciones registradas (`organization_1` y `organization_2`) y los 15 usuarios de prueba con sus respectivos roles (`admin`, `editor`, `viewer`) y su bandera de permiso `canUpload` (`true` o `false`).

### 3.2. `addServiceLog(logInput): Promise<ServiceLog>`
* **Qué hace:** Registra un nuevo evento en la bitácora del servidor cada vez que ocurre una acción (emisión de ticket, rechazo por seguridad 401/403, confirmación de subida a S3 o limpieza).
* **Proceso paso a paso:**
  1. Extrae la acción (`action`), el estado (`status`), el método HTTP real (`method`), el usuario, la organización y la extensión del archivo (`extension`).
  2. Inserta el registro en la tabla `service_logs` de Supabase **sin enviar el campo `id`**, permitiendo que PostgreSQL genere automáticamente el ID numérico consecutivo (`1, 2, 3...`).
  3. Con `.select('id').single()` recupera el número de ID exacto que le asignó Supabase y lo guarda también en la lista en memoria (`globalForLogs.serviceLogs`) como respaldo.

### 3.3. `getServiceLogs(): Promise<ServiceLog[]>`
* **Qué hace:** Obtiene el historial de eventos para mostrarlo en la tabla plana del servidor y en `GET /api/logs`.
* **Proceso paso a paso:**
  1. Consulta los últimos 100 registros de la tabla `service_logs` en Supabase ordenados del más reciente al más antiguo (`ORDER BY created_at DESC`).
  2. Consulta también la tabla `files` en Supabase y crea un mapa indexado por `ticket_id` (`filesByTicket`).
  3. **Correlación de datos reales:** Por cada fila de `service_logs`, si el evento tiene un `ticketId`, busca los datos del archivo en `filesByTicket` para completar campos como `fileName`, `extension`, `mimeType`, `fileSize`, `visibility`, `s3Landing` y `s3Permanent` directamente desde la base de datos.
  4. Devuelve el arreglo de objetos `ServiceLog` con todos los campos listos para mostrarse cada uno en su propia columna.

### 3.4. `clearServiceLogs(): Promise<void>`
* **Qué hace:** Vacía el arreglo en memoria y ejecuta un `DELETE` en la tabla `service_logs` de Supabase (`.not('created_at', 'is', null)`) para limpiar el historial cuando presionas el botón "Limpiar Logs".

---

## 4. Endpoint Principal de Subida y Tickets: `app/api/upload/route.ts`

Es el corazón del backend. Maneja tres métodos HTTP: `OPTIONS`, `POST` y `PUT`.

### 4.1. `OPTIONS()`
* **Qué hace:** Responde con código `204 No Content` y las cabeceras `Access-Control-Allow-Origin`, `Methods` y `Headers`.
* **Por qué existe:** Cuando el navegador del cliente (`localhost:3000`) hace una petición `POST` o `PUT` a otro dominio (Vercel), el navegador envía primero una petición automática `OPTIONS` (*Preflight CORS*) para preguntar si tiene permiso de comunicarse.

### 4.2. `POST(req: NextRequest)` — Solicitud de Ticket y Link Prefirmado de S3
Cuando el cliente solicita subir un archivo, esta función ejecuta **6 fases en orden estricto**:

1. **Lectura del Body JSON:**
   Extrae `userId`, `orgId`, `fileName`, `fileType` (MIME), `fileSize`, `visibility`, `sha256Hash` y `extension`.
2. **CHECK 1 — Autenticación de Usuario (`401 Unauthorized`):**
   * Busca `userId` en el catálogo `USERS`.
   * Si no existe (ej. el *Ghost User*), llama a `addServiceLog` con `action: 'TICKET_REQUEST'` y `status: 'DENIED_NOT_REGISTERED'`, y corta el flujo devolviendo HTTP `401`.
3. **CHECK 2 — Aislamiento Multi-Tenant (`403 Forbidden - FORBIDDEN_CROSS_ORGANIZATION`):**
   * Compara la organización a la que pertenece el usuario (`user.orgId`) contra la organización a la que intenta subir el archivo (`orgId`).
   * Si son distintas (ej. un usuario de la Organización 1 intenta subir a la Organización 2), registra el incidente de seguridad `CROSS_ORG_VIOLATION` (`DENIED_CROSS_ORG`) en `service_logs` y bloquea la petición con HTTP `403`.
4. **CHECK 3 — Permisos por Rol RBAC (`403 Forbidden - FORBIDDEN_NO_PERMISSION`):**
   * Revisa la bandera `user.canUpload`.
   * Si es `false` (usuarios con rol `viewer`), registra `INSUFFICIENT_PERMISSIONS` (`DENIED_NO_PERMISSION`) en `service_logs` y devuelve HTTP `403`.
5. **Generación de Ticket, Rutas S3 y Firma:**
   * Si pasó los 3 filtros de seguridad, genera dos UUIDs únicos: `fileId` (ID del archivo) y `ticketId` (ID del ticket de autorización).
   * Clasifica el recurso según su MIME (`images`, `videos` o `documents`).
   * Determina la extensión con punto (ej. `.docx`, `.html`, `.png`) ya sea tomándola del body HTTP o extrayéndola de `fileName`.
   * Construye las dos rutas de S3:
     * **Zona de aterrizaje (`landingZoneKey`):** `pending/{user.id}/{fileName}`
     * **Zona definitiva (`permanentTargetKey`):** `organizations/{orgSlug}/{resourceType}/{visibility}/{ticketId}-{fileName}`
   * Llama a `generatePresignedUploadUrl(landingZoneKey, fileType, 900)` para obtener el link prefirmado real de AWS S3 (`uploadUrl`).
6. **Persistencia en Supabase y Respuesta al Cliente:**
   * **Tabla `files`:** Inserta la fila del archivo con `status: 'pending_upload'`, `ticket_id`, `original_name`, `extension`, `mime_type`, `size_bytes`, `sha256_hash`, `s3_pending_key` y `s3_processed_key`.
   * **Tabla `service_logs`:** Llama a `addServiceLog` con `action: 'TICKET_ISSUED'`, `status: 'ALLOWED'`, guardando el `method` (`POST`), el `ticketId`, y el `uploadUrl` generado.
   * **Respuesta HTTP `200 OK`:** Devuelve al cliente el JSON con `ticketId`, `fileId`, `uploadUrl` (el link a S3), `method: req.method` (`POST`), `uploadMethod: 'PUT'`, `s3Hierarchy` y `metadata`.

### 4.3. `PUT(req: NextRequest)` — Confirmación de Subida a S3
Una vez que el cliente terminó de subir los bytes del archivo a AWS S3 usando el `uploadUrl`, llama a `PUT /api/upload?ticketId=...`:
1. Lee el `ticketId` de los parámetros de la URL (`searchParams.get('ticketId')`).
2. Busca ese `ticket_id` en la tabla `files` de Supabase, actualiza su columna `status` a `'completed'` y guarda la fecha `completed_at`, recuperando con `.select('*')` todos los datos reales del archivo (`fileRow`).
3. Registra en `service_logs` el evento `S3_UPLOAD_CONFIRMED` con estado `UPLOADED_LANDING`, incluyendo el método real (`PUT`), el `ticketId` y los metadatos recuperados de `files`.
4. Responde HTTP `200 OK` confirmando que la subida quedó asentada en la base de datos.

---

## 5. Endpoints de Consulta y Limpieza

### 5.1. `app/api/logs/route.ts`
* **`GET()`:** Llama a `getServiceLogs()` y devuelve en formato JSON `{ logs, count }` todos los registros de la bitácora. Es el endpoint que consume la tabla plana del servidor cada 4 segundos.
* **`DELETE()`:** Llama a `clearServiceLogs()` para borrar el historial de `service_logs`.

### 5.2. `app/api/records/route.ts`
* **`GET()`:** Consulta la tabla `files` de Supabase (con fallback automático si no existen relaciones foráneas declaradas), formatea los campos (`fileName`, `extension`, `mimeType`, `sizeBytes`, `sha256Hash`) y devuelve la lista de archivos registrados.
* **`DELETE()`:** Borra los registros de la tabla `files`.

### 5.3. `app/api/test/cleanup/route.ts`
* **`handleCleanup(req: NextRequest)` (invocado por `DELETE` y `POST`):**
  1. Lee si la limpieza es para un usuario específico (`userId`) o global (`all=true`).
  2. Llama a `deleteS3ObjectsByPrefix('pending/...')` para borrar físicamente los archivos de prueba alojados en el bucket de AWS S3.
  3. Borra los registros correspondientes en las tablas `files` y `service_logs` de Supabase.
  4. Registra un único log final `TEST_ENVIRONMENT_CLEANUP` dejando constancia de cuántos objetos de S3 fueron eliminados.

---

## 6. Interfaz del Servidor (Bitácora Plana): `app/layout.tsx` y `app/page.tsx`

### 6.1. `RootLayout` (`app/layout.tsx`)
* Define la estructura HTML base con fondo blanco (`#ffffff`), texto negro (`#000000`) y fuente monoespaciada (`monospace`), sin hojas de estilo externas ni decoraciones.

### 6.2. `ServiceLogsPage` (`app/page.tsx`)
* **Estados (`useState`):**
  * `logs`: Almacena el arreglo de eventos recibidos desde `/api/logs`.
  * `loading`: Indica si se está actualizando la consulta.
* **`fetchLogs()`:**
  Hace una petición `GET /api/logs` con `cache: 'no-store'` para traer siempre los datos frescos desde Supabase y actualiza el estado `logs`.
* **`clearLogs()`:**
  Pide confirmación y envía `DELETE /api/logs` para vaciar la bitácora, recargando la tabla enseguida.
* **`useEffect(...)`:**
  Ejecuta `fetchLogs()` al abrir la página y configura un temporizador (`setInterval`) que refresca la tabla automáticamente cada 4 segundos (`4000 ms`).
* **Renderizado de la Tabla (`<table>`):**
  Recorre `logs.map((log, index) => ...)` aplicando color de fondo blanco (`#ffffff`) a las filas pares (`index % 2 === 0`) y gris claro (`#f2f2f2`) a las filas impares, colocando cada propiedad del log (`id`, `timestamp`, `method`, `action`, `status`, `ticket_id`, `user_id`, `user_name`, `org_id`, `org_name`, `file_name`, `extension`, `mime_type`, `size_bytes`, `visibility`, `upload_url`, `s3_pending_key`, `s3_processed_key`, `ip_address`, `message`) en su propia celda `<td>`.
