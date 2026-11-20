"use server";

import { redirect } from "next/navigation";
import { hasSupabaseConfig } from "../../lib/supabase/config";
import { createClient } from "../../lib/supabase/server";

export async function signIn(_previousError: string, formData: FormData): Promise<string> {
  const email = formData.get("email");
  const password = formData.get("password");
  if (typeof email !== "string" || !email.trim() || typeof password !== "string" || !password) {
    return "Bitte E-Mail-Adresse und Passwort eingeben.";
  }
  if (!hasSupabaseConfig()) return "Die Anmeldung ist derzeit nicht eingerichtet.";

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
  if (error) {
    return error.code === "invalid_credentials"
      ? "E-Mail-Adresse oder Passwort ist falsch."
      : "Die Anmeldung ist fehlgeschlagen. Bitte versuche es erneut.";
  }
  redirect("/dashboard");
}

export async function signOut() {
  const supabase = await createClient();
  const { error } = await supabase.auth.signOut({ scope: "local" });
  if (error) throw new Error("Die Abmeldung ist fehlgeschlagen.");
  redirect("/login");
}
