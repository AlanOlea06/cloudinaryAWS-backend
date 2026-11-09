import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * GET /docs
 * Documentación interactiva OpenAPI 3.0 servida con Swagger UI 5 desde CDN.
 * Ruta pública de solo lectura; no accede ni expone variables de entorno ni secretos.
 */
export async function GET() {
  const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>API Docs — Cloudinary Clone AWS S3 / CloudFront</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5.17.14/swagger-ui.css" />
  <style>
    body {
      margin: 0;
      padding: 0;
      background: #fafafa;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    .top-banner {
      background: #0f172a;
      color: #f8fafc;
      padding: 12px 24px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid #1e293b;
      font-size: 14px;
    }
    .top-banner strong {
      font-size: 16px;
      color: #38bdf8;
    }
    .top-banner a {
      color: #38bdf8;
      text-decoration: none;
      border: 1px solid #38bdf8;
      padding: 6px 12px;
      border-radius: 6px;
      font-weight: 500;
      font-size: 13px;
    }
    .top-banner a:hover {
      background: #38bdf8;
      color: #0f172a;
    }
  </style>
</head>
<body>
  <div class="top-banner">
    <div>
      <strong>Cloudinary Clone — Documentación de Consumo API (OpenAPI 3.0)</strong>
      <span style="margin-left: 12px; color: #94a3b8;">Solo lectura · Sin exposición de secretos</span>
    </div>
    <div>
      <a href="/docs/openapi.yaml" target="_blank" rel="noopener noreferrer">Descargar openapi.yaml</a>
    </div>
  </div>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5.17.14/swagger-ui-bundle.js" crossorigin></script>
  <script src="https://unpkg.com/swagger-ui-dist@5.17.14/swagger-ui-standalone-preset.js" crossorigin></script>
  <script>
    window.onload = function () {
      window.ui = SwaggerUIBundle({
        url: '/docs/openapi.yaml',
        dom_id: '#swagger-ui',
        deepLinking: true,
        displayRequestDuration: true,
        docExpansion: 'list',
        filter: true,
        presets: [
          SwaggerUIBundle.presets.apis,
          SwaggerUIStandalonePreset
        ],
        layout: 'BaseLayout'
      });
    };
  </script>
</body>
</html>`;

  return new NextResponse(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=60, must-revalidate',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
