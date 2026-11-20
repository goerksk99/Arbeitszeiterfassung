import { createClient } from "@supabase/supabase-js";
import { useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import "../app/globals.css";

const supabase = createClient(
  import.meta.env.NEXT_PUBLIC_SUPABASE_URL,
  import.meta.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  {
    auth: { persistSession: false, detectSessionInUrl: false, autoRefreshToken: true },
  },
);

type Profile = { name: string; role: "admin" | "employee" };

function App() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setError("");
    setPending(true);
    const form = event.currentTarget;
    const data = new FormData(form);

    try {
      const { data: auth, error: authError } = await supabase.auth.signInWithPassword({
        email: String(data.get("email")).trim(),
        password: String(data.get("password")),
      });
      if (authError || !auth.user) {
        setError(authError?.code === "invalid_credentials"
          ? "E-Mail-Adresse oder Passwort ist falsch."
          : "Die Anmeldung ist fehlgeschlagen. Prüfe deine Internetverbindung und versuche es erneut.");
        return;
      }

      const { data: account, error: profileError } = await supabase
        .from("profiles")
        .select("full_name, role, is_active")
        .eq("id", auth.user.id)
        .maybeSingle();

      if (profileError || !account?.is_active || (account.role !== "admin" && account.role !== "employee")) {
        await supabase.auth.signOut({ scope: "local" });
        setError(profileError
          ? "Dein Profil konnte nicht geladen werden. Bitte versuche es erneut."
          : "Dein Konto hat kein aktives Profil. Bitte wende dich an die Geschäftsführung.");
        return;
      }

      form.reset();
      setProfile({ name: account.full_name, role: account.role });
    } catch {
      await supabase.auth.signOut({ scope: "local" }).catch(() => undefined);
      setError("Die Verbindung ist fehlgeschlagen. Bitte versuche es erneut.");
    } finally {
      setPending(false);
    }
  }

  async function signOut() {
    setPending(true);
    setError("");
    try {
      const { error: signOutError } = await supabase.auth.signOut({ scope: "local" });
      if (signOutError) throw signOutError;
      setProfile(null);
    } catch {
      setError("Die Abmeldung ist fehlgeschlagen. Du kannst die App schließen, um die Sitzung zu beenden.");
    } finally {
      setPending(false);
    }
  }

  const inputClass = "mt-2 block w-full rounded-lg border border-slate-300 px-3 py-2";
  const buttonClass = "w-full rounded-lg bg-slate-900 px-4 py-3 font-medium text-white disabled:opacity-60";

  return (
    <main className="grid min-h-screen place-items-center bg-slate-100 px-4 py-10 text-slate-950">
      <section className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
        <p className="text-sm font-medium text-slate-600">Arbeitszeiterfassung</p>
        {profile ? (
          <>
            <h1 className="mt-2 text-3xl font-semibold">Willkommen, {profile.name}</h1>
            <p className="mt-3 text-sm text-slate-600">
              {profile.role === "admin" ? "Administratorkonto" : "Mitarbeiterkonto"}
            </p>
            {error && <p role="alert" className="mt-4 text-sm text-red-700">{error}</p>}
            <button type="button" onClick={signOut} disabled={pending} className={"mt-8 " + buttonClass}>Abmelden</button>
          </>
        ) : (
          <>
            <h1 className="mt-2 text-3xl font-semibold">Anmelden</h1>
            <form onSubmit={signIn} className="mt-8 space-y-5">
              <label className="block text-sm font-medium">
                E-Mail-Adresse
                <input name="email" type="email" required autoComplete="username" className={inputClass} />
              </label>
              <label className="block text-sm font-medium">
                Passwort
                <input name="password" type="password" required autoComplete="current-password" className={inputClass} />
              </label>
              {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
              <button type="submit" disabled={pending} className={buttonClass}>
                {pending ? "Anmeldung läuft …" : "Anmelden"}
              </button>
            </form>
          </>
        )}
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
