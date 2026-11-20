import { createClient } from "npm:@supabase/supabase-js@2.119.2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, x-client-info, content-type, x-region, x-relay-force",
};

function json(body: object, status = 200) {
  return Response.json(body, { status, headers: cors });
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response(null, { headers: cors });
  if (request.method !== "POST") return json({ error: "Ungültige Methode." }, 405);
  const jwt = request.headers.get("Authorization");
  if (!jwt?.startsWith("Bearer ")) return json({ error: "Anmeldung erforderlich." }, 401);

  const url = Deno.env.get("SUPABASE_URL")!;
  const caller = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: jwt } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: { user } } = await caller.auth.getUser(jwt.slice(7));
  if (!user) return json({ error: "Anmeldung erforderlich." }, 401);
  const { data: profile } = await caller.from("profiles").select("role, is_active").eq("id", user.id).maybeSingle();
  if (!profile?.is_active || profile.role !== "admin") return json({ error: "Adminrechte erforderlich." }, 403);

  let input;
  try { input = await request.json(); } catch { return json({ error: "Ungültige Angaben." }, 400); }
  const action = input?.action ?? "invite";
  const password = typeof input?.password === "string" ? input.password : "";

  const authAdmin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  if (action === "reset-password") {
    if (password.length < 12 || new TextEncoder().encode(password).length > 72) {
      return json({ error: "Das Startpasswort muss mindestens 12 Zeichen und höchstens 72 UTF-8-Bytes lang sein." }, 400);
    }
    const id = typeof input?.memberId === "string" ? input.memberId : "";
    if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(id)) {
      return json({ error: "Ungültiges Mitarbeiterkonto." }, 400);
    }
    const { data: target, error: targetError } = await caller.from("profiles")
      .select("role, is_active").eq("id", id).maybeSingle();
    if (targetError) return json({ error: "Das Mitarbeiterkonto konnte nicht geprüft werden." }, 502);
    if (target?.role !== "employee" || !target.is_active) {
      return json({ error: "Ein Startpasswort kann nur für ein aktives Mitarbeiterkonto gesetzt werden." }, 403);
    }
    const { data: account, error: accountError } = await authAdmin.auth.admin.getUserById(id);
    if (accountError || !account.user?.email_confirmed_at) {
      return json({ error: "Dieses Konto muss zuerst die Einladung per E-Mail bestätigen." }, 403);
    }
    const { error } = await authAdmin.auth.admin.updateUserById(id, { password });
    if (error) {
      console.error("Employee password reset failed", error.code);
      return json({ error: "Das Passwort konnte nicht zurückgesetzt werden." }, 502);
    }
    return json({ ok: true });
  }
  if (action !== "invite") return json({ error: "Ungültige Aktion." }, 400);

  const email = typeof input?.email === "string" ? input.email.trim() : "";
  const name = typeof input?.name === "string" ? input.name.trim() : "";
  const department = input?.department;
  if (!["management", "sales", "dispatch", "accounting"].includes(department)) {
    return json({ error: "Bitte wähle eine Abteilung." }, 400);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !name || name.length > 120) {
    return json({ error: "Bitte gib einen Namen und eine gültige E-Mail-Adresse ein." }, 400);
  }

  const { data, error } = await authAdmin.auth.admin.inviteUserByEmail(email);
  if (error || !data.user) {
    console.error("Employee invite could not be sent", error?.code);
    const message = ["email_exists", "user_already_exists"].includes(error?.code ?? "")
      ? "Für diese E-Mail-Adresse gibt es bereits ein Konto."
      : "Die Einladung konnte nicht gesendet werden. Prüfe die SMTP-Einstellungen in Supabase.";
    return json({ error: message }, error?.status === 422 ? 409 : 502);
  }
  const { data: existing, error: lookupError } = await caller.from("profiles")
    .select("role").eq("id", data.user.id).maybeSingle();
  if (lookupError) return json({ error: "Das Profil zur Einladung konnte nicht geprüft werden." }, 502);
  if (existing?.role === "employee") return json({ ok: true });
  if (existing) return json({ error: "Zu dieser Adresse gehört bereits ein Admin-Konto." }, 409);
  // The signed-in administrator has an explicit INSERT grant and profile policy.
  // The service role is only needed by the Auth administration API.
  const { error: profileError } = await caller.from("profiles").insert({
    id: data.user.id, full_name: name, role: "employee", department,
    automatic_lunch_break: input?.automaticLunch !== false,
  });
  if (profileError) {
    if (profileError.code === "23505") {
      return json({ error: "Dieses Konto wurde bereits eingerichtet." }, 409);
    }
    console.error("Profile insert failed", profileError.code);
    const rollback = await authAdmin.auth.admin.deleteUser(data.user.id);
    if (rollback.error) {
      console.error("Auth account cleanup failed", rollback.error.code);
      return json({ error: "Das Profil konnte nicht gespeichert werden. Prüfe unter Authentication → Users, ob das neue Konto noch vorhanden ist." }, 500);
    }
    return json({ error: "Das Mitarbeiterprofil konnte nicht angelegt werden." }, 500);
  }
  return json({ ok: true }, 201);
});
