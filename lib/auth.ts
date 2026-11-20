import { cache } from "react";
import { forbidden, redirect } from "next/navigation";
import { hasSupabaseConfig } from "./supabase/config";
import { createClient } from "./supabase/server";

export const requireProfile = cache(async (role?: "admin" | "employee") => {
  if (!hasSupabaseConfig()) redirect("/login");

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile, error } = await supabase
    .from("profiles")
    .select("full_name, role, is_active")
    .eq("id", user.id)
    .maybeSingle();
  if (error) throw new Error("Das Benutzerprofil konnte nicht geladen werden.");
  if (!profile?.is_active || (profile.role !== "admin" && profile.role !== "employee")) {
    redirect("/login?zugang=fehlt");
  }
  if (role && profile.role !== role) forbidden();

  return { name: profile.full_name as string, role: profile.role as "admin" | "employee" };
});
