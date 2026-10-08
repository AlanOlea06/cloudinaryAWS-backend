import { createClient } from '@supabase/supabase-js';
import { env } from './env.js';

// Cliente administrativo con service_role_key para inserciones autorizadas en el backend
export const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});
