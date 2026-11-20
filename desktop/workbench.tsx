import { Temporal } from "@js-temporal/polyfill";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { berlinDate, calculateEntry, calculateMonth, COMPANY_ZONE, type AbsenceType } from "../lib/work-time";
import { supabase, type Profile } from "./supabase";

type Entry = {
  id: string;
  started_at: string;
  ended_at: string | null;
  break_minutes: number;
  break_adjusted: boolean;
  status: "open" | "recorded" | "submitted" | "approved" | "rejected";
  note: string | null;
};
const entryColumns = "id, started_at, ended_at, break_minutes, break_adjusted, status, note";
const statusText = { open: "Offen", recorded: "Erfasst", submitted: "Zur Prüfung", approved: "Genehmigt", rejected: "Abgelehnt" };
const time = new Intl.DateTimeFormat("de-DE", { timeZone: COMPANY_ZONE, hour: "2-digit", minute: "2-digit" });
const date = new Intl.DateTimeFormat("de-DE", { timeZone: COMPANY_ZONE, dateStyle: "medium" });
const button = "rounded-lg bg-slate-900 px-4 py-2.5 font-medium text-white disabled:opacity-50";
const field = "mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2";
const card = "rounded-xl border border-slate-200 bg-white p-5";

function duration(minutes: number) {
  const absolute = Math.abs(minutes);
  return `${minutes < 0 ? "−" : ""}${Math.floor(absolute / 60)} Std. ${absolute % 60} Min.`;
}

function localInput(value: string) {
  return Temporal.Instant.from(value).toZonedDateTimeISO(COMPANY_ZONE).toPlainDateTime().toString({ smallestUnit: "minute" });
}

function parseLocalInput(input: FormDataEntryValue | null) {
  return Temporal.PlainDateTime.from(String(input))
    .toZonedDateTime(COMPANY_ZONE, { disambiguation: "reject" }).toInstant().toString();
}

function optionalBreak(input: FormDataEntryValue | null) {
  if (input === "" || input === null) return undefined;
  const minutes = Number(input);
  if (!Number.isInteger(minutes) || minutes < 0) throw new RangeError("Bitte ganze Pausenminuten ab null eingeben.");
  return minutes;
}

function rpcError(error: { code: string; message: string }) {
  if (error.code === "PGRST202") return "Die Stempeluhr muss noch in Supabase aktiviert werden. Bitte wende dich an den Admin.";
  if (error.code === "23505") return "Es gibt bereits eine offene Buchung oder einen Korrekturantrag für diesen Eintrag.";
  if (error.code === "23514") return "Prüfe die Zeiten und Pausenminuten.";
  if (error.code === "P0002") return "Die Buchung wurde inzwischen geändert. Versuche es erneut.";
  if (error.code === "42501") return "Der Monat ist gesperrt oder dein Konto hat keine Berechtigung für diese Änderung.";
  return "Die Änderung konnte nicht gespeichert werden. Bitte versuche es erneut.";
}

type Report = { worked: number; breaks: number; balance: number; locked: boolean; leave: number };

