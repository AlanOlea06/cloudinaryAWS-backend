import { NextRequest, NextResponse } from 'next/server';
import { USUARIOS, ORGANIZACIONES, addServiceLog } from '@/lib/service-logs';
import { supabase } from '@/lib/supabase';

// Cabeceras CORS
const corsHeaders = {
  'Access-Control-Allow-Origin': 'http://localhost:3000',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-mock-mode',
};

// 1. Manejo de Preflight OPTIONS
export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: corsHeaders,
  });
}

// 2. Endpoint principal: Emisión de Ticket de Subida con PERSISTENCIA EN SUPABASE
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      userId,
      orgId,
      fileName = 'archivo.png',
      fileType = 'image/png',
      fileSize = 1024,
      visibilidad = 'privados',
      hashSha256 = 'simulated-hash-sha256',
    } = body;

    // COMPROBACIÓN 1: Autenticación / Registro del Usuario
    const usuario = userId ? USUARIOS[userId] : null;
    if (!usuario) {
      await addServiceLog({
        accion: 'PETICION_TICKET',
        estado: 'DENEGADO_NO_REGISTRADO',
        userId: userId || 'desconocido',
        userName: 'Usuario No Registrado',
        targetOrgId: orgId,
        detalles: {
          motivo: 'El usuario no existe en la base de datos de usuarios.',
          ip: req.headers.get('x-forwarded-for') || '127.0.0.1',
          fileName,
        },
      });

      return NextResponse.json(
        {
          error: 'Unauthorized',
          code: 'USER_NOT_REGISTERED',
          message: 'Acceso Denegado: El usuario no está registrado en el sistema.',
        },
        { status: 401, headers: corsHeaders }
      );
    }

    const orgUsuario = ORGANIZACIONES[usuario.orgId];
    const orgDestino = orgId ? ORGANIZACIONES[orgId] : null;

    if (!orgDestino) {
      return NextResponse.json(
        {
          error: 'Not Found',
          code: 'ORGANIZATION_NOT_FOUND',
          message: 'La organización destino especificada no existe.',
        },
        { status: 404, headers: corsHeaders }
      );
    }

    // COMPROBACIÓN 2: Aislamiento Multi-Tenant (NO PERMITIR SUBIR A OTRA ORGANIZACIÓN)
    if (usuario.orgId !== orgId) {
      await addServiceLog({
        accion: 'VIOLACION_MULTI_TENANT',
        estado: 'DENEGADO_OTRA_ORG',
        userId: usuario.id,
        userName: usuario.nombre,
        orgId: usuario.orgId,
        orgNombre: orgUsuario?.nombre,
        targetOrgId: orgId,
        detalles: {
          alerta: 'INTENTO DE SUBIDA CRUZADA BLOQUEADO',
          orgOrigen: orgUsuario?.nombre,
          orgDestino: orgDestino.nombre,
          archivo: fileName,
          ip: req.headers.get('x-forwarded-for') || '127.0.0.1',
        },
      });

      return NextResponse.json(
        {
          error: 'Forbidden',
          code: 'FORBIDDEN_CROSS_ORGANIZATION',
          message: `Violación de Seguridad Multi-Tenant: El usuario '${usuario.nombre}' pertenece a '${orgUsuario?.nombre}' y NO puede subir archivos a '${orgDestino.nombre}'.`,
          detalles: {
            usuarioOrg: orgUsuario?.nombre,
            destinoOrg: orgDestino.nombre,
          },
        },
        { status: 403, headers: corsHeaders }
      );
    }

    // COMPROBACIÓN 3: Permiso de Subida de Archivos Importantes
    if (!usuario.puede_subir) {
      await addServiceLog({
        accion: 'PERMISO_INSUFICIENTE',
        estado: 'DENEGADO_SIN_PERMISO',
        userId: usuario.id,
        userName: usuario.nombre,
        orgId: usuario.orgId,
        orgNombre: orgUsuario?.nombre,
        detalles: {
          motivo: 'El usuario tiene rol de visitante y no tiene permiso puede_subir=true.',
          archivo: fileName,
        },
      });

      return NextResponse.json(
        {
          error: 'Forbidden',
          code: 'FORBIDDEN_NO_PERMISSION',
          message: `Permiso Denegado: El usuario '${usuario.nombre}' no tiene autorización para subir archivos importantes a ${orgUsuario?.nombre}.`,
        },
        { status: 403, headers: corsHeaders }
      );
    }

    // SI PASÓ TODAS LAS COMPROBACIONES -> GENERAR TICKET, RUTAS S3 Y GUARDAR EN SUPABASE
    const fileId = crypto.randomUUID();
    const ticketId = crypto.randomUUID();
    const timestamp = Date.now();
    const orgSlug = orgDestino.slug;

    // Clasificación de tipología (imágenes, documentos, videos)
    let tipo = 'documentos';
    if (fileType.startsWith('image/')) tipo = 'imagenes';
    else if (fileType.startsWith('video/')) tipo = 'videos';

    // Jerarquía de rutas S3 estricta
    const landingZoneKey = `Pendientes/${orgSlug}/${usuario.id}/${ticketId}-${fileName}`;
    const permanentTargetKey = `Organizaciones/${orgSlug}/${tipo}/${visibilidad}/${ticketId}-${fileName}`;

    // URL de subida
    const host = req.headers.get('host') || 'localhost:3000';
    const protocol = host.includes('localhost') ? 'http' : 'https';
    const uploadUrl = `${protocol}://${host}/api/upload?ticketId=${ticketId}`;

    // 1. Guardar archivo en la tabla 'archivos' de Supabase
    try {
      const { error: fileErr } = await supabase.from('archivos').insert({
        id: fileId,
        ticket_id: ticketId,
        user_id: usuario.id,
        user_name: usuario.nombre,
        org_id: orgDestino.id,
        nombre_original: fileName,
        formato: fileType,
        tamano_bytes: fileSize,
        tipo_recurso: tipo,
        visibilidad: visibilidad,
        s3_key_pendiente: landingZoneKey,
        s3_key_procesado: permanentTargetKey,
        estado: 'pendiente_subida',
        metadata: {
          hash_sha256: hashSha256,
          ticketId,
          landingZone: landingZoneKey,
          permanentTarget: permanentTargetKey,
        },
        created_at: new Date(timestamp).toISOString(),
      });

      if (fileErr) {
        console.warn('Advertencia insertando en tabla archivos de Supabase:', fileErr.message);
      }
    } catch (dbErr: any) {
      console.error('Error insertando en tabla archivos de Supabase:', dbErr.message);
    }

    // 2. Registrar evento en la tabla 'logs_servicio' de Supabase
    await addServiceLog({
      accion: 'TICKET_EMITIDO',
      estado: 'PERMITIDO',
      userId: usuario.id,
      userName: usuario.nombre,
      orgId: usuario.orgId,
      orgNombre: orgUsuario?.nombre,
      targetOrgId: orgId,
      detalles: {
        ticketId,
        fileId,
        archivo: fileName,
        tamano: fileSize,
        tipo,
        visibilidad,
        s3Landing: landingZoneKey,
        s3Permanente: permanentTargetKey,
      },
    });

    return NextResponse.json(
      {
        ticketId,
        fileId,
        uploadUrl,
        isMultipart: fileSize > 20 * 1024 * 1024,
        usuario: {
          id: usuario.id,
          nombre: usuario.nombre,
          rol: usuario.rol,
        },
        organizacion: {
          id: orgDestino.id,
          nombre: orgDestino.nombre,
          slug: orgDestino.slug,
        },
        s3Hierarchy: {
          landingZone: landingZoneKey,
          permanentTarget: permanentTargetKey,
        },
        metadata: {
          userId: usuario.id,
          orgId: orgDestino.id,
          orgSlug,
          visibilidad,
          fileName,
          fileSize,
          hashSha256,
          issuedAt: new Date(timestamp).toISOString(),
        },
      },
      { status: 200, headers: corsHeaders }
    );
  } catch (error: any) {
    return NextResponse.json(
      { error: 'Internal Server Error', message: error.message },
      { status: 500, headers: corsHeaders }
    );
  }
}

