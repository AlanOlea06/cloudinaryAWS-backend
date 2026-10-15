'use client';

import React, { useState, useEffect } from 'react';

interface ServiceLog {
  id: string;
  timestamp: string;
  action: string;
  status: string;
  userId?: string;
  userName?: string;
  orgId?: string;
  orgName?: string;
  targetOrgId?: string;
  details: any;
}

interface FileRecord {
  id: string;
  ticket_id: string;
  userName?: string;
  user_name?: string;
  fileName?: string;
  nombre_original?: string;
  sizeBytes?: number;
  tamano_bytes?: number;
  resource_type?: string;
  tipo_recurso?: string;
  visibility?: string;
  visibilidad?: string;
  status?: string;
  estado?: string;
  s3_processed_key?: string;
  s3_key_procesado?: string;
  created_at: string;
}

export default function ServiceLogsPage() {
  const [logs, setLogs] = useState<ServiceLog[]>([]);
  const [files, setFiles] = useState<FileRecord[]>([]);
  const [activeTab, setActiveTab] = useState<'LOGS' | 'FILES'>('LOGS');
  const [filter, setFilter] = useState<'ALL' | 'ALLOWED' | 'DENIED'>('ALL');
  const [loading, setLoading] = useState<boolean>(true);
  const [lastUpdated, setLastUpdated] = useState<string>('');

  const fetchData = async () => {
    try {
      setLoading(true);
      // 1. Audit logs from Supabase
      const resLogs = await fetch('/api/logs');
      if (resLogs.ok) {
        const dataLogs = await resLogs.json();
        setLogs(dataLogs.logs || []);
      }

      // 2. Files from Supabase
      const resFiles = await fetch('/api/records');
      if (resFiles.ok) {
        const dataFiles = await resFiles.json();
        setFiles(dataFiles.records || []);
      }

      setLastUpdated(new Date().toLocaleTimeString());
    } catch (err) {
      console.error('Error fetching data:', err);
    } finally {
      setLoading(false);
    }
  };

  const clearData = async () => {
    const target = activeTab === 'LOGS' ? 'service logs' : 'file records';
    if (!confirm(`Do you want to clear ${target} in Supabase?`)) return;
    try {
      const url = activeTab === 'LOGS' ? '/api/logs' : '/api/records';
      await fetch(url, { method: 'DELETE' });
      fetchData();
    } catch (err) {
      console.error('Error clearing data:', err);
    }
  };

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 4000); // Polling every 4s
    return () => clearInterval(interval);
  }, []);

  const filteredLogs = logs.filter((l) => {
    const status = l.status || (l as any).estado || '';
    if (filter === 'ALL') return true;
    if (filter === 'ALLOWED') return status === 'ALLOWED' || status === 'PERMITIDO' || status === 'UPLOADED_LANDING' || status === 'SUBIDO_LANDING';
    if (filter === 'DENIED') return status.startsWith('DENIED') || status.startsWith('DENEGADO');
    return true;
  });

  const getStatusBadge = (statusInput: string) => {
    const status = statusInput?.toUpperCase() || '';
    if (status === 'ALLOWED' || status === 'PERMITIDO') {
      return <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">ALLOWED</span>;
    }
    if (status === 'COMPLETED' || status === 'UPLOADED_LANDING' || status === 'SUBIDO_LANDING' || status === 'COMPLETADO') {
      return <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-cyan-500/10 text-cyan-400 border border-cyan-500/30">COMPLETED</span>;
    }
    if (status === 'PENDING' || status === 'PENDING_UPLOAD' || status === 'PENDIENTE_SUBIDA') {
      return <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-500/10 text-amber-400 border border-amber-500/30">PENDING</span>;
    }
    if (status.includes('CROSS_ORG') || status.includes('OTRA_ORG')) {
      return <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-rose-500/20 text-rose-400 border border-rose-500/40">MULTI-TENANT VIOLATION</span>;
    }
    if (status.includes('PERMISSION') || status.includes('PERMISOS')) {
      return <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-500/20 text-amber-400 border border-amber-500/40">NO PERMISSION</span>;
    }
    if (status.includes('NOT_REGISTERED') || status.includes('NO_REGISTRADO')) {
      return <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-red-500/20 text-red-400 border border-red-500/40">NOT REGISTERED</span>;
    }
    return <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-slate-700 text-slate-300">{statusInput}</span>;
  };

  return (
    <main className="max-w-6xl mx-auto p-4 md:p-8 space-y-6">
      {/* Header */}
      <header className="border-b border-slate-800 pb-5 flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400">
              <i className="fa-solid fa-server"></i>
            </div>
            <h1 className="text-xl font-bold text-white tracking-tight">
              Supabase Database & Service Logs Monitor
            </h1>
            <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
              🟢 Connected to Supabase
            </span>
          </div>
          <p className="text-xs text-slate-400 mt-1">
            Real-time persistence in PostgreSQL tables <code>service_logs</code> and <code>files</code>.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={fetchData}
            disabled={loading}
            className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs text-slate-200 border border-slate-700 transition flex items-center gap-1.5"
          >
            <i className={`fa-solid fa-arrows-rotate ${loading ? 'fa-spin' : ''}`}></i>
            Refresh
          </button>
          <button
            onClick={clearData}
            className="px-3 py-1.5 rounded-lg bg-rose-950/40 hover:bg-rose-900/60 text-xs text-rose-300 border border-rose-800/50 transition flex items-center gap-1.5"
          >
            <i className="fa-solid fa-trash-can"></i>
            Clear {activeTab === 'LOGS' ? 'Logs' : 'Files'}
          </button>
        </div>
      </header>

      {/* Tabs Selector */}
      <div className="flex items-center gap-3 border-b border-slate-800 pb-2">
        <button
          onClick={() => setActiveTab('LOGS')}
          className={`px-4 py-2 rounded-xl text-xs font-bold transition flex items-center gap-2 ${
            activeTab === 'LOGS'
              ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/20'
              : 'bg-slate-900 text-slate-400 hover:text-slate-200'
          }`}
        >
          <i className="fa-solid fa-list-check"></i>
          &apos;service_logs&apos; Table ({logs.length})
        </button>
        <button
          onClick={() => setActiveTab('FILES')}
          className={`px-4 py-2 rounded-xl text-xs font-bold transition flex items-center gap-2 ${
            activeTab === 'FILES'
              ? 'bg-emerald-600 text-white shadow-lg shadow-emerald-600/20'
              : 'bg-slate-900 text-slate-400 hover:text-slate-200'
          }`}
        >
          <i className="fa-solid fa-database"></i>
          &apos;files&apos; Table ({files.length})
        </button>
      </div>

      {/* VIEW 1: SERVICE_LOGS TABLE */}
      {activeTab === 'LOGS' && (
        <section className="space-y-4">
          {/* Quick Metrics */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-4">
              <span className="text-xs text-slate-400 uppercase font-mono">Total Logs</span>
              <p className="text-2xl font-bold text-white mt-1">{logs.length}</p>
            </div>
            <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-4">
              <span className="text-xs text-emerald-400 uppercase font-mono">Allowed</span>
              <p className="text-2xl font-bold text-emerald-400 mt-1">
                {logs.filter((l) => (l.status || (l as any).estado) === 'ALLOWED' || (l.status || (l as any).estado) === 'PERMITIDO').length}
              </p>
            </div>
            <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-4">
              <span className="text-xs text-rose-400 uppercase font-mono">Denied / Violations</span>
              <p className="text-2xl font-bold text-rose-400 mt-1">
                {logs.filter((l) => ((l.status || (l as any).estado) || '').startsWith('DENIED') || ((l.status || (l as any).estado) || '').startsWith('DENEGADO')).length}
              </p>
            </div>
            <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-4 flex flex-col justify-between">
              <span className="text-xs text-slate-400 font-mono">Filter:</span>
              <div className="flex items-center gap-1 mt-1 text-xs">
                <button
                  onClick={() => setFilter('ALL')}
                  className={`px-2.5 py-1 rounded transition ${filter === 'ALL' ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-400'}`}
                >
                  All
                </button>
                <button
                  onClick={() => setFilter('ALLOWED')}
                  className={`px-2.5 py-1 rounded transition ${filter === 'ALLOWED' ? 'bg-emerald-600 text-white' : 'bg-slate-800 text-slate-400'}`}
                >
                  Allowed
                </button>
                <button
                  onClick={() => setFilter('DENIED')}
                  className={`px-2.5 py-1 rounded transition ${filter === 'DENIED' ? 'bg-rose-600 text-white' : 'bg-slate-800 text-slate-400'}`}
                >
                  Denied
                </button>
              </div>
            </div>
          </div>

          {/* Logs Table */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl shadow-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs font-mono">
                <thead className="bg-slate-950/70 text-slate-400 uppercase text-[10px] border-b border-slate-800">
                  <tr>
                    <th className="py-2.5 px-4">Time</th>
                    <th className="py-2.5 px-4">Action</th>
                    <th className="py-2.5 px-4">Status</th>
                    <th className="py-2.5 px-4">User</th>
                    <th className="py-2.5 px-4">Organization</th>
                    <th className="py-2.5 px-4">Details</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60 text-slate-300">
                  {filteredLogs.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="py-8 text-center text-slate-500 italic">
                        No logs recorded yet in Supabase.
                      </td>
                    </tr>
                  ) : (
                    filteredLogs.map((log) => {
                      const time = new Date(log.timestamp).toLocaleTimeString();
                      const status = log.status || (log as any).estado || '';
                      const isDeny = status.startsWith('DENIED') || status.startsWith('DENEGADO');
                      const details = log.details || (log as any).detalles || {};
                      const action = log.action || (log as any).accion || '--';

                      return (
                        <tr key={log.id} className={`hover:bg-slate-800/40 transition ${isDeny ? 'bg-rose-950/10' : ''}`}>
                          <td className="py-3 px-4 text-slate-400 whitespace-nowrap">{time}</td>
                          <td className="py-3 px-4 font-bold text-slate-200">{action}</td>
                          <td className="py-3 px-4">{getStatusBadge(status)}</td>
                          <td className="py-3 px-4 text-indigo-300 font-medium">{log.userName || log.userId || '--'}</td>
                          <td className="py-3 px-4 text-slate-300">{log.orgName || (log as any).orgNombre || log.orgId || '--'}</td>
                          <td className="py-3 px-4 text-slate-400 max-w-md">
                            {details.alert && (
                              <div className="text-rose-400 font-bold text-[11px] mb-0.5">⚠️ {details.alert}</div>
                            )}
                            {details.reason && <div className="text-amber-300 text-[11px]">{details.reason}</div>}
                            {details.motivo && <div className="text-amber-300 text-[11px]">{details.motivo}</div>}
                            {(details.s3Permanent || details.s3Permanente) && (
                              <div className="text-cyan-400 text-[10px] truncate" title={details.s3Permanent || details.s3Permanente}>
                                ➔ {details.s3Permanent || details.s3Permanente}
                              </div>
                            )}
                            {details.message && !details.s3Permanent && !details.s3Permanente && (
                              <div className="text-[11px]">{details.message}</div>
                            )}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}

      {/* VIEW 2: FILES TABLE */}
      {activeTab === 'FILES' && (
        <section className="space-y-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl shadow-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs font-mono">
                <thead className="bg-slate-950/70 text-slate-400 uppercase text-[10px] border-b border-slate-800">
                  <tr>
                    <th className="py-2.5 px-4">Original Name</th>
                    <th className="py-2.5 px-4">User</th>
                    <th className="py-2.5 px-4">Status</th>
                    <th className="py-2.5 px-4">Type / Access</th>
                    <th className="py-2.5 px-4">Size</th>
                    <th className="py-2.5 px-4">S3 Key in DB</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60 text-slate-300">
                  {files.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="py-8 text-center text-slate-500 italic">
                        No files recorded yet in Supabase.
                      </td>
                    </tr>
                  ) : (
                    files.map((file) => {
                      const fileName = file.fileName || file.nombre_original || 'unknown';
                      const userName = file.userName || file.user_name || '--';
                      const status = file.status || file.estado || 'pending';
                      const sizeBytes = file.sizeBytes || file.tamano_bytes || 0;
                      const resourceType = file.resource_type || file.tipo_recurso || 'document';
                      const visibility = file.visibility || file.visibilidad || 'private';
                      const s3Key = file.s3_processed_key || file.s3_key_procesado || '--';

                      return (
                        <tr key={file.id} className="hover:bg-slate-800/40 transition">
                          <td className="py-3 px-4 font-bold text-slate-200">{fileName}</td>
                          <td className="py-3 px-4 text-indigo-300">{userName}</td>
                          <td className="py-3 px-4">{getStatusBadge(status)}</td>
                          <td className="py-3 px-4 text-slate-400">{resourceType} ({visibility})</td>
                          <td className="py-3 px-4 text-slate-400">{(sizeBytes / 1024).toFixed(1)} KB</td>
                          <td className="py-3 px-4 text-cyan-400 truncate max-w-xs" title={s3Key}>
                            {s3Key}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}
    </main>
  );
}
