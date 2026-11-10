import { pgClient } from '@/lib/postgres';
import { db, isDirectDatabaseConfigured, files, organizations, users, apiKeys } from '@/lib/db';
import { eq, and, desc, inArray, sql } from 'drizzle-orm';

/**
 * High-Level Data Access Layer (DAL) / Repository Layer
 * Seamlessly executes direct SQL queries via Drizzle ORM when DATABASE_URL is present,
 * and gracefully falls back to PostgreSQL PostgREST HTTP client otherwise.
 */

// ==============================================================================
// 1. FILES REPOSITORY
// ==============================================================================
export const filesDal = {
  async findById(id: string) {
    if (isDirectDatabaseConfigured()) {
      const [row] = await db.select().from(files).where(eq(files.id, id));
      return row || null;
    }
    const { data } = await pgClient.from('files').select('*').eq('id', id).maybeSingle();
    return data || null;
  },

  async findByTicketId(ticketId: string) {
    if (isDirectDatabaseConfigured()) {
      const [row] = await db.select().from(files).where(eq(files.ticket_id, ticketId));
      return row || null;
    }
    const { data } = await pgClient.from('files').select('*').eq('ticket_id', ticketId).maybeSingle();
    return data || null;
  },

  async create(payload: Record<string, any>) {
    if (isDirectDatabaseConfigured()) {
      const [inserted] = await db.insert(files).values({
        id: payload.id,
        ticket_id: payload.ticket_id,
        org_id: payload.org_id,
        user_id: payload.user_id,
        original_name: payload.original_name,
        extension: payload.extension || '',
        mime_type: payload.mime_type,
        size_bytes: payload.size_bytes,
        sha256_hash: payload.sha256_hash,
        sha256_verified: Boolean(payload.sha256_verified),
        resource_type: payload.resource_type,
        visibility: payload.visibility || 'private',
        s3_pending_key: payload.s3_pending_key,
        s3_processed_key: payload.s3_processed_key || null,
        s3_upload_id: payload.s3_upload_id || null,
        cloudfront_url: payload.cloudfront_url || null,
        status: payload.status || 'pending_upload',
        scan_status: payload.scan_status || 'not_scanned',
        error_message: payload.error_message || null,
        completed_at: payload.completed_at ? new Date(payload.completed_at) : null,
        created_at: payload.created_at ? new Date(payload.created_at) : new Date(),
        updated_at: payload.updated_at ? new Date(payload.updated_at) : new Date(),
      }).returning();
      return inserted;
    }
    const { data, error } = await pgClient.from('files').insert(payload).select().single();
    if (error) throw error;
    return data;
  },

  async updateById(id: string, updates: Record<string, any>) {
    const cleanUpdates = { ...updates };
    if (cleanUpdates.completed_at && typeof cleanUpdates.completed_at === 'string') {
      cleanUpdates.completed_at = new Date(cleanUpdates.completed_at);
    }
    if (cleanUpdates.updated_at && typeof cleanUpdates.updated_at === 'string') {
      cleanUpdates.updated_at = new Date(cleanUpdates.updated_at);
    }

    if (isDirectDatabaseConfigured()) {
      const [updated] = await db.update(files).set(cleanUpdates).where(eq(files.id, id)).returning();
      return updated || null;
    }
    const { data, error } = await pgClient.from('files').update(updates).eq('id', id).select().maybeSingle();
    if (error) throw error;
    return data;
  },

  async updateByTicketId(ticketId: string, updates: Record<string, any>) {
    const cleanUpdates = { ...updates };
    if (cleanUpdates.completed_at && typeof cleanUpdates.completed_at === 'string') {
      cleanUpdates.completed_at = new Date(cleanUpdates.completed_at);
    }
    if (cleanUpdates.updated_at && typeof cleanUpdates.updated_at === 'string') {
      cleanUpdates.updated_at = new Date(cleanUpdates.updated_at);
    }

    if (isDirectDatabaseConfigured()) {
      const [updated] = await db.update(files).set(cleanUpdates).where(eq(files.ticket_id, ticketId)).returning();
      return updated || null;
    }
    const { data, error } = await pgClient.from('files').update(updates).eq('ticket_id', ticketId).select().maybeSingle();
    if (error) throw error;
    return data;
  },

  async deleteById(id: string) {
    if (isDirectDatabaseConfigured()) {
      await db.delete(files).where(eq(files.id, id));
      return { ok: true };
    }
    const { error } = await pgClient.from('files').delete().eq('id', id);
    if (error) throw error;
    return { ok: true };
  },

  async listByOrg(orgId: string, options?: { limit?: number; offset?: number; status?: string }) {
    if (isDirectDatabaseConfigured()) {
      let q = db.select().from(files).where(eq(files.org_id, orgId)).orderBy(desc(files.created_at));
      if (options?.limit) q = q.limit(options.limit) as any;
      if (options?.offset) q = q.offset(options.offset) as any;
      return await q;
    }
    let query = pgClient.from('files').select('*').eq('org_id', orgId).order('created_at', { ascending: false });
    if (options?.limit) query = query.limit(options.limit);
    if (options?.offset) query = query.range(options.offset, options.offset + (options.limit || 20) - 1);
    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  },
};

