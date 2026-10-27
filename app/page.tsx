'use client';

import React, { useState, useEffect, useCallback } from 'react';

interface LogEntry {
  id: number | string;
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
  ipAddress?: string | null;
  message?: string | null;
  details?: any;
}

const cellStyle: React.CSSProperties = {
  border: '1px solid #d0d7de',
  padding: '6px 10px',
  verticalAlign: 'middle',
  wordBreak: 'break-all',
  fontSize: '12px',
};

const headerCellStyle: React.CSSProperties = {
  ...cellStyle,
  backgroundColor: '#f6f8fa',
  color: '#24292f',
  fontWeight: 600,
  whiteSpace: 'nowrap',
  position: 'sticky',
  top: 0,
  zIndex: 1,
};

const btnStyle: React.CSSProperties = {
  padding: '5px 12px',
  borderRadius: '6px',
  border: '1px solid #d0d7de',
  backgroundColor: '#f6f8fa',
  color: '#24292f',
  fontWeight: 500,
  fontSize: '12px',
  cursor: 'pointer',
};

const activeBtnStyle: React.CSSProperties = {
  ...btnStyle,
  backgroundColor: '#0969da',
  borderColor: '#0969da',
  color: '#ffffff',
  fontWeight: 600,
};

const disabledBtnStyle: React.CSSProperties = {
  ...btnStyle,
  opacity: 0.5,
  cursor: 'not-allowed',
};

function getStatusBadgeStyle(status: string): React.CSSProperties {
  const s = status.toUpperCase();
  let bg = '#f6f8fa';
  let color = '#57606a';
  let border = '#d0d7de';

  if (s.includes('ALLOWED') || s.includes('CONFIRMED') || s.includes('OK') || s.includes('SUCCESS')) {
    bg = '#dafbe1';
    color = '#1a7f37';
    border = '#aceebb';
  } else if (s.includes('DENIED') || s.includes('FAILED') || s.includes('BLOCKED') || s.includes('ERROR')) {
    bg = '#ffebe9';
    color = '#cf222e';
    border = '#ffcecb';
  } else if (s.includes('PENDING') || s.includes('SENDING')) {
    bg = '#fff8c5';
    color = '#9a6700';
    border = '#f1e05a';
  }

  return {
    display: 'inline-block',
    padding: '2px 7px',
    borderRadius: '12px',
    fontSize: '11px',
    fontWeight: 600,
    backgroundColor: bg,
    color,
    border: `1px solid ${border}`,
    whiteSpace: 'nowrap',
  };
}

