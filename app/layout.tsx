import React from 'react';

export const metadata = {
  title: 'Service Logs - Bitacora de Eventos del Sistema',
  description: 'Historial de eventos del sistema (service_logs)',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="es">
      <body
        style={{
          margin: 0,
          padding: '16px',
          backgroundColor: '#ffffff',
          color: '#000000',
          fontFamily: 'monospace, sans-serif',
          fontSize: '12px',
        }}
      >
        {children}
      </body>
    </html>
  );
}
