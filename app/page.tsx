'use client';

import React, { useState, useEffect } from 'react';

interface ServiceLog {
  id: string;
  timestamp: string;
  accion: string;
  estado: 'PERMITIDO' | 'DENEGADO_NO_REGISTRADO' | 'DENEGADO_OTRA_ORG' | 'DENEGADO_SIN_PERMISO' | 'SUBIDO_LANDING';
  userId?: string;
  userName?: string;
  orgId?: string;
  orgNombre?: string;
  targetOrgId?: string;
  detalles: any;
}

interface ArchivoRecord {
  id: string;
  ticket_id: string;
  user_name: string;
  nombre_original: string;
  tamano_bytes: number;
  tipo_recurso: string;
  visibilidad: string;
  estado: string;
  s3_key_procesado: string;
  created_at: string;
}

export default function ServiceLogsPage() {
  const [logs, setLogs] = useState<ServiceLog[]>([]);
  const [archivos, setArchivos] = useState<ArchivoRecord[]>([]);
  const [activeTab, setActiveTab] = useState<'LOGS' | 'ARCHIVOS'>('LOGS');
  const [filter, setFilter] = useState<'ALL' | 'PERMITIDO' | 'DENEGADO'>('ALL');
  const [loading, setLoading] = useState<boolean>(true);
  const [lastUpdated, setLastUpdated] = useState<string>('');

  const fetchData = async () => {
    try {
      setLoading(true);
      // 1. Logs de servicio desde Supabase
      const resLogs = await fetch('/api/logs');
      if (resLogs.ok) {
        const dataLogs = await resLogs.json();
        setLogs(dataLogs.logs || []);
      }

      // 2. Archivos desde Supabase
      const resArchivos = await fetch('/api/records');
      if (resArchivos.ok) {
        const dataArchivos = await resArchivos.json();
        setArchivos(dataArchivos.records || []);
      }

      setLastUpdated(new Date().toLocaleTimeString());
    } catch (err) {
      console.error('Error fetching data:', err);
    } finally {
      setLoading(false);
    }
  };

  const clearData = async () => {
    const target = activeTab === 'LOGS' ? 'los logs de servicio' : 'los registros de archivos';
    if (!confirm(`¿Deseas reiniciar ${target} en Supabase?`)) return;
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
    const interval = setInterval(fetchData, 4000); // Polling cada 4s
    return () => clearInterval(interval);
  }, []);

  const filteredLogs = logs.filter((l) => {
    if (filter === 'ALL') return true;
    if (filter === 'PERMITIDO') return l.estado === 'PERMITIDO' || l.estado === 'SUBIDO_LANDING';
    if (filter === 'DENEGADO') return l.estado.startsWith('DENEGADO');
    return true;
  });

  const getStatusBadge = (estado: string) => {
    switch (estado) {
      case 'PERMITIDO':
        return <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">PERMITIDO</span>;
      case 'SUBIDO_LANDING':
      case 'completado':
        return <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-cyan-500/10 text-cyan-400 border border-cyan-500/30">COMPLETADO</span>;
      case 'pendiente_subida':
        return <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-500/10 text-amber-400 border border-amber-500/30">PENDIENTE</span>;
      case 'DENEGADO_OTRA_ORG':
        return <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-rose-500/20 text-rose-400 border border-rose-500/40">VIOLACIÓN MULTI-TENANT</span>;
      case 'DENEGADO_SIN_PERMISO':
        return <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-500/20 text-amber-400 border border-amber-500/40">SIN PERMISOS</span>;
      case 'DENEGADO_NO_REGISTRADO':
        return <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-red-500/20 text-red-400 border border-red-500/40">NO REGISTRADO</span>;
      default:
        return <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-slate-700 text-slate-300">{estado}</span>;
    }
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
              Monitor de Base de Datos y Logs en Supabase
            </h1>
            <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
              🟢 Conectado a Supabase
            </span>
          </div>
          <p className="text-xs text-slate-400 mt-1">
            Persistencia activa en las tablas <code>logs_servicio</code> y <code>archivos</code> de PostgreSQL en Supabase.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={fetchData}
            disabled={loading}
            className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs text-slate-200 border border-slate-700 transition flex items-center gap-1.5"
          >
            <i className={`fa-solid fa-arrows-rotate ${loading ? 'fa-spin' : ''}`}></i>
            Actualizar
          </button>
          <button
            onClick={clearData}
            className="px-3 py-1.5 rounded-lg bg-rose-950/40 hover:bg-rose-900/60 text-xs text-rose-300 border border-rose-800/50 transition flex items-center gap-1.5"
          >
            <i className="fa-solid fa-trash-can"></i>
            Limpiar {activeTab === 'LOGS' ? 'Logs' : 'Archivos'}
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
          Tabla &apos;logs_servicio&apos; ({logs.length})
        </button>
        <button
          onClick={() => setActiveTab('ARCHIVOS')}
          className={`px-4 py-2 rounded-xl text-xs font-bold transition flex items-center gap-2 ${
            activeTab === 'ARCHIVOS'
              ? 'bg-emerald-600 text-white shadow-lg shadow-emerald-600/20'
              : 'bg-slate-900 text-slate-400 hover:text-slate-200'
          }`}
        >
          <i className="fa-solid fa-database"></i>
          Tabla &apos;archivos&apos; ({archivos.length})
        </button>
      </div>

      {/* VISTA 1: TABLA LOGS_SERVICIO */}
      {activeTab === 'LOGS' && (
        <section className="space-y-4">
          {/* Métricas Rápidas */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-4">
              <span className="text-xs text-slate-400 uppercase font-mono">Total Logs</span>
              <p className="text-2xl font-bold text-white mt-1">{logs.length}</p>
            </div>
            <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-4">
              <span className="text-xs text-emerald-400 uppercase font-mono">Permitidos</span>
              <p className="text-2xl font-bold text-emerald-400 mt-1">
                {logs.filter((l) => l.estado === 'PERMITIDO' || l.estado === 'SUBIDO_LANDING').length}
              </p>
            </div>
            <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-4">
              <span className="text-xs text-rose-400 uppercase font-mono">Denegados / Ataques</span>
              <p className="text-2xl font-bold text-rose-400 mt-1">
                {logs.filter((l) => l.estado.startsWith('DENEGADO')).length}
              </p>
            </div>
            <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-4 flex flex-col justify-between">
              <span className="text-xs text-slate-400 font-mono">Filtro:</span>
              <div className="flex items-center gap-1 mt-1 text-xs">
                <button
                  onClick={() => setFilter('ALL')}
                  className={`px-2.5 py-1 rounded transition ${filter === 'ALL' ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-400'}`}
                >
                  Todos
                </button>
                <button
                  onClick={() => setFilter('PERMITIDO')}
                  className={`px-2.5 py-1 rounded transition ${filter === 'PERMITIDO' ? 'bg-emerald-600 text-white' : 'bg-slate-800 text-slate-400'}`}
                >
                  Éxitos
                </button>
                <button
                  onClick={() => setFilter('DENEGADO')}
                  className={`px-2.5 py-1 rounded transition ${filter === 'DENEGADO' ? 'bg-rose-600 text-white' : 'bg-slate-800 text-slate-400'}`}
                >
                  Denegados
                </button>
              </div>
            </div>
          </div>

          {/* Tabla de Logs */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl shadow-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs font-mono">
                <thead className="bg-slate-950/70 text-slate-400 uppercase text-[10px] border-b border-slate-800">
                  <tr>
                    <th className="py-2.5 px-4">Hora</th>
                    <th className="py-2.5 px-4">Acción</th>
                    <th className="py-2.5 px-4">Estado</th>
                    <th className="py-2.5 px-4">Usuario</th>
                    <th className="py-2.5 px-4">Organización</th>
                    <th className="py-2.5 px-4">Detalles</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60 text-slate-300">
                  {filteredLogs.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="py-8 text-center text-slate-500 italic">
                        No hay logs en la tabla &apos;logs_servicio&apos; de Supabase.
                      </td>
                    </tr>
                  ) : (
                    filteredLogs.map((log) => {
                      const time = new Date(log.timestamp).toLocaleTimeString();
                      const isDeny = log.estado.startsWith('DENEGADO');
                      return (
                        <tr key={log.id} className={`hover:bg-slate-800/40 transition ${isDeny ? 'bg-rose-950/10' : ''}`}>
                          <td className="py-3 px-4 text-slate-400 whitespace-nowrap">{time}</td>
                          <td className="py-3 px-4 font-bold text-slate-200">{log.accion}</td>
                          <td className="py-3 px-4">{getStatusBadge(log.estado)}</td>
                          <td className="py-3 px-4 text-indigo-300 font-medium">{log.userName || log.userId || '--'}</td>
                          <td className="py-3 px-4 text-slate-300">{log.orgNombre || log.orgId || '--'}</td>
                          <td className="py-3 px-4 text-slate-400 max-w-md">
                            {log.detalles?.alerta && (
                              <div className="text-rose-400 font-bold text-[11px] mb-0.5">⚠️ {log.detalles.alerta}</div>
                            )}
                            {log.detalles?.motivo && <div className="text-amber-300 text-[11px]">{log.detalles.motivo}</div>}
                            {log.detalles?.s3Permanente && (
                              <div className="text-cyan-400 text-[10px] truncate" title={log.detalles.s3Permanente}>
                                ➔ {log.detalles.s3Permanente}
                              </div>
                            )}
                            {log.detalles?.mensaje && !log.detalles?.s3Permanente && (
                              <div className="text-[11px]">{log.detalles.mensaje}</div>
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

      {/* VISTA 2: TABLA ARCHIVOS */}
      {activeTab === 'ARCHIVOS' && (
        <section className="space-y-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl shadow-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs font-mono">
                <thead className="bg-slate-950/70 text-slate-400 uppercase text-[10px] border-b border-slate-800">
                  <tr>
                    <th className="py-2.5 px-4">Nombre Original</th>
                    <th className="py-2.5 px-4">Usuario</th>
                    <th className="py-2.5 px-4">Estado</th>
                    <th className="py-2.5 px-4">Tipo / Acceso</th>
                    <th className="py-2.5 px-4">Tamaño</th>
                    <th className="py-2.5 px-4">Ruta S3 en BD</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60 text-slate-300">
                  {archivos.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="py-8 text-center text-slate-500 italic">
                        No hay archivos registrados aún en la tabla &apos;archivos&apos; de Supabase.
                      </td>
                    </tr>
                  ) : (
                    archivos.map((file) => (
                      <tr key={file.id} className="hover:bg-slate-800/40 transition">
                        <td className="py-3 px-4 font-bold text-slate-200">{file.nombre_original}</td>
                        <td className="py-3 px-4 text-indigo-300">{file.user_name || '--'}</td>
                        <td className="py-3 px-4">{getStatusBadge(file.estado)}</td>
                        <td className="py-3 px-4 text-slate-400">{file.tipo_recurso} ({file.visibilidad})</td>
                        <td className="py-3 px-4 text-slate-400">{(file.tamano_bytes / 1024).toFixed(1)} KB</td>
                        <td className="py-3 px-4 text-cyan-400 truncate max-w-xs" title={file.s3_key_procesado}>
                          {file.s3_key_procesado || '--'}
                        </td>
                      </tr>
                    ))
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