// 3. Simulación de subida directa a S3 (PUT a la URL pre-firmada)
export async function PUT(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const ticketId = searchParams.get('ticketId') || 'unknown';

  // 1. Actualizar estado del archivo en la tabla 'archivos' de Supabase
  try {
    const { error } = await supabase
      .from('archivos')
      .update({
        estado: 'completado',
        updated_at: new Date().toISOString(),
      })
      .eq('ticket_id', ticketId);

    if (error) {
      console.warn('Advertencia actualizando archivo en Supabase:', error.message);
    }
  } catch (dbErr: any) {
    console.error('Error actualizando archivo en Supabase:', dbErr.message);
  }

  // 2. Registrar evento en la tabla 'logs_servicio' de Supabase
  await addServiceLog({
    accion: 'RECEPCION_S3',
    estado: 'SUBIDO_LANDING',
    detalles: {
      ticketId,
      mensaje: `Archivo recibido en Pendientes/ para el ticket ${ticketId}`,
    },
  });

  return NextResponse.json(
    {
      status: 'success',
      message: `[MOCK S3] Archivo recibido en zona de aterrizaje para ticket ${ticketId} y registrado en Supabase`,
      ticketId,
      s3Status: 'uploaded_to_landing',
    },
    { status: 200, headers: corsHeaders }
  );
}
