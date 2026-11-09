import { createClient, SupabaseClient } from '@supabase/supabase-js';
import postgres from 'postgres';
import { requireEnv } from '@/lib/env';

let cachedClient: SupabaseClient | null = null;
let cachedUrl: string | null = null;
let cachedKey: string | null = null;

declare global {
  // eslint-disable-next-line no-var
  var __directPgSql: postgres.Sql | undefined;
}

function getDirectDatabaseUrl(): string | null {
  const raw =
    process.env.DATABASE_URL?.trim() ||
    process.env.POSTGRES_URL?.trim() ||
    process.env.DIRECT_URL?.trim() ||
    null;

  if (!raw) return null;
  return raw.replace(/(\.pooler\.supabase\.com):6543\b/, '$1:5432');
}

export function getPostgresSql(): postgres.Sql | null {
  const connStr = getDirectDatabaseUrl();
  if (!connStr) return null;

  if (!globalThis.__directPgSql) {
    globalThis.__directPgSql = postgres(connStr, {
      max: process.env.NODE_ENV === 'production' ? 10 : 5,
      idle_timeout: 20,
      connect_timeout: 10,
      prepare: false,
    });
  }
  return globalThis.__directPgSql;
}

const SAFE_IDENT_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function quoteIdent(ident: string): string {
  const clean = ident.trim();
  if (!SAFE_IDENT_REGEX.test(clean)) {
    throw new Error(`Invalid SQL identifier: ${clean}`);
  }
  return `"${clean}"`;
}

function buildSelectList(columns: string): string {
  const trimmed = (columns || '*').trim();
  if (!trimmed || trimmed === '*') return '*';
  const parts = trimmed
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);
  if (parts.length === 0) return '*';
  return parts.map((col) => (col === '*' ? '*' : quoteIdent(col))).join(', ');
}

const NUMERIC_BIGINT_COLS = new Set(['size_bytes', 'max_storage_bytes', 'id']);

function normalizeRow(row: Record<string, any> | null | undefined): any {
  if (!row || typeof row !== 'object') return row;
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(row)) {
    if (typeof v === 'string' && NUMERIC_BIGINT_COLS.has(k) && /^-?\d+$/.test(v)) {
      const num = Number(v);
      out[k] = Number.isSafeInteger(num) ? num : v;
    } else if (v instanceof Date) {
      out[k] = v.toISOString();
    } else {
      out[k] = v;
    }
  }
  return out;
}

class DirectPostgresQueryBuilder implements PromiseLike<any> {
  private sql: postgres.Sql;
  private table: string;
  private op: 'select' | 'insert' | 'update' | 'delete' = 'select';
  private selectCols: string = '*';
  private returningCols: string | null = null;
  private countMode: string | null = null;
  private headOnly: boolean = false;
  private insertRows: Record<string, any>[] = [];
  private updateData: Record<string, any> = {};
  private whereClauses: Array<(paramOffset: number) => { clause: string; values: any[] }> = [];
  private orderClauses: string[] = [];
  private limitVal: number | null = null;
  private offsetVal: number | null = null;
  private singleMode: 'none' | 'single' | 'maybeSingle' = 'none';

  constructor(sql: postgres.Sql, table: string) {
    this.sql = sql;
    this.table = table;
  }

  select(columns: string = '*', options?: { count?: string; head?: boolean }) {
    if (this.op === 'select') {
      this.selectCols = columns || '*';
      if (options?.count) this.countMode = options.count;
      if (options?.head) this.headOnly = true;
    } else {
      this.returningCols = columns || '*';
    }
    return this;
  }

  insert(values: Record<string, any> | Record<string, any>[]) {
    this.op = 'insert';
    this.insertRows = Array.isArray(values) ? values : [values];
    return this;
  }

  update(values: Record<string, any>) {
    this.op = 'update';
    this.updateData = values || {};
    return this;
  }

  delete(options?: { count?: string }) {
    this.op = 'delete';
    if (options?.count) this.countMode = options.count;
    return this;
  }

  eq(column: string, value: any) {
    const col = quoteIdent(column);
    this.whereClauses.push((offset) => ({
      clause: `${col} = $${offset + 1}`,
      values: [value],
    }));
    return this;
  }

  neq(column: string, value: any) {
    const col = quoteIdent(column);
    this.whereClauses.push((offset) => ({
      clause: `${col} <> $${offset + 1}`,
      values: [value],
    }));
    return this;
  }

  gt(column: string, value: any) {
    const col = quoteIdent(column);
    this.whereClauses.push((offset) => ({
      clause: `${col} > $${offset + 1}`,
      values: [value],
    }));
    return this;
  }

  gte(column: string, value: any) {
    const col = quoteIdent(column);
    this.whereClauses.push((offset) => ({
      clause: `${col} >= $${offset + 1}`,
      values: [value],
    }));
    return this;
  }

  lt(column: string, value: any) {
    const col = quoteIdent(column);
    this.whereClauses.push((offset) => ({
      clause: `${col} < $${offset + 1}`,
      values: [value],
    }));
    return this;
  }