export default function ServiceLogsPage() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [adminSecret, setAdminSecret] = useState<string>('');
  const [authMessage, setAuthMessage] = useState<string>('Ingresa ADMIN_API_SECRET para consultar /api/logs.');

  // Pagination state
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [pageSize, setPageSize] = useState<number>(20);
  const [totalPages, setTotalPages] = useState<number>(1);
  const [totalCount, setTotalCount] = useState<number>(0);

  // Load adminSecret from sessionStorage on mount
  useEffect(() => {
    try {
      const savedSecret = sessionStorage.getItem('admin_api_secret');
      if (savedSecret) {
        setAdminSecret(savedSecret);
      }
    } catch {
      // Ignore storage access errors
    }
  }, []);

  const fetchLogs = useCallback(
    async (pageToFetch: number = currentPage, sizeToFetch: number = pageSize) => {
      const trimmed = adminSecret.trim();
      if (!trimmed) {
        setLogs([]);
        setAuthMessage('Autenticación requerida: ingresa x-admin-secret para consultar /api/logs.');
        return;
      }

      try {
        setLoading(true);
        try {
          sessionStorage.setItem('admin_api_secret', trimmed);
        } catch {
          // Ignore storage write errors
        }

        const res = await fetch(`/api/logs?page=${pageToFetch}&limit=${sizeToFetch}&_t=${Date.now()}`, {
          cache: 'no-store',
          headers: {
            'x-admin-secret': trimmed,
          },
        });

        if (res.status === 401 || res.status === 403) {
          setLogs([]);
          setAuthMessage(`Acceso denegado (HTTP ${res.status}): ADMIN_API_SECRET inválido.`);
          return;
        }

        if (res.ok) {
          const data = await res.json();
          const returnedLogs: LogEntry[] = Array.isArray(data.logs) ? data.logs : [];
          setLogs(returnedLogs);
          const total = typeof data.total === 'number' ? data.total : (typeof data.count === 'number' ? data.count : returnedLogs.length);
          const pages = typeof data.totalPages === 'number' ? data.totalPages : Math.max(1, Math.ceil(total / sizeToFetch));
          const actualPage = typeof data.page === 'number' ? data.page : pageToFetch;

          setTotalCount(total);
          setTotalPages(pages);
          setCurrentPage(actualPage);
          setAuthMessage(`Conectado en tiempo real. Mostrando ${returnedLogs.length} de ${total} eventos.`);
        } else {
          setAuthMessage(`Error al consultar logs: HTTP ${res.status}`);
        }
      } catch (err: any) {
        console.error('Error fetching logs:', err);
        setAuthMessage(`Error de red: ${err?.message || 'Fallo de conexión'}`);
      } finally {
        setLoading(false);
      }
    },
    [adminSecret, currentPage, pageSize]
  );

  // Page navigation helper
  const goToPage = (page: number) => {
    const targetPage = Math.max(1, Math.min(totalPages, page));
    setCurrentPage(targetPage);
    fetchLogs(targetPage, pageSize);
  };

  // Change page size helper
  const handlePageSizeChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newSize = parseInt(e.target.value, 10) || 20;
    setPageSize(newSize);
    setCurrentPage(1);
    fetchLogs(1, newSize);
  };

  // Render pagination buttons (max 5 visible numbered buttons around current page)
  const renderPaginationButtons = () => {
    if (totalPages <= 1) return null;

    const buttons: React.ReactNode[] = [];
    let startPage = Math.max(1, currentPage - 2);
    let endPage = Math.min(totalPages, startPage + 4);
    if (endPage - startPage < 4) {
      startPage = Math.max(1, endPage - 4);
    }

    for (let p = startPage; p <= endPage; p++) {
      buttons.push(
        <button
          key={p}
          onClick={() => goToPage(p)}
          disabled={loading}
          style={p === currentPage ? activeBtnStyle : btnStyle}
        >
          {p}
        </button>
      );
    }

    return buttons;
  };

  const startRecordIndex = totalCount === 0 ? 0 : (currentPage - 1) * pageSize + 1;
  const endRecordIndex = totalCount === 0 ? 0 : Math.min(currentPage * pageSize, totalCount);

  return (
    <div style={{ padding: '16px', fontFamily: 'system-ui, -apple-system, sans-serif', color: '#24292f' }}>
      {/* Top Header & Secret Input Bar */}
      <div
        style={{
          marginBottom: '14px',
          padding: '12px 16px',
          backgroundColor: '#f6f8fa',
          border: '1px solid #d0d7de',
          borderRadius: '8px',
          display: 'flex',
          gap: '12px',
          alignItems: 'center',
          flexWrap: 'wrap',
          justifyContent: 'space-between',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <strong style={{ fontSize: '15px' }}>Bitácora del Sistema (service_logs)</strong>
          <span
            style={{
              backgroundColor: '#ddf4ff',
              color: '#0969da',
              border: '1px solid #54aeff66',
              padding: '2px 8px',
              borderRadius: '12px',
              fontSize: '11px',
              fontWeight: 600,
            }}
          >
            {totalCount} eventos en total
          </span>
        </div>

        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            type="password"
            placeholder="ADMIN_API_SECRET..."
            value={adminSecret}
            onChange={(e) => setAdminSecret(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                setCurrentPage(1);
                fetchLogs(1, pageSize);
              }
            }}
            style={{
              padding: '6px 10px',
              borderRadius: '6px',
              border: '1px solid #d0d7de',
              fontSize: '12px',
              minWidth: '220px',
            }}
          />
          <button
            onClick={() => {
              setCurrentPage(1);
              fetchLogs(1, pageSize);
            }}
            disabled={loading || !adminSecret.trim()}
            style={{ ...btnStyle, backgroundColor: '#1f883d', color: '#fff', borderColor: '#1f883d', fontWeight: 600 }}
          >
            {loading ? 'Cargando...' : 'Consultar / Refrescar'}
          </button>
        </div>
      </div>

      {/* Auth message / status bar */}
      <div style={{ marginBottom: '12px', fontSize: '12px', color: '#57606a', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
        <span>{authMessage}</span>
        {totalCount > 0 && (
          <span>
            Mostrando registros <strong>{startRecordIndex}</strong> - <strong>{endRecordIndex}</strong> de <strong>{totalCount}</strong> (ordenados del más reciente al más antiguo)
          </span>
        )}
      </div>

      {/* Main Table */}
      <div style={{ overflowX: 'auto', border: '1px solid #d0d7de', borderRadius: '6px', backgroundColor: '#ffffff', maxHeight: '72vh' }}>
        <table
          style={{
            width: '100%',
            borderCollapse: 'collapse',
            fontSize: '12px',
            textAlign: 'left',
          }}
        >
          <thead>
            <tr>
              <th style={headerCellStyle}>ID</th>
              <th style={headerCellStyle}>Timestamp (UTC)</th>
              <th style={headerCellStyle}>Método</th>
              <th style={headerCellStyle}>Acción</th>
              <th style={headerCellStyle}>Estado</th>
              <th style={headerCellStyle}>Ticket ID</th>
              <th style={headerCellStyle}>Archivo</th>
              <th style={headerCellStyle}>Ext</th>
              <th style={headerCellStyle}>MIME</th>
              <th style={headerCellStyle}>Bytes</th>
              <th style={headerCellStyle}>Visibilidad</th>
              <th style={headerCellStyle}>Usuario</th>
              <th style={headerCellStyle}>Organización</th>
              <th style={headerCellStyle}>IP Origen</th>
              <th style={headerCellStyle}>Detalle / Mensaje</th>
            </tr>
          </thead>
          <tbody>
            {logs.length === 0 ? (
              <tr>
                <td colSpan={15} style={{ ...cellStyle, textAlign: 'center', padding: '36px', color: '#57606a' }}>
                  {loading ? 'Cargando registros desde Supabase...' : 'No hay registros cargados. Ingresa tu ADMIN_API_SECRET y haz clic en "Consultar / Refrescar".'}
                </td>
              </tr>
            ) : (
              logs.map((log, index) => {
                const details = log.details || {};
                const method = log.method || details.method || '-';
                const ticketId = log.ticketId || details.ticketId || '-';
                const userId = log.userId || details.userId || '';
                const userName = log.userName || details.userName || (userId ? `User: ${userId.slice(0, 8)}...` : '-');
                const orgId = log.orgId || details.orgId || '';
                const orgName = log.orgName || details.orgName || details.orgNombre || (orgId ? `Org: ${orgId.slice(0, 8)}...` : '-');
                const fileName = log.fileName || details.fileName || details.archivo || '-';
                const extension = log.extension || details.extension || '-';
                const mimeType = log.mimeType || details.mimeType || '-';
                const fileSize = log.fileSize ?? details.fileSize ?? '-';
                const visibility = log.visibility || details.visibility || '-';
                const ipAddress = log.ipAddress || details.ip || details.ipAddress || '-';
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
                      backgroundColor: index % 2 === 0 ? '#ffffff' : '#f6f8fa',
                    }}
                  >
                    <td style={{ ...cellStyle, fontWeight: 700, color: '#0969da', whiteSpace: 'nowrap' }}>#{log.id}</td>
                    <td style={{ ...cellStyle, whiteSpace: 'nowrap', color: '#57606a' }}>
                      {log.timestamp ? new Date(log.timestamp).toLocaleString('es-MX', { timeZone: 'UTC', hour12: false }) + ' UTC' : '-'}
                    </td>
                    <td style={{ ...cellStyle, fontWeight: 600 }}>{method}</td>
                    <td style={{ ...cellStyle, whiteSpace: 'nowrap', fontWeight: 600 }}>{log.action}</td>
                    <td style={cellStyle}>
                      <span style={getStatusBadgeStyle(log.status)}>{log.status}</span>
                    </td>
                    <td style={{ ...cellStyle, fontFamily: 'monospace', fontSize: '11px' }}>
                      {ticketId !== '-' ? `${ticketId.slice(0, 8)}...` : '-'}
                    </td>
                    <td style={{ ...cellStyle, maxWidth: '160px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={String(fileName)}>
                      {fileName}
                    </td>
                    <td style={cellStyle}>{extension}</td>
                    <td style={{ ...cellStyle, maxWidth: '120px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{mimeType}</td>
                    <td style={{ ...cellStyle, textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {typeof fileSize === 'number' ? fileSize.toLocaleString() : fileSize}
                    </td>
                    <td style={cellStyle}>{visibility}</td>
                    <td style={{ ...cellStyle, whiteSpace: 'nowrap' }} title={userId}>
                      {userName}
                    </td>
                    <td style={{ ...cellStyle, whiteSpace: 'nowrap' }} title={orgId}>
                      {orgName}
                    </td>
                    <td style={{ ...cellStyle, whiteSpace: 'nowrap', fontFamily: 'monospace', fontSize: '11px' }}>{ipAddress}</td>
                    <td style={{ ...cellStyle, maxWidth: '280px', color: '#57606a' }} title={String(message)}>
                      {message}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Bottom Pagination Bar */}
      <div
        style={{
          marginTop: '12px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '12px',
          padding: '8px 4px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: '#57606a' }}>
          <span>Filas por página:</span>
          <select
            value={pageSize}
            onChange={handlePageSizeChange}
            disabled={loading}
            style={{
              padding: '4px 8px',
              borderRadius: '6px',
              border: '1px solid #d0d7de',
              fontSize: '12px',
              backgroundColor: '#fff',
            }}
          >
            <option value={10}>10</option>
            <option value={20}>20</option>
            <option value={50}>50</option>
            <option value={100}>100</option>
          </select>
          <span>
            Página <strong>{currentPage}</strong> de <strong>{totalPages}</strong>
          </span>
        </div>

        <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
          <button
            onClick={() => goToPage(1)}
            disabled={loading || currentPage <= 1}
            style={currentPage <= 1 || loading ? disabledBtnStyle : btnStyle}
            title="Primera página"
          >
            « Primera
          </button>
          <button
            onClick={() => goToPage(currentPage - 1)}
            disabled={loading || currentPage <= 1}
            style={currentPage <= 1 || loading ? disabledBtnStyle : btnStyle}
            title="Página anterior"
          >
            ‹ Anterior
          </button>

          {renderPaginationButtons()}

          <button
            onClick={() => goToPage(currentPage + 1)}
            disabled={loading || currentPage >= totalPages}
            style={currentPage >= totalPages || loading ? disabledBtnStyle : btnStyle}
            title="Página siguiente"
          >
            Siguiente ›
          </button>
          <button
            onClick={() => goToPage(totalPages)}
            disabled={loading || currentPage >= totalPages}
            style={currentPage >= totalPages || loading ? disabledBtnStyle : btnStyle}
            title="Última página"
          >
            Última »
          </button>
        </div>
      </div>
    </div>
  );
}
