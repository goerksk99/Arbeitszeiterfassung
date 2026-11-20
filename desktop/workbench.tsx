import { Temporal } from "@js-temporal/polyfill";
import { CalendarDays, ChevronLeft, ChevronRight, Clock3, Coffee, LockKeyhole, Pencil, Plus } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { berlinDate, calculateEntry, calculateMonth, COMPANY_ZONE, type AbsenceType } from "../lib/work-time";
import { isoWeek, weekMonday } from "../lib/iso-week";
import { supabase, type Profile } from "./supabase";
import { type MonthlyReport } from "../lib/monthly-report";
import { button, card, field, Message, monthLabel, requestError, secondary, type Notice } from "./ui";
import { date, duration, entryColumns, optionalBreak, time, type Entry } from "./time-display";

const statusText = { open: "Offen", recorded: "Erfasst", submitted: "Zur Prüfung", approved: "Genehmigt", rejected: "Abgelehnt" };
const dayName = new Intl.DateTimeFormat("de-DE", { timeZone: COMPANY_ZONE, weekday: "long" });

function localInput(value: string) {
  return Temporal.Instant.from(value).toZonedDateTimeISO(COMPANY_ZONE).toPlainDateTime().toString({ smallestUnit: "minute" });
}

function parseLocalInput(input: FormDataEntryValue | null) {
  return Temporal.PlainDateTime.from(String(input))
    .toZonedDateTime(COMPANY_ZONE, { disambiguation: "reject" }).toInstant().toString();
}

function rpcError(error: { code: string; message: string }) {
  if (error.code === "PGRST202") return "Die Stempeluhr muss noch in Supabase aktiviert werden. Bitte wende dich an den Admin.";
  if (error.code === "23505") return "Es gibt bereits eine offene Buchung oder einen Korrekturantrag für diesen Eintrag.";
  if (error.code === "23514") return "Prüfe die Zeiten und Pausenminuten.";
  if (error.code === "P0002") return "Die Buchung wurde inzwischen geändert. Versuche es erneut.";
  if (error.code === "42501") return "Der Monat ist gesperrt oder dein Konto hat keine Berechtigung für diese Änderung.";
  return "Die Änderung konnte nicht gespeichert werden. Bitte versuche es erneut.";
}

type Report = { worked: number; breaks: number; balance?: number; lockedMonths: MonthLocks; leave?: number };
type MonthLocks = Record<string, boolean>;

