import { createClient } from "@supabase/supabase-js";

export const supabase = createClient(
  import.meta.env.NEXT_PUBLIC_SUPABASE_URL,
  import.meta.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  { auth: { persistSession: false, detectSessionInUrl: false, autoRefreshToken: true } },
);

export type Profile = {
  id: string;
  name: string;
  role: "admin" | "employee";
  weeklyHours: number;
  annualLeaveDays: number;
};