// ==============================================================================
// 2. ORGANIZATIONS REPOSITORY
// ==============================================================================
export const organizationsDal = {
  async findById(id: string) {
    if (isDirectDatabaseConfigured()) {
      const [row] = await db.select().from(organizations).where(eq(organizations.id, id));
      return row || null;
    }
    const { data } = await pgClient.from('organizations').select('*').eq('id', id).maybeSingle();
    return data || null;
  },

  async findBySlug(slug: string) {
    if (isDirectDatabaseConfigured()) {
      const [row] = await db.select().from(organizations).where(eq(organizations.slug, slug));
      return row || null;
    }
    const { data } = await pgClient.from('organizations').select('*').eq('slug', slug).maybeSingle();
    return data || null;
  },

  async listAll() {
    if (isDirectDatabaseConfigured()) {
      return await db.select().from(organizations).orderBy(organizations.name);
    }
    const { data } = await pgClient.from('organizations').select('*').order('name', { ascending: true });
    return data || [];
  },

  async updateById(id: string, updates: Record<string, any>) {
    if (isDirectDatabaseConfigured()) {
      const [updated] = await db.update(organizations).set(updates).where(eq(organizations.id, id)).returning();
      return updated || null;
    }
    const { data, error } = await pgClient.from('organizations').update(updates).eq('id', id).select().maybeSingle();
    if (error) throw error;
    return data;
  },
};

// ==============================================================================
// 3. USERS REPOSITORY
// ==============================================================================
export const usersDal = {
  async findById(id: string) {
    if (isDirectDatabaseConfigured()) {
      const [row] = await db.select().from(users).where(eq(users.id, id));
      return row || null;
    }
    const { data } = await pgClient.from('users').select('*').eq('id', id).maybeSingle();
    return data || null;
  },

  async findByIds(ids: string[]) {
    if (ids.length === 0) return [];
    if (isDirectDatabaseConfigured()) {
      return await db.select().from(users).where(inArray(users.id, ids));
    }
    const { data } = await pgClient.from('users').select('*').in('id', ids);
    return data || [];
  },

  async findByEmail(email: string) {
    if (isDirectDatabaseConfigured()) {
      const [row] = await db.select().from(users).where(eq(users.email, email));
      return row || null;
    }
    const { data } = await pgClient.from('users').select('*').eq('email', email).maybeSingle();
    return data || null;
  },
};

// ==============================================================================
// 4. API KEYS REPOSITORY
// ==============================================================================
export const apiKeysDal = {
  async findByHash(keyHash: string) {
    if (isDirectDatabaseConfigured()) {
      const [row] = await db.select().from(apiKeys).where(eq(apiKeys.hashed_key, keyHash));
      return row || null;
    }
    const { data } = await pgClient.from('api_keys').select('*').eq('hashed_key', keyHash).maybeSingle();
    return data || null;
  },

  async findById(id: string) {
    if (isDirectDatabaseConfigured()) {
      const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, id));
      return row || null;
    }
    const { data } = await pgClient.from('api_keys').select('*').eq('id', id).maybeSingle();
    return data || null;
  },

  async countActiveByOrg(orgId: string) {
    if (isDirectDatabaseConfigured()) {
      const rows = await db.select().from(apiKeys).where(and(eq(apiKeys.org_id, orgId), eq(apiKeys.is_active, true)));
      return rows.length;
    }
    const { count } = await pgClient.from('api_keys').select('*', { count: 'exact', head: true }).eq('org_id', orgId).eq('is_active', true);
    return count || 0;
  },
};
