import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { isAwsConfigured, deleteS3ObjectsByPrefix } from '@/lib/s3';
import { addServiceLog, clearServiceLogs } from '@/lib/service-logs';

const corsHeaders = {
  'Access-Control-Allow-Origin': 'http://localhost:3000',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

/**
 * Handler común de limpieza para DELETE y POST
 */
async function handleCleanup(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    let userId = searchParams.get('userId') || 'a1111111-0000-0000-0000-000000000001';
    let cleanAll = searchParams.get('all') === 'true';

    // Intentar leer del body si vino por POST/DELETE con payload JSON
    try {
      const body = await req.json().catch(() => ({}));
      if (body.userId) userId = body.userId;
      if (body.all !== undefined) cleanAll = Boolean(body.all);
    } catch {
      // Ignorar si no hay body JSON
    }

    const s3Prefix = cleanAll ? 'pendientes/' : `pendientes/${userId}/`;
    let s3DeletedCount = 0;
    let s3DeletedKeys: string[] = [];
    let s3Status = 'aws_not_configured';

    // 1. Limpieza de Objetos en AWS S3
    if (isAwsConfigured()) {
      try {
        const s3Res = await deleteS3ObjectsByPrefix(s3Prefix);
        s3DeletedCount = s3Res.count;
        s3DeletedKeys = s3Res.keys;
        s3Status = 'success';
      } catch (s3Err: any) {
        console.error('Error al limpiar objetos en S3:', s3Err.message);
        s3Status = `error: ${s3Err.message}`;
      }
    }

    // 2. Limpieza de Registros en la tabla 'archivos' de Supabase
    let archivosQuery = supabase.from('archivos').delete();
    if (cleanAll) {
      archivosQuery = archivosQuery.neq('id', '00000000-0000-0000-0000-000000000000');
    } else {
      archivosQuery = archivosQuery.eq('user_id', userId);
    }
    const { error: errArchivos, count: countArchivos } = await archivosQuery;
    if (errArchivos) {
      console.warn('Advertencia limpiando tabla archivos:', errArchivos.message);
    }

    // 3. Limpieza de Registros en la tabla 'logs_servicio' de Supabase
    let logsQuery = supabase.from('logs_servicio').delete();
    if (cleanAll) {
      logsQuery = logsQuery.neq('id', '00000000-0000-0000-0000-000000000000');
    } else {
      logsQuery = logsQuery.eq('user_id', userId);
    }
    const { error: errLogs, count: countLogs } = await logsQuery;
    if (errLogs) {
      console.warn('Advertencia limpiando tabla logs_servicio:', errLogs.message);
    }

    // Registrar evento de auditoría de la limpieza
    await addServiceLog({
      accion: 'LIMPIEZA_PRUEBAS',
      estado: 'PERMITIDO',
      userId: cleanAll ? 'admin-system' : userId,
      userName: cleanAll ? 'Sistema (Global)' : 'Usuario de Test',
      detalles: {
        s3Prefix,
        s3DeletedCount,
        s3Status,
        cleanAll,
        archivosEliminados: countArchivos ?? 'ejecutado',
        logsEliminados: countLogs ?? 'ejecutado',
      },
    });

    return NextResponse.json(
      {
        status: 'success',
        message: 'Limpieza de entorno de pruebas completada exitosamente.',
        cleanupScope: {
          cleanAll,
          targetUserId: cleanAll ? 'TODOS' : userId,
          s3PrefixCleaned: s3Prefix,
        },
        results: {
          s3: {
            configured: isAwsConfigured(),
            status: s3Status,
            deletedCount: s3DeletedCount,
            deletedKeys: s3DeletedKeys,
          },
          supabase: {
            archivosTable: errArchivos ? `Error: ${errArchivos.message}` : 'Limpiado con éxito',
            logsTable: errLogs ? `Error: ${errLogs.message}` : 'Limpiado con éxito',
          },
        },
        timestamp: new Date().toISOString(),
      },
      { status: 200, headers: corsHeaders }
    );
  } catch (error: any) {
    return NextResponse.json(
      {
        status: 'error',
        message: 'Error al ejecutar limpieza de pruebas',
        error: error.message,
      },
      { status: 500, headers: corsHeaders }
    );
  }
}

export async function DELETE(req: NextRequest) {
  return handleCleanup(req);
}

export async function POST(req: NextRequest) {
  return handleCleanup(req);
}

export async function GET(req: NextRequest) {
  return NextResponse.json(
    {
      message: 'Endpoint de limpieza para pruebas (5GB Free Tier Management)',
      usage: {
        method: 'DELETE (o POST)',
        url: '/api/test/cleanup',
        queryParams: {
          userId: 'ID del usuario de test a limpiar (opcional, defecto: Carlos Mendoza)',
          all: 'true para limpiar todos los archivos de prueba en pendientes/ (opcional)',
        },
        examples: [
          'DELETE /api/test/cleanup',
          'DELETE /api/test/cleanup?userId=a1111111-0000-0000-0000-000000000001',
          'DELETE /api/test/cleanup?all=true',
        ],
      },
      awsConfigured: isAwsConfigured(),
    },
    { status: 200, headers: corsHeaders }
  );
}
