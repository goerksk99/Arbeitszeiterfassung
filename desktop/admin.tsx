import { Clock3 } from "lucide-react";
import { Temporal } from "@js-temporal/polyfill";
import { useEffect, useState, type FormEvent } from "react";
import { berlinDate, COMPANY_ZONE, type AbsenceType } from "../lib/work-time";
import { supabase, type Profile } from "./supabase";
import { DepartmentBadge, DepartmentOptions } from "./team";
import { PauseDetails, type BreakInterval } from "./pause-details";
import { duration, time } from "./time-display";
import { absenceLabels, button, card, dayLabel, field, listMembers, Message, requestError, secondary, type Member, type Notice } from "./ui";

const dateTime = new Intl.DateTimeFormat("de-DE", { timeZone: COMPANY_ZONE, dateStyle: "short", timeStyle: "short" });
type Correction = { id: string; user_id: string; started_at: string; ended_at: string; break_minutes: number; correction_reason: string; note: string | null };
type OpenEntry = { id: string; user_id: string; started_at: string };
type AbsenceRequest = { id: string; user_id: string; type: AbsenceType; start_date: string; end_date: string; note: string | null };
type Shift = OpenEntry & { ended_at: string | null };
export type AdminSection = "status" | "requests" | "staff" | "break";
type ActivePause = { user_id: string; paused_at: string };
type Data = {
  members: Member[]; corrections: Correction[]; open: OpenEntry[]; paused: ActivePause[]; shifts: Shift[]; breaks: BreakInterval[];
  absences: AbsenceRequest[]; awayToday: AbsenceRequest[];
  settings: { auto_break_start: string; auto_break_minutes: number };
};

