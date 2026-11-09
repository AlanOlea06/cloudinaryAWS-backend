import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export const dynamic = 'force-dynamic';

/**
 * GET /docs/openapi.yaml
 * Sirve el archivo estático servicio/openapi.yaml en modo de solo lectura.
 * No lee ni expone variables de entorno ni secretos.
 */
export async function GET() {
  try {
    const filePath = path.join(process.cwd(), 'openapi.yaml');
    const yamlContent = fs.readFileSync(filePath, 'utf8');

    return new NextResponse(yamlContent, {
      status: 200,
      headers: {
        'Content-Type': 'application/yaml; charset=utf-8',
        'Cache-Control': 'public, max-age=60, must-revalidate',
        'X-Content-Type-Options': 'nosniff',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch {
    return NextResponse.json(
      {
        error: 'Not Found',
        code: 'OPENAPI_SPEC_NOT_FOUND',
        message: 'No se encontró el archivo openapi.yaml.',
      },
      { status: 404 }
    );
  }
}