export function Workbench({ profile, onSignOut, signingOut, signOutError }: {
  profile: Profile;
  onSignOut: () => void;
  signingOut: boolean;
  signOutError: string;
}) {
  const [month, setMonth] = useState(() => berlinDate(new Date().toISOString()).slice(0, 7));
  const [day, setDay] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [open, setOpen] = useState<Entry | null>(null);
  const [report, setReport] = useState<Report>();
  const [settings, setSettings] = useState({ start: "12:00", minutes: 30 });
  const [now, setNow] = useState(Date.now);
  const [refresh, setRefresh] = useState(0);
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [message, setMessage] = useState<{ text: string; error?: boolean }>();
  const [correction, setCorrection] = useState<Entry | "new" | null>(null);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const reload = useCallback(() => {
    setReady(false);
    setRefresh((count) => count + 1);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      const selected = Temporal.PlainYearMonth.from(month);
      const prior = selected.subtract({ months: 1 });
      const start = selected.toPlainDate({ day: 1 }).toZonedDateTime(COMPANY_ZONE).toInstant();
      const end = selected.add({ months: 1 }).toPlainDate({ day: 1 }).toZonedDateTime(COMPANY_ZONE).toInstant();
      const first = Temporal.PlainDate.from({ year: selected.year, month: 1, day: 1 }).toString();
      const last = Temporal.PlainDate.from({ year: selected.year, month: 12, day: 31 }).toString();
      const signal = controller.signal;
      const [list, active, settingsResult, summary, previous, absence] = await Promise.all([
        supabase.from("time_entries").select(entryColumns).eq("user_id", profile.id)
          .gte("started_at", start.toString()).lt("started_at", end.toString()).order("started_at", { ascending: false }).abortSignal(signal),
        supabase.from("time_entries").select(entryColumns).eq("user_id", profile.id)
          .eq("status", "open").abortSignal(signal).maybeSingle(),
        supabase.from("company_settings").select("auto_break_start, auto_break_minutes").eq("id", 1).abortSignal(signal).single(),
        supabase.from("monthly_summaries").select("worked_minutes, break_minutes, balance_minutes, is_locked")
          .eq("user_id", profile.id).eq("year", selected.year).eq("month", selected.month).abortSignal(signal).maybeSingle(),
        supabase.from("monthly_summaries").select("balance_minutes").eq("user_id", profile.id)
          .eq("year", prior.year).eq("month", prior.month).eq("is_locked", true).abortSignal(signal).maybeSingle(),
        supabase.from("absences").select("type, start_date, end_date").eq("user_id", profile.id)
          .eq("status", "approved").lte("start_date", last).gte("end_date", first).abortSignal(signal),
      ]);
      if (signal.aborted) return;
      if (list.error || active.error || settingsResult.error || summary.error || previous.error || absence.error) {
        throw new Error("Die Buchungen konnten nicht geladen werden.");
      }

      const rows = list.data as Entry[];
      let worked = 0;
      let breaks = 0;
      for (const entry of rows) {
        if (!entry.ended_at || !["recorded", "approved"].includes(entry.status)) continue;
        worked += calculateEntry(entry.started_at, entry.ended_at, undefined, entry.break_minutes).workedMinutes;
        breaks += entry.break_minutes;
      }
      const absences = absence.data.map((row) => ({
        type: row.type as AbsenceType, startDate: row.start_date, endDate: row.end_date,
      }));
      const calculation = {
        year: selected.year, weeklyHours: profile.weeklyHours,
        workedMinutes: worked, breakMinutes: breaks,
        carryoverMinutes: previous.data?.balance_minutes ?? 0, absences,
      };
      let vacationDays = 0;
      for (let index = 1; index <= 12; index++) {
        vacationDays += calculateMonth({ ...calculation, month: index }).vacationDays;
      }
      const live = calculateMonth({ ...calculation, month: selected.month });
      const fixed = summary.data?.is_locked ? summary.data : null;
      setEntries(rows);
      setOpen(active.data as Entry | null);
      setSettings({ start: settingsResult.data.auto_break_start, minutes: settingsResult.data.auto_break_minutes });
      setReport({
        worked: fixed?.worked_minutes ?? worked,
        breaks: fixed?.break_minutes ?? breaks,
        balance: fixed?.balance_minutes ?? live.balanceMinutes,
        locked: Boolean(fixed),
        leave: profile.annualLeaveDays - vacationDays,
      });
      setLoadError("");
      setReady(true);
    }
    void load().catch(() => {
      if (!controller.signal.aborted) setLoadError("Die Buchungen konnten nicht geladen werden. Bitte prüfe deine Internetverbindung.");
    });
    return () => controller.abort();
  }, [month, profile.id, profile.weeklyHours, profile.annualLeaveDays, refresh]);

  async function stamp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !ready) return;
    const form = event.currentTarget;
    const input = new FormData(form);
    setPending(true);
    setMessage(undefined);
    try {
      const result = open
        ? await supabase.rpc("clock_out", {
          entry_id: open.id, adjusted_break: optionalBreak(input.get("pause")) ?? null,
          entry_note: String(input.get("note") ?? ""),
        })
        : await supabase.rpc("clock_in");
      if (result.error) {
        setMessage({ text: rpcError(result.error), error: true });
      } else {
        form.reset();
        setMessage({ text: open ? "Ausstempeln gespeichert." : "Einstempeln gespeichert." });
      }
      reload();
    } catch (error) {
      setMessage({ text: error instanceof RangeError ? error.message : "Die Buchung konnte nicht gespeichert werden.", error: true });
    } finally {
      setPending(false);
    }
  }

  async function submitCorrection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!correction || !ready || pending) return;
    const data = new FormData(event.currentTarget);
    setPending(true);
    setMessage(undefined);
    try {
      const started = parseLocalInput(data.get("started"));
      const ended = parseLocalInput(data.get("ended"));
      const reason = String(data.get("reason") ?? "").trim();
      if (!reason) throw new RangeError("Bitte gib eine Begründung ein.");
      const pause = calculateEntry(started, ended, settings, optionalBreak(data.get("pause")));
      const { error } = await supabase.from("time_entries").insert({
        user_id: profile.id, started_at: started, ended_at: ended, status: "submitted",
        break_minutes: pause.breakMinutes, break_adjusted: pause.breakAdjusted, correction_reason: reason,
        corrects_entry_id: correction === "new" ? null : correction.id,
        note: String(data.get("note") ?? "").trim() || null,
      });
      if (error) {
        setMessage({ text: rpcError(error), error: true });
        return;
      }
      setCorrection(null);
      setMessage({ text: "Korrekturantrag zur Prüfung eingereicht." });
      reload();
    } catch (error) {
      setMessage({
        text: error instanceof RangeError ? "Bitte prüfe die Berliner Start- und Endzeit, Pause und Begründung." : "Die Änderung konnte nicht gespeichert werden.",
        error: true,
      });
    } finally {
      setPending(false);
    }
  }

  const source = correction && correction !== "new" ? correction : null;
  const stale = open && berlinDate(open.started_at) < berlinDate(new Date(now).toISOString());
  const shown = entries.filter((entry) => !day || berlinDate(entry.started_at) === day);

  return (
    <main className="min-h-screen bg-slate-100 px-4 py-8 text-slate-950 sm:px-6">
      <div className="mx-auto max-w-5xl space-y-5">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-slate-600">Arbeitszeiterfassung</p>
            <h1 className="text-2xl font-semibold">Willkommen, {profile.name}</h1>
          </div>
          <button type="button" onClick={onSignOut} disabled={signingOut || pending} className="rounded-lg border border-slate-300 bg-white px-4 py-2">Abmelden</button>
        </header>
        {signOutError && <p role="alert" className="text-red-700">{signOutError}</p>}
        {loadError && <p role="alert" className="text-red-700">{loadError} <button className="underline" onClick={reload}>Erneut laden</button></p>}
        {message && <p role={message.error ? "alert" : "status"} className={message.error ? "text-red-700" : "text-emerald-800"}>{message.text}</p>}
        <section className={card}>
          <h2 className="text-lg font-semibold">Stempeluhr</h2>
          <p className="mt-2">
            {!ready ? "Status wird geladen …" : open
              ? `Eingestempelt seit ${time.format(Date.parse(open.started_at))} Uhr · ${duration(Math.max(0, Math.floor((now - Date.parse(open.started_at)) / 60000)))}`
              : "Ausgestempelt"}
          </p>
          {ready && stale && <p className="mt-2 text-amber-800">Offene Buchung vom {date.format(Date.parse(open.started_at))}. Prüfe die Endzeit oder reiche eine Korrektur ein.</p>}
          <form onSubmit={stamp} key={open?.id ?? "closed"} className="mt-4 space-y-3">
            {ready && open && (
              <div className="grid gap-3 sm:grid-cols-2">
                <label>Notiz (optional)<input name="note" maxLength={500} className={field} /></label>
                <label>Pause anpassen (optional)<input name="pause" type="number" min="0" step="1" placeholder="Automatisch" className={field} /></label>
              </div>
            )}
            <button type="submit" disabled={!ready || pending || signingOut} className={button}>{open ? "Ausstempeln" : "Einstempeln"}</button>
          </form>
        </section>
        <section className={card}>
          <div className="flex flex-wrap justify-between gap-3">
            <h2 className="text-lg font-semibold">Meine Buchungen</h2>
            <button type="button" disabled={!ready || pending || report?.locked} className={button} onClick={() => setCorrection("new")}>Zeit nachtragen</button>
          </div>
          <div className="my-4 flex flex-wrap gap-4">
            <label>Monat<input type="month" value={month} max="9999-12" min="0002-01" className={field} onChange={(event) => {
              if (!event.target.validity.valid || !event.target.value) return;
              setReady(false); setMonth(event.target.value); setDay(""); setCorrection(null);
            }} /></label>
            <label>Einzelner Tag (optional)<input type="date" value={day} className={field} onChange={(event) => setDay(event.target.value)} /></label>
          </div>
          {ready && report && <p className="mb-3 text-sm text-slate-700">
            Monat: {duration(report.worked)} netto · {duration(report.breaks)} Pause · Saldo {duration(report.balance)} · Resturlaub {report.leave} Tage{report.locked && " · Abgeschlossen"}
          </p>}
          {ready && shown.length === 0 && <p>Keine Buchungen im gewählten Zeitraum.</p>}
          {ready && shown.length > 0 && (
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead><tr className="border-b border-slate-200"><th className="p-2">Datum</th><th className="p-2">Start – Ende</th><th className="p-2">Pause</th><th className="p-2">Netto</th><th className="p-2">Status</th><th className="p-2">Aktion</th></tr></thead>
                <tbody>
                  {shown.map((entry) => (
                    <tr key={entry.id} className="border-b border-slate-100">
                      <td className="p-2">{date.format(Date.parse(entry.started_at))}</td>
                      <td className="p-2">{time.format(Date.parse(entry.started_at))} – {entry.ended_at ? time.format(Date.parse(entry.ended_at)) : "offen"}{entry.note && <p className="break-all text-slate-600">{entry.note}</p>}</td>
                      <td className="p-2">{entry.break_minutes} Min.</td>
                      <td className="p-2">{entry.ended_at ? duration(calculateEntry(entry.started_at, entry.ended_at, undefined, entry.break_minutes).workedMinutes) : "–"}</td>
                      <td className="p-2">{statusText[entry.status]}</td>
                      <td className="p-2">{!report?.locked && ["open", "recorded", "approved"].includes(entry.status) && (
                        <button type="button" disabled={pending} className="underline" onClick={() => setCorrection(entry)}>Korrektur</button>
                      )}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
        {correction && <section className={card}>
          <h2 className="text-lg font-semibold">{source ? "Buchung korrigieren" : "Zeit nachtragen"}</h2>
          <form key={source?.id ?? "new"} onSubmit={submitCorrection} className="mt-4 grid gap-3 sm:grid-cols-2">
            <label>Beginn<input type="datetime-local" name="started" required defaultValue={source ? localInput(source.started_at) : ""} className={field} /></label>
            <label>Ende<input type="datetime-local" name="ended" required defaultValue={source?.ended_at ? localInput(source.ended_at) : ""} className={field} /></label>
            <label>Pause (Minuten)<input type="number" name="pause" min="0" step="1" placeholder="Automatisch" defaultValue={source?.break_adjusted ? source.break_minutes : ""} className={field} /></label>
            <label>Notiz (optional)<input name="note" maxLength={500} defaultValue={source?.note ?? ""} className={field} /></label>
            <label className="sm:col-span-2">Begründung<textarea name="reason" required maxLength={1000} className={field} /></label>
            <div className="flex gap-4 sm:col-span-2">
              <button type="submit" className={button} disabled={!ready || pending}>Zur Prüfung einreichen</button>
              <button type="button" className="underline" onClick={() => setCorrection(null)} disabled={pending}>Abbrechen</button>
            </div>
          </form>
        </section>}
      </div>
    </main>
  );
}