export function Admin({ profile, section, onChanged }: { profile: Profile; section: AdminSection; onChanged: () => void }) {
  const [data, setData] = useState<Data>();
  const [loadError, setLoadError] = useState<Notice>();
  const [notice, setNotice] = useState<Notice>();
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [resolving, setResolving] = useState<OpenEntry | null>(null);
  const today = berlinDate(new Date().toISOString());
  const reload = () => setRefresh((value) => value + 1);

  useEffect(() => {
    const timer = setInterval(() => setRefresh((value) => value + 1), 30000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (profile.role !== "admin") return;
    const controller = new AbortController();
    async function load() {
      const signal = controller.signal;
      const day = Temporal.PlainDate.from(today);
      const from = day.toZonedDateTime(COMPANY_ZONE).toInstant().toString();
      const until = day.add({ days: 1 }).toZonedDateTime(COMPANY_ZONE).toInstant().toString();
      const [members, corrections, open, absences, awayToday, settings, pauses, shifts, breaks] = await Promise.all([
        listMembers(signal),
        supabase.from("time_entries").select("id,user_id,started_at,ended_at,break_minutes,correction_reason,note").eq("status", "submitted").order("created_at").abortSignal(signal),
        supabase.from("time_entries").select("id,user_id,started_at").eq("status", "open").abortSignal(signal),
        supabase.from("absences").select("id,user_id,type,start_date,end_date,note").eq("status", "submitted").order("created_at").abortSignal(signal),
        supabase.from("absences").select("id,user_id,type,start_date,end_date,note").eq("status", "approved").lte("start_date", today).gte("end_date", today).abortSignal(signal),
        supabase.from("company_settings").select("auto_break_start,auto_break_minutes").eq("id", 1).abortSignal(signal).single(),
        supabase.rpc("admin_pause_details").abortSignal(signal),
        supabase.from("time_entries").select("id,user_id,started_at,ended_at").is("corrects_entry_id", null)
          .in("status", ["open","recorded","approved"])
          .or(`and(started_at.gte.${from},started_at.lt.${until}),and(ended_at.gte.${from},ended_at.lt.${until})`)
          .abortSignal(signal),
        supabase.rpc("read_shift_breaks", { member_id: null, first_day: today, last_day: today }).abortSignal(signal),
      ]);
      const error = corrections.error ?? open.error ?? absences.error ?? awayToday.error ?? settings.error ?? shifts.error ?? breaks.error ?? (pauses.error?.code === "PGRST202" ? null : pauses.error);
      if (error) throw error;
      if (signal.aborted) return;
      setData({
        members, corrections: corrections.data as Correction[], open: open.data as OpenEntry[],
        absences: absences.data as AbsenceRequest[], awayToday: awayToday.data as AbsenceRequest[],
        settings: settings.data!, paused: (pauses.data ?? []) as ActivePause[],
        shifts: shifts.data as Shift[], breaks: breaks.data as BreakInterval[],
      });
      setLoadError(undefined);
    }
    void load().catch(() => {
      if (!controller.signal.aborted) setLoadError({ text: "Das Admin-Dashboard konnte nicht geladen werden.", error: true });
    });
    return () => controller.abort();
  }, [profile.role, refresh, today]);

  async function change(action: () => Promise<void>, success: string) {
    if (busy) return;
    setBusy(true);
    setNotice(undefined);
    try {
      await action();
      setNotice({ text: success });
      reload();
      onChanged();
    } catch (error) { setNotice({ text: requestError(error), error: true }); }
    finally { setBusy(false); }
  }

  function review(kind: "correction" | "absence", id: string, accept: boolean) {
    void change(async () => {
      const result = kind === "correction"
        ? await supabase.rpc("review_correction", { entry_id: id, accept })
        : await supabase.rpc("review_absence", { absence_id: id, accept });
      if (result.error) throw result.error;
    }, accept ? "Antrag genehmigt." : "Antrag abgelehnt.");
  }

  function resolve(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!resolving) return;
    const values = new FormData(event.currentTarget);
    const reason = String(values.get("reason") ?? "").trim();
    let end;
    try {
      end = Temporal.PlainDateTime.from(String(values.get("end")))
        .toZonedDateTime(COMPANY_ZONE, { disambiguation: "reject" }).toInstant();
      if (Temporal.Instant.compare(end, Temporal.Instant.from(resolving.started_at)) <= 0 || !reason) throw new RangeError();
    } catch {
      setNotice({ text: "Bitte gib eine gültige Endzeit nach dem Beginn und eine Begründung ein.", error: true });
      return;
    }
    const pause = String(values.get("pause") ?? "");
    void change(async () => {
      const { error } = await supabase.rpc("resolve_open_entry", {
        entry_id: resolving.id, corrected_end: end.toString(), reason, adjusted_break: pause === "" ? null : Number(pause),
      });
      if (error) throw error;
      setResolving(null);
    }, "Offene Buchung abgeschlossen.");
  }

  function saveMember(event: FormEvent<HTMLFormElement>, member: Member) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const name = String(values.get("name") ?? "").trim();
    if (!name) return;
    void change(async () => {
      const { error } = await supabase.rpc("update_staff_settings", {
        member_id: member.id, member_name: name, hours: Number(values.get("hours")), leave_days: Number(values.get("leave")),
        active: member.id === profile.id || values.has("active"), member_department: String(values.get("department") ?? ""),
        automatic_lunch: values.has("automatic_lunch"),
      });
      if (error) throw error;
    }, "Mitarbeiterprofil gespeichert.");
  }

  function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    void change(async () => {
      const { error } = await supabase.from("company_settings").update({
        auto_break_start: String(values.get("start")), auto_break_minutes: Number(values.get("minutes")),
      }).eq("id", 1).select("id").single();
      if (error) throw error;
    }, "Pauseneinstellung gespeichert.");
  }

  async function createMember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    const values = new FormData(form);
    setBusy(true);
    setNotice(undefined);
    try {
      const { error } = await supabase.functions.invoke("manage-employee", { body: {
        name: String(values.get("name")).trim(), email: String(values.get("email")).trim(), department: String(values.get("department")),
        action: "invite", automaticLunch: values.has("automatic_lunch"),
      }});
      if (error) {
        const response = "context" in error ? error.context : undefined;
        const detail = response instanceof Response ? await response.json().catch(() => null) : null;
        setNotice({ text: detail?.error ?? "Das Konto konnte nicht angelegt werden. Prüfe, ob die Supabase-Funktion manage-employee bereitgestellt ist.", error: true });
        return;
      }
      form.reset();
      setNotice({ text: "Einladung an die Geschäftsadresse gesendet." });
      reload();
    } catch {
      setNotice({ text: "Das Konto konnte nicht angelegt werden.", error: true });
    } finally { setBusy(false); }
  }

  function resetPassword(event: FormEvent<HTMLFormElement>, member: Member) {
    event.preventDefault();
    const form = event.currentTarget;
    const password = String(new FormData(form).get("password") ?? "");
    void change(async () => {
      const { error } = await supabase.functions.invoke("manage-employee", {
        body: { action: "reset-password", memberId: member.id, password },
      });
      if (error) {
        const response = "context" in error ? error.context : undefined;
        const detail = response instanceof Response ? await response.json().catch(() => null) : null;
        throw { code: "P0001", message: detail?.error ?? "Das Passwort konnte nicht zurückgesetzt werden. Prüfe, ob die Edge-Funktion aktualisiert ist." };
      }
      form.reset();
      form.closest("details")?.removeAttribute("open");
    }, "Neues Startpasswort gesetzt. Gib es persönlich weiter.");
  }

  if (profile.role !== "admin") return null;
  if (!data) return <section className={card}>
    <h2 className="text-lg font-semibold">Admin</h2>
    {loadError ? <><Message notice={loadError} /><button className={secondary} onClick={reload}>Erneut laden</button></> : <p role="status">Dashboard wird geladen …</p>}
  </section>;

  const name = (id: string) => data.members.find((member) => member.id === id)?.full_name ?? "Unbekannt";
  const stale = data.open.filter((entry) => berlinDate(entry.started_at) < today);
  const applications = data.corrections.length + data.absences.length;
  function decision(kind: "correction" | "absence", id: string) {
    return <div className="flex flex-wrap gap-2">
      <button className={button} disabled={busy} onClick={() => review(kind, id, true)}>Genehmigen</button>
      <button className={secondary} disabled={busy} onClick={() => review(kind, id, false)}>Ablehnen</button>
    </div>;
  }

  function memberCard(member: Member) {
    return <details key={member.id} className="staff-member-details">
          <summary><strong>{member.full_name}</strong> <DepartmentBadge department={member.department} /></summary>
          <form onSubmit={(event) => saveMember(event, member)} className="grid items-end gap-3 p-4 sm:grid-cols-2">
          <label>Name<input className={field} name="name" defaultValue={member.full_name} required maxLength={120} /></label>
          <label>Wochenstunden<input className={field} name="hours" type="number" min="0" max="168" step="0.01" defaultValue={member.weekly_hours} required /></label>
          <label>Jahresurlaub (Tage)<input className={field} name="leave" type="number" min="0" max="366" step="0.01" defaultValue={member.annual_leave_days} required /></label>
          <label>Abteilung<select className={field} name="department" defaultValue={member.department ?? ""}><DepartmentOptions optional /></select></label>
          <label className="flex items-center gap-2"><input name="automatic_lunch" type="checkbox" defaultChecked={member.automatic_lunch_break} />Automatische Mittagspause</label>
          <label className="py-2"><input name="active" type="checkbox" defaultChecked={member.is_active} disabled={profile.id === member.id} className="mr-2" />Aktiv</label>
          <button className={secondary} disabled={busy}>Speichern</button>
          </form>
          {member.role === "employee" && member.is_active && <details className="staff-reset">
            <summary>Passwort zurücksetzen</summary>
            <form onSubmit={(event) => resetPassword(event, member)} className="mt-3 flex flex-wrap items-end gap-3">
              <label>Neues Startpasswort<input className={field} name="password" type="password" autoComplete="new-password" minLength={12} maxLength={72} required /></label>
              <button className={secondary} disabled={busy}>Startpasswort setzen</button>
            </form>
          </details>}
        </details>;
  }

  return (
    <div className="space-y-5">
      <Message notice={notice ?? loadError} />
      {section === "status" && <section className={card}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">Teamstatus heute</h2>
          <button className={secondary} disabled={busy} onClick={reload}>Aktualisieren</button>
        </div>
        <div className="team-clock-grid">
          {data.members.filter((member) => member.is_active).map((member) => {
            const open = data.open.find((item) => item.user_id === member.id);
            const away = data.awayToday.find((item) => item.user_id === member.id);
            const paused = data.paused.find((item) => item.user_id === member.id);
            const shifts = data.shifts.filter((item) => item.user_id === member.id);
            const starts = shifts.map((item) => item.started_at).filter((stamp) => berlinDate(stamp) === today).map(Date.parse);
            const ends = shifts.flatMap((item) => item.ended_at ? [item.ended_at] : []).filter((stamp) => berlinDate(stamp) === today).map(Date.parse);
            return <TeamClock key={member.id} member={member} open={open} away={away}
              pauseStart={paused?.paused_at} breaks={data.breaks.filter((item) => item.user_id === member.id)} first={starts.length ? Math.min(...starts) : undefined}
              last={ends.length ? Math.max(...ends) : undefined} />;
          })}
        </div>
      </section>}
      {section === "requests" && <section className={card}>
        <h2 className="text-lg font-semibold">Anträge und offene Buchungen</h2>
        {(applications > 0 || stale.length > 0) && <p role="status" className="submission-notice">
          {applications > 0 && (applications === 1 ? "1 Antrag wartet auf Prüfung." : `${applications} Anträge warten auf Prüfung.`)}
          {stale.length > 0 && ` ${stale.length} ${stale.length === 1 ? "vergessene Ausstempelzeit" : "vergessene Ausstempelzeiten"}.`}
        </p>}
        {!data.corrections.length && !data.absences.length && !stale.length && <p className="mt-2">Keine offenen Anträge oder vergessenen Ausstempelzeiten.</p>}
        {data.corrections.map((entry) => <article key={entry.id} className="mt-3 space-y-2 rounded border border-slate-200 p-3">
          <h3 className="font-medium">Zeitkorrektur · {name(entry.user_id)}</h3>
          <p>{dateTime.format(Date.parse(entry.started_at))} bis {dateTime.format(Date.parse(entry.ended_at))} · {entry.break_minutes} Min. Pause</p>
          <p className="break-words text-sm">{entry.correction_reason}</p>
          {entry.note && <p className="break-words text-sm">Notiz · {entry.note}</p>}
          {decision("correction", entry.id)}
        </article>)}
        {data.absences.map((entry) => <article key={entry.id} className="mt-3 space-y-2 rounded border border-slate-200 p-3">
          <h3 className="font-medium">{absenceLabels[entry.type]} · {name(entry.user_id)}</h3>
          <p>{dayLabel(entry.start_date)} bis {dayLabel(entry.end_date)}</p>
          {entry.note && <p className="break-words text-sm">{entry.note}</p>}
          {decision("absence", entry.id)}
        </article>)}
        {stale.map((entry) => <article key={entry.id} className="mt-3 space-y-2 rounded border border-slate-200 p-3">
          <h3 className="font-medium">Vergessen auszustempeln · {name(entry.user_id)}</h3>
          <p>Offen seit {dateTime.format(Date.parse(entry.started_at))}</p>
          {resolving?.id === entry.id ? <form onSubmit={resolve} className="grid gap-3 sm:grid-cols-2">
            <label>Berliner Endzeit<input className={field} name="end" type="datetime-local" required /></label>
            <label>Pause in Minuten<input className={field} name="pause" type="number" min="0" step="1" placeholder="Automatisch" /></label>
            <label className="sm:col-span-2">Begründung<input className={field} name="reason" required maxLength={1000} /></label>
            <div className="flex flex-wrap gap-2 sm:col-span-2">
              <button className={button} disabled={busy}>Buchung abschließen</button>
              <button className={secondary} type="button" disabled={busy} onClick={() => setResolving(null)}>Abbrechen</button>
            </div>
          </form> : <button className={secondary} disabled={busy} onClick={() => setResolving(entry)}>Endzeit eintragen</button>}
        </article>)}
      </section>}
      {section === "staff" && <>
      <section className={card}>
        <h2 className="text-lg font-semibold">Mitarbeiter verwalten</h2>
        {data.members.filter((member) => member.is_active).map(memberCard)}
        <h3 className="mt-6 font-medium">Mitarbeiterkonto anlegen</h3>
        <form onSubmit={createMember} className="mt-3 grid gap-3 sm:grid-cols-2">
          <label>Name<input className={field} name="name" required maxLength={120} /></label>
          <label>E-Mail-Adresse<input className={field} name="email" type="email" required /></label>
          <label>Abteilung<select name="department" className={field} defaultValue="" required><DepartmentOptions /></select></label>
          <label className="flex items-center gap-2"><input name="automatic_lunch" type="checkbox" defaultChecked />Automatische Mittagspause</label>
          <div className="self-end"><button className={button} disabled={busy}>Einladung per E-Mail senden</button></div>
        </form>
      </section>
      {data.members.some((member) => !member.is_active) && <section className={`${card} inactive-staff`}>
        <details>
          <summary>Inaktive Mitarbeitende <span className="entry-status">{data.members.filter((member) => !member.is_active).length}</span></summary>
          <p className="muted-notice">Die Anmeldung ist gesperrt. Buchungen und Monatsnachweise bleiben erhalten.</p>
          {data.members.filter((member) => !member.is_active).map(memberCard)}
        </details>
      </section>}
      </>}
      {section === "break" && <section className={card}>
        <h2 className="text-lg font-semibold">Automatische Mittagspause</h2>
        <form onSubmit={saveSettings} className="mt-3 grid gap-3 sm:grid-cols-2">
          <label>Pausenbeginn<input className={field} name="start" type="time" defaultValue={data.settings.auto_break_start.slice(0, 5)} required /></label>
          <label>Dauer in Minuten<input className={field} name="minutes" type="number" min="0" max="1440" step="1" defaultValue={data.settings.auto_break_minutes} required /></label>
          <div><button className={button} disabled={busy}>Pause speichern</button></div>
        </form>
      </section>}
    </div>
  );
}


