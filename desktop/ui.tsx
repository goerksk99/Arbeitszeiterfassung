import type { FormEvent, ReactNode } from "react";
import { useState } from "react";
import { Temporal } from "@js-temporal/polyfill";
import { berlinDate, type AbsenceType } from "../lib/work-time";
import { supabase } from "./supabase";
import type { Staff } from "./team";

export const button = "btn disabled:opacity-50";
export const secondary = "btn-secondary disabled:opacity-50";
export const field = "text-field";
export const card = "panel-card";
export const absenceLabels: Record<AbsenceType, string> = {
  vacation: "Urlaub", sick: "Krankheit", comp_time: "Zeitausgleich", other: "Sonstiges",
};
export const absenceColors: Record<AbsenceType, string> = {
  vacation: "bg-teal-100 text-teal-950",
  sick: "bg-rose-100 text-rose-950",
  comp_time: "bg-sky-100 text-sky-950",
  other: "bg-amber-100 text-amber-950",
};
export type Member = Staff;
export type Notice = { text: string; error?: boolean };
export const monthNow = () => berlinDate(new Date().toISOString()).slice(0, 7);
export const monthLabel = (month: string) => Temporal.PlainYearMonth.from(month).toPlainDate({ day: 1 }).toLocaleString("de-DE", { month: "long", year: "numeric" });
export const dayLabel = (day: string) => Temporal.PlainDate.from(day).toLocaleString("de-DE");
export const absenceStatus = { approved: "Genehmigt", submitted: "Zur Prüfung", rejected: "Abgelehnt" } as const;

export function Message({ notice }: { notice?: Notice }) {
  return notice && <p role={notice.error ? "alert" : "status"} className={notice.error ? "app-notice app-notice--error" : "app-notice"}>{notice.text}</p>;
}

export function requestError(error: unknown) {
  if (typeof error !== "object" || error === null || !("code" in error)) return "Der Vorgang konnte nicht abgeschlossen werden.";
  if (error.code === "PGRST202") return "Bitte zuerst die aktuelle SQL-Migration in Supabase ausführen.";
  if (error.code === "23505") return "Für diese Buchung gibt es bereits einen offenen Korrekturantrag.";
  if (error.code === "23514") return "Bitte prüfe die angegebenen Zeiten, Pausen und Pflichtfelder.";
  if (error.code === "23P01") return "Der Zeitraum überschneidet sich mit einer genehmigten Abwesenheit.";
  if (error.code === "42501") return "Der Monat ist gesperrt oder deinem Konto fehlt die Berechtigung.";
  if (error.code === "P0002" || error.code === "P0001") {
    if ("message" in error && typeof error.message === "string") return error.message;
  }
  return "Der Vorgang konnte nicht abgeschlossen werden.";
}

export async function listMembers(signal?: AbortSignal): Promise<Member[]> {
  let query = supabase.from("profiles").select("id, full_name, weekly_hours, annual_leave_days, is_active, role, department").order("full_name");
  if (signal) query = query.abortSignal(signal);
  const { data, error } = await query;
  if (error) throw error;
  return data as Member[];
}

export function PasswordForm({ onClose }: { onClose: () => void }) {
  const [notice, setNotice] = useState<Notice>();
  const [busy, setBusy] = useState(false);
  async function update(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    const password = String(values.get("password") ?? "");
    if (password !== values.get("confirm")) {
      setNotice({ text: "Die Passwörter stimmen nicht überein.", error: true });
      return;
    }
    setBusy(true);
    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      form.reset();
      setNotice({ text: "Passwort geändert." });
    } catch {
      setNotice({ text: "Das Passwort konnte nicht geändert werden. Melde dich ggf. erneut an.", error: true });
    } finally { setBusy(false); }
  }
  return (
    <section className={card}>
      <h2 className="text-lg font-semibold">Passwort ändern</h2>
      <form onSubmit={update} className="mt-4 grid gap-3 md:grid-cols-2">
        <label>Neues Passwort<input className={field} name="password" type="password" minLength={12} maxLength={72} required autoComplete="new-password" /></label>
        <label>Neues Passwort wiederholen<input className={field} name="confirm" type="password" minLength={12} maxLength={72} required autoComplete="new-password" /></label>
        <div className="flex flex-wrap gap-2 md:col-span-2">
          <button className={button} disabled={busy}>Speichern</button>
          <button className={secondary} type="button" onClick={onClose}>Schließen</button>
        </div>
      </form>
      <div className="mt-3"><Message notice={notice} /></div>
    </section>
  );
}

export function DateNavigation({ children, previous, next }: { children: ReactNode; previous: () => void; next: () => void }) {
  return <div className="flex items-center gap-3">
    <button type="button" aria-label="Vorheriger Zeitraum" className={secondary} onClick={previous}>‹</button>
    <span className="min-w-28 text-center font-medium">{children}</span>
    <button type="button" aria-label="Nächster Zeitraum" className={secondary} onClick={next}>›</button>
  </div>;
}
