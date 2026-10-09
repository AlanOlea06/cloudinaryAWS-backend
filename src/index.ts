import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from './config/env.js';
import { uploadRouter } from './routes/upload.routes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Permite cargar estilos e iconos para la interfaz interactiva local
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  })
);
app.use(cors());
app.use(express.json());

// Servir la interfaz web estática interactiva
const publicDir = path.resolve(__dirname, '../public');
app.use(express.static(publicDir));

// Endpoint de verificación de salud (esencial para Railway)
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'cloudinary-clone-central-server',
    mockMode: env.MOCK_MODE,
    timestamp: new Date().toISOString(),
  });
});

// Enrutador del módulo de uploads
app.use('/api/upload', uploadRouter);

// Si se visita la raíz, servir la interfaz
app.get('/', (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

const port = Number(process.env.PORT || env.PORT);
app.listen(port, '0.0.0.0', () => {
  console.log(`🚀 Servidor Central Cloudinary Clon corriendo en puerto ${port}`);
  console.log(`🌐 Health check disponible en: http://0.0.0.0:${port}/health`);
  console.log(`🧪 Modo Simulación: ${env.MOCK_MODE ? 'ACTIVO (No requiere AWS)' : 'DESACTIVADO (Usa AWS real)'}`);
});