  lte(column: string, value: any) {
    const col = quoteIdent(column);
    this.whereClauses.push((offset) => ({
      clause: `${col} <= $${offset + 1}`,
      values: [value],
    }));
    return this;
  }

  in(column: string, values: any[]) {
    const col = quoteIdent(column);
    const list = Array.isArray(values) ? values : [];
    if (list.length === 0) {
      this.whereClauses.push(() => ({
        clause: '1 = 0',
        values: [],
      }));
      return this;
    }
    this.whereClauses.push((offset) => {
      const placeholders = list.map((_, idx) => `$${offset + idx + 1}`).join(', ');
      return {
        clause: `${col} IN (${placeholders})`,
        values: list,
      };
    });
    return this;
  }

  is(column: string, value: any) {
    const col = quoteIdent(column);
    if (value === null) {
      this.whereClauses.push(() => ({ clause: `${col} IS NULL`, values: [] }));
    } else if (value === true) {
      this.whereClauses.push(() => ({ clause: `${col} IS TRUE`, values: [] }));
    } else if (value === false) {
      this.whereClauses.push(() => ({ clause: `${col} IS FALSE`, values: [] }));
    }
    return this;
  }

  not(column: string, operator: string, value: any) {
    const col = quoteIdent(column);
    const op = operator.toLowerCase().trim();
    if (op === 'is' && value === null) {
      this.whereClauses.push(() => ({ clause: `${col} IS NOT NULL`, values: [] }));
    } else if (op === 'eq') {
      this.whereClauses.push((offset) => ({
        clause: `${col} <> $${offset + 1}`,
        values: [value],
      }));
    }
    return this;
  }

  order(column: string, options?: { ascending?: boolean }) {
    const col = quoteIdent(column);
    const dir = options?.ascending === false ? 'DESC' : 'ASC';
    this.orderClauses.push(`${col} ${dir}`);
    return this;
  }

  limit(count: number) {
    this.limitVal = Math.max(0, Number(count));
    return this;
  }

  range(from: number, to: number) {
    const start = Math.max(0, Number(from));
    const end = Math.max(start, Number(to));
    this.offsetVal = start;
    this.limitVal = end - start + 1;
    return this;
  }

  single() {
    this.singleMode = 'single';
    if (this.op === 'select' && this.limitVal === null) {
      this.limitVal = 1;
    }
    return this;
  }

  maybeSingle() {
    this.singleMode = 'maybeSingle';
    if (this.op === 'select' && this.limitVal === null) {
      this.limitVal = 1;
    }
    return this;
  }

  private buildWhere(initialParams: any[]): { whereSql: string; params: any[] } {
    const params = [...initialParams];
    if (this.whereClauses.length === 0) {
      return { whereSql: '', params };
    }
    const parts: string[] = [];
    for (const builder of this.whereClauses) {
      const { clause, values } = builder(params.length);
      parts.push(clause);
      params.push(...values);
    }
    return {
      whereSql: ` WHERE ${parts.join(' AND ')}`,
      params,
    };
  }

