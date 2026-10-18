'use client';

import React, { useState, useEffect } from 'react';

interface LogEntry {
  id: string;
  timestamp: string;
  method?: string | null;
  action: string;
  status: string;
  ticketId?: string | null;
  fileId?: string | null;
  userId?: string | null;
  userName?: string | null;
  orgId?: string | null;
  orgName?: string | null;
  targetOrgId?: string | null;
  fileName?: string | null;
  extension?: string | null;
  mimeType?: string | null;
  fileSize?: number | null;
  resourceType?: string | null;
  visibility?: string | null;
  uploadUrl?: string | null;
  s3Landing?: string | null;
  s3Permanent?: string | null;
  ipAddress?: string | null;
  message?: string | null;
  details?: any;
}

const cellStyle: React.CSSProperties = {
  border: '1px solid #cccccc',
  padding: '6px 8px',
  verticalAlign: 'top',
  wordBreak: 'break-all',
};

const headerCellStyle: React.CSSProperties = {
  ...cellStyle,
  backgroundColor: '#e0e0e0',
  fontWeight: 'bold',
  whiteSpace: 'nowrap',
};

export default function ServiceLogsPage() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState<boolean>(true);

  const fetchLogs = async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/logs', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        setLogs(Array.isArray(data.logs) ? data.logs : []);
      }
    } catch (err) {
      console.error('Error fetching logs:', err);
    } finally {
      setLoading(false);
    }
  };

  const clearLogs = async () => {
    if (!confirm('¿Limpiar todos los registros de service_logs en Supabase?')) return;
    await fetch('/api/logs', { method: 'DELETE' });
    fetchLogs();
  };

  useEffect(() => {
    fetchLogs();
    const interval = setInterval(fetchLogs, 4000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div>
      <div style={{ marginBottom: '10px' }}>
        <strong>BITACORA DE EVENTOS DEL SISTEMA (service_logs)</strong> | Total registros: {logs.length}{' '}
        | <button onClick={fetchLogs} disabled={loading}>{loading ? 'Cargando...' : 'Actualizar'}</button>{' '}
        <button onClick={clearLogs}>Limpiar Logs</button>
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table
          style={{
            width: '100%',
            borderCollapse: 'collapse',
            border: '1px solid #cccccc',
            fontFamily: 'monospace',
            fontSize: '12px',
            textAlign: 'left',
          }}
        >
          <thead>
            <tr>
              <th style={headerCellStyle}>id</th>
              <th style={headerCellStyle}>timestamp</th>
              <th style={headerCellStyle}>method</th>
              <th style={headerCellStyle}>action</th>
              <th style={headerCellStyle}>status</th>
              <th style={headerCellStyle}>ticket_id</th>
              <th style={headerCellStyle}>user_id</th>
              <th style={headerCellStyle}>user_name</th>
              <th style={headerCellStyle}>org_id</th>
              <th style={headerCellStyle}>org_name</th>
              <th style={headerCellStyle}>file_name</th>
              <th style={headerCellStyle}>extension</th>
              <th style={headerCellStyle}>mime_type</th>
              <th style={headerCellStyle}>size_bytes</th>
              <th style={headerCellStyle}>visibility</th>
              <th style={headerCellStyle}>upload_url (link)</th>
              <th style={headerCellStyle}>s3_pending_key</th>
              <th style={headerCellStyle}>s3_processed_key</th>
              <th style={headerCellStyle}>ip_address</th>
              <th style={headerCellStyle}>message / detail</th>
            </tr>
          </thead>
          <tbody>
            {logs.length === 0 ? (
              <tr style={{ backgroundColor: '#ffffff' }}>
                <td colSpan={20} style={cellStyle}>
                  Sin registros en service_logs.
                </td>
              </tr>
            ) : (
              logs.map((log, index) => {
                const details = log.details || {};
                const method = log.method || details.method || '-';
                const ticketId = log.ticketId || details.ticketId || '-';
                const userId = log.userId || details.userId || '-';
                const userName = log.userName || details.userName || '-';
                const orgId = log.orgId || details.orgId || '-';
                const orgName = log.orgName || details.orgName || details.orgNombre || '-';
                const fileName = log.fileName || details.fileName || '-';
                const extension = log.extension || details.extension || '-';
                const mimeType = log.mimeType || details.mimeType || '-';
                const fileSize = log.fileSize ?? details.fileSize ?? '-';
                const visibility = log.visibility || details.visibility || '-';
                const uploadUrl = log.uploadUrl || details.uploadUrl || '-';
                const s3Landing = log.s3Landing || details.s3Landing || '-';
                const s3Permanent = log.s3Permanent || details.s3Permanent || '-';
                const ipAddress = log.ipAddress || details.ip || '-';
                const message =
                  log.message ||
                  details.message ||
                  details.reason ||
                  details.alert ||
                  '-';

                return (
                  <tr
                    key={log.id}
                    style={{
                      backgroundColor: index % 2 === 0 ? '#ffffff' : '#f2f2f2',
                    }}
                  >
                    <td style={cellStyle}>{log.id}</td>
                    <td style={{ ...cellStyle, whiteSpace: 'nowrap' }}>{log.timestamp}</td>
                    <td style={cellStyle}>{method}</td>
                    <td style={{ ...cellStyle, whiteSpace: 'nowrap' }}>{log.action}</td>
                    <td style={{ ...cellStyle, whiteSpace: 'nowrap' }}>{log.status}</td>
                    <td style={cellStyle}>{ticketId}</td>
                    <td style={cellStyle}>{userId}</td>
                    <td style={{ ...cellStyle, whiteSpace: 'nowrap' }}>{userName}</td>
                    <td style={cellStyle}>{orgId}</td>
                    <td style={{ ...cellStyle, whiteSpace: 'nowrap' }}>{orgName}</td>
                    <td style={cellStyle}>{fileName}</td>
                    <td style={cellStyle}>{extension}</td>
                    <td style={cellStyle}>{mimeType}</td>
                    <td style={cellStyle}>{fileSize}</td>
                    <td style={cellStyle}>{visibility}</td>
                    <td style={{ ...cellStyle, maxWidth: '320px' }}>{uploadUrl}</td>
                    <td style={cellStyle}>{s3Landing}</td>
                    <td style={cellStyle}>{s3Permanent}</td>
                    <td style={cellStyle}>{ipAddress}</td>
                    <td style={cellStyle}>{message}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
