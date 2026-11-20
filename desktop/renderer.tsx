import { useEffect, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { CalendarDays, CalendarPlus, ClipboardList, Clock3, KeyRound, LogOut, Timer, UsersRound } from "lucide-react";
import { Fragment } from "react";
import "../app/globals.css";

import { supabase, type Profile } from "./supabase";
import { Workbench } from "./workbench";
import { Admin } from "./admin";
import { Calendar } from "./calendar";
import { Reports } from "./reports";
import { button, field, PasswordForm } from "./ui";
import { Clock } from "./clock";
import { AbsenceRequest } from "./absence-request";
import "./theme.css";
import "./print.css";

type Screen = "work" | "entries" | "calendar" | "absence" | "admin" | "reports";
const navigation = [
  { screen: "work", label: "Stempeluhr", icon: Timer },
  { screen: "entries", label: "Arbeitszeiten", icon: Clock3 },
  { screen: "calendar", label: "Teamkalender", icon: CalendarDays },
  { screen: "absence", label: "Abwesenheit beantragen", icon: CalendarPlus },
  { screen: "admin", label: "Verwaltung", icon: UsersRound, admin: true },
  { screen: "reports", label: "Monatsberichte", icon: ClipboardList, admin: true },
] as const;

function App() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [screen, setScreen] = useState<Screen>("work");
  const [passwordForm, setPasswordForm] = useState(false);
  useEffect(() => { window.scrollTo(0, 0); }, [screen]);

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
        .select("full_name, role, is_active, weekly_hours, annual_leave_days")
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
      setProfile({
        id: auth.user.id, name: account.full_name, role: account.role,
        weeklyHours: account.weekly_hours, annualLeaveDays: account.annual_leave_days,
      });
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
      setScreen("work");
      setPasswordForm(false);
    } catch {
      setError("Die Abmeldung ist fehlgeschlagen. Du kannst die App schließen, um die Sitzung zu beenden.");
    } finally {
      setPending(false);
    }
  }

  if (profile) {
    const current = navigation.find((item) => item.screen === screen)!;
    const initials = profile.name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
    return (
      <main className="app-shell">
        <aside className="sidebar no-print">
          <div className="app-brand"><span className="brand-icon"><Clock3 size={22} aria-hidden="true" /></span><span>Arbeitszeiterfassung</span></div>
          <nav aria-label="Hauptnavigation">
            {navigation.filter((item) => !("admin" in item) || profile.role === "admin").map(({ screen: name, label, icon: Icon }) => (
              <Fragment key={name}>
                {name === "admin" && <p className="nav-heading">Administration</p>}
                <button type="button" className="nav-button" aria-current={screen === name ? "page" : undefined}
                  onClick={() => { setScreen(name); setPasswordForm(false); }}><Icon size={18} aria-hidden="true" />{label}</button>
              </Fragment>
            ))}
          </nav>
          <div className="sidebar-account">
            <div className="account-card">
              <span className="account-avatar" aria-hidden="true">{initials}</span>
              <div><strong>{profile.name}</strong><small>{profile.role === "admin" ? "Administrator" : "Mitarbeiterkonto"}</small></div>
            </div>
            <div className="account-actions">
              <button className="nav-button" type="button" aria-expanded={passwordForm} disabled={pending}
                onClick={() => { setPasswordForm(!passwordForm); window.scrollTo(0, 0); }}><KeyRound size={16} aria-hidden="true" />Passwort ändern</button>
              <button className="nav-button" type="button" disabled={pending} onClick={signOut}><LogOut size={16} aria-hidden="true" />Abmelden</button>
            </div>
          </div>
        </aside>
        <div className="screen-area">
          <div className="screen-frame space-y-5">
            <header className="screen-header no-print">
              <h1>{current.label}</h1>
              {screen === "work" && <p>Willkommen, {profile.name}</p>}
            </header>
            {error && <p role="alert" className="no-print app-notice app-notice--error">{error}</p>}
            {passwordForm && <div className="no-print"><PasswordForm onClose={() => setPasswordForm(false)} /></div>}
            {screen === "work" && <Clock profile={profile} onEntries={() => setScreen("entries")} />}
            {screen === "entries" && <Workbench profile={profile} />}
            {screen === "calendar" && <Calendar profile={profile} onRequest={() => setScreen("absence")} />}
            {screen === "absence" && <AbsenceRequest profile={profile} />}
            {screen === "admin" && profile.role === "admin" && <Admin profile={profile} />}
            {screen === "reports" && profile.role === "admin" && <Reports profile={profile} />}
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="login-screen">
      <section className="login-panel">
        <div className="app-brand"><span className="brand-icon"><Clock3 size={22} aria-hidden="true" /></span>Arbeitszeiterfassung</div>
        <h1>Anmelden</h1>
        <form onSubmit={signIn} className="mt-5 space-y-4">
          <label className="block text-sm font-semibold">
            E-Mail-Adresse<input name="email" type="email" required autoComplete="username" className={field} />
          </label>
          <label className="block text-sm font-semibold">
            Passwort<input name="password" type="password" required autoComplete="current-password" className={field} />
          </label>
          {error && <p role="alert" className="app-notice app-notice--error">{error}</p>}
          <button type="submit" disabled={pending} className={button}>{pending ? "Anmeldung läuft …" : "Anmelden"}</button>
        </form>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
