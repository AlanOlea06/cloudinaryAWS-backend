import { NextRequest, NextResponse } from 'next/server';

// Cabeceras CORS para responder a peticiones preflight (OPTIONS)
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

// 2. Endpoint principal: Emisión de Ticket de Subida
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      userId = 'a1111111-0000-0000-0000-000000000001',
      orgId = '11111111-1111-1111-1111-111111111111',
      fileName = 'archivo.png',
      fileType = 'image/png',
      fileSize = 1024,
      visibilidad = 'privados',
      hashSha256 = 'simulated-hash-sha256',
    } = body;

    // Validación básica Multi-Tenant (Simulada)
    if (userId === '00000000-0000-0000-0000-000000000000') {
      return NextResponse.json(
        { error: 'Unauthorized', message: 'Usuario no registrado en el sistema.' },
        { status: 401, headers: corsHeaders }
      );
    }

    const ticketId = crypto.randomUUID();
    const timestamp = Date.now();
    const orgSlug = orgId === '11111111-1111-1111-1111-111111111111' ? 'organizacion_1' : 'organizacion_2';
    
    // Clasificación de tipología
    let tipo = 'documentos';
    if (fileType.startsWith('image/')) tipo = 'imagenes';
    else if (fileType.startsWith('video/')) tipo = 'videos';

    // Jerarquía de rutas S3 según especificación
    const landingZoneKey = `Pendientes/${orgSlug}/${userId}/${ticketId}-${fileName}`;
    const permanentTargetKey = `Organizaciones/${orgSlug}/${tipo}/${visibilidad}/${ticketId}-${fileName}`;

    // URL simulada de subida (o endpoint para mock PUT en Vercel)
    const host = req.headers.get('host') || 'localhost:3000';
    const protocol = host.includes('localhost') ? 'http' : 'https';
    const uploadUrl = `${protocol}://${host}/api/upload?ticketId=${ticketId}`;

    return NextResponse.json(
      {
        ticketId,
        uploadUrl,
        isMultipart: fileSize > 20 * 1024 * 1024, // > 20MB simula multipart
        s3Hierarchy: {
          landingZone: landingZoneKey,
          permanentTarget: permanentTargetKey,
        },
        metadata: {
          userId,
          orgId,
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

// 3. Simulación de subida directa a S3 (PUT a la URL simulada)
export async function PUT(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const ticketId = searchParams.get('ticketId') || 'unknown';

  return NextResponse.json(
    {
      status: 'success',
      message: `[MOCK S3] Archivo recibido en zona de aterrizaje para ticket ${ticketId}`,
      ticketId,
      s3Status: 'uploaded_to_landing',
    },
    { status: 200, headers: corsHeaders }
  );
}
