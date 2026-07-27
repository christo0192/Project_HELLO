import { createClient } from "@supabase/supabase-js";

// Singleton Supabase client scoped to the `screening_v2` Postgres schema.
// Realtime + anon SELECT are enabled server-side for the live-call tables.
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  db: { schema: "screening_v2" },
});
