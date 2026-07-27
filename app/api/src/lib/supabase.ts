import { createClient } from '@supabase/supabase-js';
import { env } from './env.js';

// Service-role client — bypasses RLS. SERVER ONLY.
// Bound to the v2 schema so every .from('table') targets screening_v2.
export const supabase = createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
  db: { schema: env.supabaseSchema },
});

export const RESUME_BUCKET = 'resumes_v2';