function TeamClock({ member, open, away, pauseStart, breaks, first, last }: {
  member: Member; open?: OpenEntry; away?: AbsenceRequest; pauseStart?: string; breaks: BreakInterval[]; first?: number; last?: number;
}) {
  const [now, setNow] = useState(Date.now);
  const runningSince = pauseStart ?? open?.started_at;
  useEffect(() => {
    if (!runningSince) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [runningSince]);

  const status = pauseStart ? "In Pause" : open ? "Eingestempelt" : away ? "Abwesend" : "Ausgestempelt";
  const seconds = runningSince ? Math.max(0, Math.floor((now - Date.parse(runningSince)) / 1000)) : 0;
  const counter = `${duration(Math.floor(seconds / 60)).padStart(5, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  return <article className={`team-clock ${pauseStart ? "team-clock--pause" : open ? "team-clock--work" : ""}`}>
    <header><div><h3>{member.full_name}</h3><DepartmentBadge department={member.department} /></div><Clock3 size={21} aria-hidden="true" /></header>
    <span className={`status-chip ${pauseStart ? "status-chip--pause" : open ? "status-chip--work" : ""}`}><span aria-hidden="true" />{status}</span>
    {runningSince ? <>
      <p className="team-clock-counter">{counter}</p>
      <p className="team-clock-caption">{pauseStart ? "Laufende Pause" : "Seit Einstempeln"} · {time.format(Date.parse(runningSince))} Uhr</p>
    </> : <p className="team-clock-caption">{away ? absenceLabels[away.type] : "Keine offene Buchung"}</p>}
    <PauseDetails breaks={breaks} className="pause-history team-clock-breaks" />
    <dl><div><dt>Erstes Einstempeln</dt><dd>{first !== undefined ? time.format(first) + " Uhr" : "–"}</dd></div>
      <div><dt>Letztes Ausstempeln</dt><dd>{last !== undefined ? time.format(last) + " Uhr" : "–"}</dd></div></dl>
  </article>;
}