  async execute(): Promise<{ data: any; error: any; count?: number | null }> {
    const tableIdent = `public.${quoteIdent(this.table)}`;

    try {
      if (this.op === 'select') {
        const { whereSql, params } = this.buildWhere([]);

        let totalCount: number | null = null;
        if (this.countMode) {
          const countQuery = `SELECT COUNT(*)::int AS total FROM ${tableIdent}${whereSql}`;
          const countRes = await this.sql.unsafe(countQuery, params);
          totalCount = countRes?.[0]?.total ?? 0;
          if (this.headOnly) {
            return { data: null, error: null, count: totalCount };
          }
        }

        const colsSql = buildSelectList(this.selectCols);
        let query = `SELECT ${colsSql} FROM ${tableIdent}${whereSql}`;

        if (this.orderClauses.length > 0) {
          query += ` ORDER BY ${this.orderClauses.join(', ')}`;
        }
        if (this.limitVal !== null) {
          query += ` LIMIT ${this.limitVal}`;
        }
        if (this.offsetVal !== null) {
          query += ` OFFSET ${this.offsetVal}`;
        }

        const rows = (await this.sql.unsafe(query, params)).map(normalizeRow);

        if (this.singleMode === 'single') {
          if (rows.length === 0) {
            return {
              data: null,
              error: { message: 'JSON object requested, multiple (or no) rows returned', code: 'PGRST116' },
              count: totalCount,
            };
          }
          return { data: rows[0], error: null, count: totalCount };
        }

        if (this.singleMode === 'maybeSingle') {
          return { data: rows[0] ?? null, error: null, count: totalCount };
        }

        return { data: rows, error: null, count: totalCount };
      }

      if (this.op === 'insert') {
        if (this.insertRows.length === 0) {
          return { data: [], error: null };
        }
        const firstRow = this.insertRows[0];
        const colNames = Object.keys(firstRow).filter((k) => firstRow[k] !== undefined);
        const quotedCols = colNames.map(quoteIdent).join(', ');

        const params: any[] = [];
        const valueGroups: string[] = [];

        for (const row of this.insertRows) {
          const placeholders: string[] = [];
          for (const col of colNames) {
            params.push(row[col] === undefined ? null : row[col]);
            placeholders.push(`$${params.length}`);
          }
          valueGroups.push(`(${placeholders.join(', ')})`);
        }

        const returningSql = this.returningCols ? ` RETURNING ${buildSelectList(this.returningCols)}` : ' RETURNING *';
        const query = `INSERT INTO ${tableIdent} (${quotedCols}) VALUES ${valueGroups.join(', ')}${returningSql}`;
        const rows = (await this.sql.unsafe(query, params)).map(normalizeRow);

        if (this.singleMode === 'single' || this.singleMode === 'maybeSingle') {
          return { data: rows[0] ?? null, error: null };
        }
        return { data: rows, error: null };
      }

      if (this.op === 'update') {
        const entries = Object.entries(this.updateData).filter(([, v]) => v !== undefined);
        if (entries.length === 0) {
          return { data: null, error: null };
        }

        const params: any[] = [];
        const setParts: string[] = [];
        for (const [col, val] of entries) {
          params.push(val);
          setParts.push(`${quoteIdent(col)} = $${params.length}`);
        }

        const { whereSql, params: allParams } = this.buildWhere(params);
        const returningSql = this.returningCols ? ` RETURNING ${buildSelectList(this.returningCols)}` : ' RETURNING *';
        const query = `UPDATE ${tableIdent} SET ${setParts.join(', ')}${whereSql}${returningSql}`;
        const rows = (await this.sql.unsafe(query, allParams)).map(normalizeRow);

        if (this.singleMode === 'single' || this.singleMode === 'maybeSingle') {
          return { data: rows[0] ?? null, error: null };
        }
        return { data: rows, error: null };
      }

      if (this.op === 'delete') {
        const { whereSql, params } = this.buildWhere([]);
        const returningSql = this.returningCols ? ` RETURNING ${buildSelectList(this.returningCols)}` : ' RETURNING id';
        const query = `DELETE FROM ${tableIdent}${whereSql}${returningSql}`;
        const rows = (await this.sql.unsafe(query, params)).map(normalizeRow);

        return {
          data: rows,
          error: null,
          count: rows.length,
        };
      }

      return { data: null, error: null };
    } catch (err: any) {
      return {
        data: null,
        error: {
          message: err?.message || 'Database error',
          code: err?.code || 'DB_ERROR',
          details: err?.detail || null,
          hint: err?.hint || null,
        },
        count: null,
      };
    }
  }

  then<TResult1 = any, TResult2 = never>(
    onfulfilled?: ((value: { data: any; error: any; count?: number | null }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null
  ): PromiseLike<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }
}

export function getSupabaseUrl(): string {
  return requireEnv('SUPABASE_URL');
}

export function getSupabaseServiceRoleKey(): string {
  return requireEnv('SUPABASE_SERVICE_ROLE_KEY');
}

export function getSupabaseClient(): SupabaseClient {
  const url = getSupabaseUrl();
  const key = getSupabaseServiceRoleKey();

  if (!cachedClient || cachedUrl !== url || cachedKey !== key) {
    cachedClient = createClient(url, key, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
      global: {
        fetch: (fetchUrl, options = {}) =>
          fetch(fetchUrl, {
            ...options,
            cache: 'no-store',
          }),
      },
    });
    cachedUrl = url;
    cachedKey = key;
  }

  return cachedClient;
}

/**
 * Universal database client proxy:
 * - When DATABASE_URL is configured, executes queries directly against PostgreSQL via postgres.js.
 * - Falls back to @supabase/supabase-js HTTP client only if DATABASE_URL is absent.
 */
export const supabase: SupabaseClient = new Proxy({} as SupabaseClient, {
  get(_target, prop, _receiver) {
    const pgSql = getPostgresSql();
    if (pgSql) {
      if (prop === 'from') {
        return (table: string) => new DirectPostgresQueryBuilder(pgSql, table);
      }
      if (prop === 'rpc') {
        return async (fnName: string, args: Record<string, any> = {}) => {
          try {
            const entries = Object.entries(args);
            const params = entries.map(([, v]) => v);
            const namedArgs = entries
              .map(([k], idx) => `${quoteIdent(k)} := $${idx + 1}`)
              .join(', ');
            const query = `SELECT * FROM public.${quoteIdent(fnName)}(${namedArgs})`;
            const rows = await pgSql.unsafe(query, params);
            return { data: rows.map(normalizeRow), error: null };
          } catch (err: any) {
            return {
              data: null,
              error: {
                message: err?.message || 'RPC error',
                code: err?.code || 'RPC_ERROR',
              },
            };
          }
        };
      }
    }

    const client = getSupabaseClient();
    const value = (client as any)[prop];
    return typeof value === 'function' ? value.bind(client) : value;
  },
});