export function Workbench({ profile }: { profile: Profile }) {
  const [month, setMonth] = useState(() => berlinDate(new Date().toISOString()).slice(0, 7));
  const [week, setWeek] = useState(() => isoWeek(Temporal.PlainDate.from(berlinDate(new Date().toISOString()))));
  const [mode, setMode] = useState<"week" | "month">("week");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [report, setReport] = useState<Report>();
  const [settings, setSettings] = useState({ start: "12:00", minutes: 30 });
  const [refresh, setRefresh] = useState(0);
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [message, setMessage] = useState<Notice>();
  const [correction, setCorrection] = useState<Entry | "new" | null>(null);

  const reload = useCallback(() => {
    setReady(false);
    setRefresh((count) => count + 1);
  }, []);

  const monday = weekMonday(week);
  const monthPeriod = Temporal.PlainYearMonth.from(month);
  const period = mode === "week" ? week : month;

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      const isWeek = mode === "week";
      const firstDay = isWeek ? weekMonday(period) : Temporal.PlainYearMonth.from(period).toPlainDate({ day: 1 });
      const endDay = firstDay.add(isWeek ? { weeks: 1 } : { months: 1 });
      const start = firstDay.toZonedDateTime(COMPANY_ZONE).toInstant().toString();
      const end = endDay.toZonedDateTime(COMPANY_ZONE).toInstant().toString();
      const touchedMonths = [...new Set([firstDay.toString().slice(0, 7), endDay.subtract({ days: 1 }).toString().slice(0, 7)])];
      const signal = controller.signal;
      const [list, settingsResult, summaries, absence] = await Promise.all([
        supabase.from("time_entries").select(entryColumns).eq("user_id", profile.id)
          .gte("started_at", start).lt("started_at", end)
          .or("corrects_entry_id.is.null,status.neq.approved").order("started_at", { ascending: false }).abortSignal(signal),
        supabase.from("company_settings").select("auto_break_start, auto_break_minutes").eq("id", 1).abortSignal(signal).single(),
        Promise.all(touchedMonths.map(async (item) => {
          const selected = Temporal.PlainYearMonth.from(item);
          const result = await supabase.rpc("read_monthly_report", {
            member_id: profile.id, report_year: selected.year, report_month: selected.month,
          }).abortSignal(signal);
          if (result.error) throw result.error;
          return result.data as MonthlyReport;
        })),
        isWeek ? null : supabase.from("absences").select("type, start_date, end_date").eq("user_id", profile.id)
          .eq("status", "approved").eq("type", "vacation")
          .lte("start_date", firstDay.with({ month: 12, day: 31 }).toString())
          .gte("end_date", firstDay.with({ month: 1, day: 1 }).toString()).abortSignal(signal),
      ]);
      if (signal.aborted) return;
      const error = list.error ?? settingsResult.error ?? absence?.error;
      if (error) throw error;

      const rows = list.data as Entry[];
      const complete = rows.filter((entry) => entry.ended_at && (entry.status === "recorded" || entry.status === "approved"));
      const monthly = summaries[0];
      let vacationDays = 0;
      if (!isWeek) {
        const absences = (absence?.data ?? []).map((row) => ({
          type: row.type as AbsenceType, startDate: row.start_date, endDate: row.end_date,
        }));
        for (let index = 1; index <= 12; index++) {
          vacationDays += calculateMonth({
            month: index, year: firstDay.year, weeklyHours: profile.weeklyHours, workedMinutes: 0, breakMinutes: 0, absences,
          }).vacationDays;
        }
      }
      setEntries(rows);
      setSettings({ start: settingsResult.data!.auto_break_start, minutes: settingsResult.data!.auto_break_minutes });
      setReport({
        worked: isWeek ? complete.reduce((sum, entry) => sum + calculateEntry(entry.started_at, entry.ended_at!, undefined, entry.break_minutes).workedMinutes, 0) : monthly.worked_minutes,
        breaks: isWeek ? complete.reduce((sum, entry) => sum + entry.break_minutes, 0) : monthly.break_minutes,
        balance: isWeek ? undefined : monthly.balance_minutes,
        lockedMonths: Object.fromEntries(touchedMonths.map((item, index) => [item, summaries[index].is_locked])),
        leave: isWeek ? undefined : profile.annualLeaveDays - vacationDays,
      });
      setLoadError("");
      setReady(true);
    }
    void load().catch((error) => {
      if (!controller.signal.aborted) setLoadError(error?.code === "PGRST202" ? requestError(error) : "Die Buchungen konnten nicht geladen werden.");
    });
    return () => controller.abort();
  }, [mode, period, profile.id, profile.weeklyHours, profile.annualLeaveDays, refresh]);

  function changePeriod(next: string) {
    if (!next || pending) return;
    try {
      if (mode === "week") { weekMonday(next); setWeek(next); }
      else { Temporal.PlainYearMonth.from(next); setMonth(next); }
    } catch { return; }
    if (next !== period) { setReady(false); setCorrection(null); setLoadError(""); }
  }

  function movePeriod(direction: number) {
    changePeriod(mode === "week" ? isoWeek(monday.add({ weeks: direction }))
      : monthPeriod.add({ months: direction }).toString());
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
  const allLocked = Boolean(report && Object.values(report.lockedMonths).every(Boolean));
  const grouped = Map.groupBy(entries, (entry) => berlinDate(entry.started_at));
  const weekYear = Number(week.slice(0, 4));
  const weekNumber = Number(week.slice(-2));
  const weekCount = Temporal.PlainDate.from({ year: weekYear, month: 12, day: 28 }).weekOfYear ?? 52;
  const label = mode === "week" ? `KW ${weekNumber} · ${weekYear}` : monthLabel(month);
  const weekDates = `${monday.toLocaleString("de-DE")} – ${monday.add({ days: 6 }).toLocaleString("de-DE")}`;

  return (
    <div className="space-y-5">
      {loadError && <p role="alert" className="text-red-700">{loadError} <button className="underline" onClick={reload}>Erneut laden</button></p>}
      <Message notice={message} />
      <section className="period-toolbar">
        <div className="period-toggle" aria-label="Zeitraum">
          <button type="button" aria-pressed={mode === "week"} disabled={pending} onClick={() => { if (mode !== "week") { setMode("week"); setReady(false); setCorrection(null); } }}>Kalenderwoche</button>
          <button type="button" aria-pressed={mode === "month"} disabled={pending} onClick={() => { if (mode !== "month") { setMode("month"); setReady(false); setCorrection(null); } }}>Monat</button>
        </div>
        <button type="button" disabled={!ready || pending || allLocked} className={button} onClick={() => setCorrection("new")}><Plus size={18} aria-hidden="true" />Zeit nachtragen</button>
      </section>
      <section className={`${card} period-panel`}>
        <div className="period-controls">
          <div className="period-arrows">
            <button type="button" className={secondary} aria-label="Vorheriger Zeitraum" onClick={() => movePeriod(-1)}><ChevronLeft size={18} aria-hidden="true" /></button>
            <button type="button" className={secondary} aria-label="Nächster Zeitraum" onClick={() => movePeriod(1)}><ChevronRight size={18} aria-hidden="true" /></button>
          </div>
          <div className="period-heading">
            <h2>{label}</h2>
            {mode === "week" && <p>{weekDates}</p>}
          </div>
          {mode === "week" ? (
            <div className="period-week-fields">
              <label className="period-picker">Kalenderwoche
                <select value={weekNumber} aria-label="Kalenderwoche wählen" className={field}
                  onChange={(event) => changePeriod(`${weekYear}-W${event.target.value.padStart(2, "0")}`)}>
                  {Array.from({ length: weekCount }, (_, index) => index + 1).map((number) => <option key={number} value={number}>KW {number}</option>)}
                </select>
              </label>
              <label className="period-picker">Jahr
                <input key={weekYear} type="number" min="1900" max="9999" step="1" className={field} defaultValue={weekYear}
                  aria-label="Jahr der Kalenderwoche" onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
                  onBlur={(event) => {
                    const year = event.currentTarget.valueAsNumber;
                    if (!Number.isInteger(year) || year < 1900 || year > 9999) {
                      event.currentTarget.value = String(weekYear);
                      return;
                    }
                    const maxWeek = Temporal.PlainDate.from({ year, month: 12, day: 28 }).weekOfYear ?? 52;
                    changePeriod(`${year}-W${String(Math.min(weekNumber, maxWeek)).padStart(2, "0")}`);
                  }} />
              </label>
            </div>
          ) : <label className="period-picker">Monat wählen
            <input type="month" value={month} aria-label="Monat wählen" className={field}
              onChange={(event) => { if (event.target.validity.valid) changePeriod(event.target.value); }} />
          </label>}
        </div>
        {ready && report && <div className="time-metrics">
          <div><span><Clock3 size={17} aria-hidden="true" />Netto-Arbeitszeit</span><strong>{duration(report.worked)} <small>Std.</small></strong></div>
          <div><span><Coffee size={17} aria-hidden="true" />Pause</span><strong>{duration(report.breaks)} <small>Std.</small></strong></div>
          {report.balance !== undefined && <div><span>Monatssaldo</span><strong>{duration(report.balance)} <small>Std.</small></strong></div>}
          {report.leave !== undefined && <div><span>Resturlaub</span><strong>{report.leave} <small>Tage</small></strong></div>}
        </div>}
        {ready && allLocked && <p className="locked-period"><LockKeyhole size={16} aria-hidden="true" />Zeitraum abgeschlossen</p>}
      </section>
      <section className={`${card} time-list`}>
        <h2>Meine Buchungen</h2>
        {!ready && !loadError && <p role="status" className="muted-notice">Buchungen werden geladen …</p>}
        {ready && !entries.length && <div className="empty-state"><CalendarDays size={28} aria-hidden="true" /><p>Hier sind noch keine Buchungen.</p></div>}
        {ready && [...grouped].map(([key, rows]) => (
          <div key={key} className="time-day">
            <h3>{dayName.format(Date.parse(rows[0].started_at))} <span>{date.format(Date.parse(rows[0].started_at))}</span></h3>
            {rows.map((entry) => {
              const unlocked = !report?.lockedMonths[key.slice(0, 7)];
              return <article key={entry.id} className="entry-line">
                <div className="entry-times">
                  <strong>{time.format(Date.parse(entry.started_at))} – {entry.ended_at ? time.format(Date.parse(entry.ended_at)) : "offen"}</strong>
                  <span>{entry.break_minutes} Min. Pause{entry.note && ` · ${entry.note}`}</span>
                </div>
                <div className="entry-net">{entry.ended_at ? `${duration(calculateEntry(entry.started_at, entry.ended_at, undefined, entry.break_minutes).workedMinutes)} Std.` : "–"}</div>
                <span className={`entry-status entry-status--${entry.status}`}>{statusText[entry.status]}</span>
                {unlocked && ["open", "recorded", "approved"].includes(entry.status) && (
                  <button type="button" disabled={pending} className="entry-edit" onClick={() => setCorrection(entry)}><Pencil size={15} aria-hidden="true" />Korrektur</button>
                )}
              </article>;
            })}
          </div>
        ))}
      </section>
        {correction && <section className={card}>
          <h2 className="text-lg font-semibold">{source ? "Buchung korrigieren" : "Zeit nachtragen"}</h2>
          <form key={source?.id ?? "new"} onSubmit={submitCorrection} className="mt-4 grid gap-3 sm:grid-cols-2">
            <label>Beginn<input type="datetime-local" name="started" required defaultValue={source ? localInput(source.started_at) : (mode === "week" ? monday : monthPeriod.toPlainDate({ day: 1 })).toString() + "T08:00"} className={field} /></label>
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
  );
}
