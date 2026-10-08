'use client';

import React, { useState, useRef } from 'react';

/**
 * Componente interactivo para Next.js (App Router)
 * Puedes copiar este archivo a tu proyecto Next.js en `app/page.tsx` o `components/UploadSimulator.tsx`.
 */
export default function UploadSimulator() {
  const [file, setFile] = useState<File | null>(null);
  const [fileHash, setFileHash] = useState<string>('');
  const [isUploading, setIsUploading] = useState<boolean>(false);
  const [progress, setProgress] = useState<number>(0);
  const [isMultipart, setIsMultipart] = useState<boolean>(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [isMockMode, setIsMockMode] = useState<boolean>(true);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const addLog = (tag: string, text: string) => {
    const time = new Date().toLocaleTimeString();
    setLogs((prev) => [...prev, `[${time}] [${tag}] ${text}`]);
  };

  const calculateSHA256 = async (selectedFile: File) => {
    const buffer = await selectedFile.arrayBuffer();
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  };

  const handleFile = async (selectedFile: File) => {
    setFile(selectedFile);
    setResultUrl(null);
    setProgress(0);
    addLog('CLIENTE', `Archivo seleccionado: ${selectedFile.name} (${(selectedFile.size / 1024 / 1024).toFixed(2)} MB)`);
    
    try {
      const hash = await calculateSHA256(selectedFile);
      setFileHash(hash);
      addLog('CLIENTE', `Hash SHA-256 calculado: ${hash.substring(0, 16)}...`);
    } catch {
      addLog('ERROR', 'No se pudo calcular el hash');
    }
  };

  const handleUpload = async () => {
    if (!file || isUploading) return;
    setIsUploading(true);
    setProgress(0);

    try {
      addLog('PASO 1', 'Pidiendo permiso y ticket al servidor...');
      
      const res = await fetch('http://localhost:4000/api/upload/ticket', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(isMockMode ? { 'x-mock-mode': 'true' } : {}),
        },
        body: JSON.stringify({
          userId: 'a0000000-0000-0000-0000-000000000001',
          userName: 'Usuario',
          fileName: file.name,
          fileType: file.type || 'image/jpeg',
          fileSize: file.size,
        }),
      });

      if (!res.ok) throw new Error('Error al generar ticket');
      const ticket = await res.json();
      setIsMultipart(ticket.isMultipart);
      addLog('SERVIDOR', `Ticket emitido: ${ticket.ticketId}. S3 Key: ${ticket.metadata.key}`);

      // Simular subida con progreso
      addLog('PASO 2', 'Subiendo paquetes a S3 (/pendientes)...');
      for (let p = 15; p <= 100; p += 20) {
        await new Promise((r) => setTimeout(r, 200));
        setProgress(Math.min(p, 100));
      }

      addLog('S3 & LAMBDA', 'Archivo recibido en /pendientes. Lambda activada con Sharp...');
      addLog('GUARDDUTY', 'Escaneo de seguridad: LIMPIO');

      // Llamar simulación de procesamiento
      const procRes = await fetch(`http://localhost:4000/api/upload/mock-process/${ticket.ticketId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName: file.name, fileSize: file.size, fileType: file.type }),
      });
      const procData = await procRes.json();

      setResultUrl(procData.cloudfront_url);
      addLog('CLOUDFRONT', `Completado. URL CDN: ${procData.cloudfront_url}`);
    } catch (err: any) {
      addLog('ERROR', err.message);
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <div style={{ maxWidth: 800, margin: '2rem auto', fontFamily: 'sans-serif' }}>
      <h2>Simulador Direct Upload - Cloudinary Clone</h2>
      
      <div style={{ margin: '1rem 0' }}>
        <button onClick={() => setIsMockMode(!isMockMode)}>
          Modo: {isMockMode ? '🧪 Simulación (Sin AWS)' : '⚡ Real (AWS S3)'}
        </button>
      </div>

      <div
        style={{
          border: '2px dashed #6366f1',
          padding: '2rem',
          textAlign: 'center',
          borderRadius: '12px',
          cursor: 'pointer',
        }}
        onClick={() => fileInputRef.current?.click()}
      >
        <input
          ref={fileInputRef}
          type="file"
          style={{ display: 'none' }}
          onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
        />
        {file ? (
          <div>
            <strong>{file.name}</strong> ({(file.size / 1024).toFixed(1)} KB)
            <div style={{ fontSize: '0.8rem', color: '#666', marginTop: 4 }}>
              SHA-256: {fileHash.substring(0, 24)}...
            </div>
          </div>
        ) : (
          <p>Haz clic o arrastra un archivo aquí para probar</p>
        )}
      </div>

      <button
        onClick={handleUpload}
        disabled={!file || isUploading}
        style={{ marginTop: '1rem', padding: '10px 20px' }}
      >
        {isUploading ? `Subiendo (${progress}%)...` : 'Iniciar Subida Directa'}
      </button>

      {resultUrl && (
        <div style={{ marginTop: '1rem', padding: '1rem', background: '#ecfdf5', borderRadius: '8px' }}>
          <strong>¡Listo en CDN!</strong> <a href={resultUrl} target="_blank">{resultUrl}</a>
        </div>
      )}

      <div style={{ marginTop: '2rem', background: '#0f172a', color: '#cbd5e1', padding: '1rem', borderRadius: '8px', maxHeight: 250, overflowY: 'auto', fontFamily: 'monospace' }}>
        <strong>Terminal de Logs:</strong>
        {logs.map((log, i) => (
          <div key={i}>{log}</div>
        ))}
      </div>
    </div>
  );
}
