import { drizzle, PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

export * from './schema';

declare global {
  // eslint-disable-next-line no-var
  var _drizzleDb: PostgresJsDatabase<typeof schema> | undefined;
  // eslint-disable-next-line no-var
  var _postgresClient: postgres.Sql | undefined;
}

function getDatabaseUrl(): string | null {
  const raw =
    process.env.DATABASE_URL?.trim() ||
    process.env.POSTGRES_URL?.trim() ||
    process.env.DIRECT_URL?.trim() ||
    null;

  if (!raw) return null;

  // Safeguard: PostgreSQL Supavisor port 6543 can timeout on TLS startup in serverless;
  // session mode on port 5432 over the IPv4 pooler negotiates TLS immediately.
  return raw.replace(/(\.pooler\.pgClient\.com):6543\b/, '$1:5432');
}

export function isDirectDatabaseConfigured(): boolean {
  return Boolean(getDatabaseUrl());
}

/**
 * Initializes and returns the global Drizzle ORM instance connected directly
 * to PostgreSQL without any proprietary cloud SDK.
 */
export function getDb(): PostgresJsDatabase<typeof schema> {
  if (globalThis._drizzleDb) {
    return globalThis._drizzleDb;
  }

  const connectionString = getDatabaseUrl();

  if (!connectionString) {
    throw new Error(
      '[DATABASE_NOT_CONFIGURED] La variable DATABASE_URL no está definida en el entorno. ' +
      'Configura DATABASE_URL=postgresql://postgres:[PASSWORD]@[HOST]:[PORT]/[DB] para conectar directamente.'
    );
  }

  // Configuration tuned for serverless environments (compatible with PgBouncer / Supavisor pooler)
  const client = postgres(connectionString, {
    max: process.env.NODE_ENV === 'production' ? 10 : 3,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false, // Critical for connection poolers (port 6543)
  });

  const dbInstance = drizzle(client, { schema });

  globalThis._postgresClient = client;
  globalThis._drizzleDb = dbInstance;

  return dbInstance;
}

/**
 * Direct proxy for effortless query calls:
 * e.g. await db.select().from(files)...
 */
export const db = new Proxy({} as PostgresJsDatabase<typeof schema>, {
  get(_target, prop, receiver) {
    const instance = getDb();
    const value = Reflect.get(instance, prop, receiver);
    return typeof value === 'function' ? value.bind(instance) : value;
  },
});
