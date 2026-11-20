import { Temporal } from "@js-temporal/polyfill";
import { useEffect, useState, type FormEvent } from "react";
import { berlinDate, COMPANY_ZONE, type AbsenceType } from "../lib/work-time";
import { supabase, type Profile } from "./supabase";
import { DepartmentBadge, DepartmentOptions, type TeamGroup } from "./team";
import { duration, time } from "./time-display";
import { absenceLabels, button, card, dayLabel, field, listMembers, Message, requestError, secondary, type Member, type Notice } from "./ui";

const dateTime = new Intl.DateTimeFormat("de-DE", { timeZone: COMPANY_ZONE, dateStyle: "short", timeStyle: "short" });
type Correction = { id: string; user_id: string; started_at: string; ended_at: string; break_minutes: number; correction_reason: string; note: string | null };
type OpenEntry = { id: string; user_id: string; started_at: string };
type AbsenceRequest = { id: string; user_id: string; type: AbsenceType; start_date: string; end_date: string; note: string | null };
type Shift = OpenEntry & { ended_at: string | null };
type Membership = { group_id: string; user_id: string };
export type AdminSection = "status" | "requests" | "staff" | "break";
type ActivePause = { user_id: string; paused_at: string };
type Data = {
  members: Member[]; corrections: Correction[]; open: OpenEntry[]; paused: ActivePause[]; shifts: Shift[]; groups: TeamGroup[]; membership: Membership[];
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
      const [members, corrections, open, absences, awayToday, settings, pauses, shifts, groups, membership] = await Promise.all([
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
        supabase.from("team_groups").select("id,name").order("name").abortSignal(signal),
        supabase.from("team_group_members").select("group_id,user_id").abortSignal(signal),
      ]);
      const error = corrections.error ?? open.error ?? absences.error ?? awayToday.error ?? settings.error ?? shifts.error ?? groups.error ?? membership.error ?? (pauses.error?.code === "PGRST202" ? null : pauses.error);
      if (error) throw error;
      if (signal.aborted) return;
      setData({
        members, corrections: corrections.data as Correction[], open: open.data as OpenEntry[],
        absences: absences.data as AbsenceRequest[], awayToday: awayToday.data as AbsenceRequest[],
        settings: settings.data!, paused: (pauses.data ?? []) as ActivePause[],
        shifts: shifts.data as Shift[], groups: groups.data as TeamGroup[], membership: membership.data as Membership[],
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
      const { error } = await supabase.rpc("save_staff_details", {
        member_id: member.id, member_name: name, hours: Number(values.get("hours")), leave_days: Number(values.get("leave")),
        active: member.id === profile.id || values.has("active"), member_department: String(values.get("department") ?? ""),
        group_ids: values.getAll("group").map(String),
      });
      if (error) throw error;
    }, "Mitarbeiterprofil gespeichert.");
  }

  function addGroup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const name = String(new FormData(form).get("name") ?? "").trim();
    if (!name) return;
    void change(async () => {
      const { error } = await supabase.from("team_groups").insert({ name });
      if (error?.code === "23505") throw { code: "P0001", message: "Eine Teamgruppe mit diesem Namen gibt es bereits." };
      if (error) throw error;
      form.reset();
    }, "Teamgruppe angelegt.");
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
        name: String(values.get("name")).trim(), email: String(values.get("email")).trim(), password: String(values.get("password")), department: String(values.get("department")),
      }});
      if (error) {
        const response = "context" in error ? error.context : undefined;
        const detail = response instanceof Response ? await response.json().catch(() => null) : null;
        setNotice({ text: detail?.error ?? "Das Konto konnte nicht angelegt werden. Prüfe, ob die Supabase-Funktion manage-employee bereitgestellt ist.", error: true });
        return;
      }
      form.reset();
      setNotice({ text: "Mitarbeiterkonto angelegt. Gib das Startpasswort persönlich weiter." });
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

  return (
    <div className="space-y-5">
      <Message notice={notice ?? loadError} />
      {section === "status" && <section className={card}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">Teamstatus heute</h2>
          <button className={secondary} disabled={busy} onClick={reload}>Aktualisieren</button>
        </div>
        <ul className="mt-3 divide-y divide-slate-200">
          {data.members.filter((member) => member.is_active).map((member) => {
            const open = data.open.find((entry) => entry.user_id === member.id);
            const away = data.awayToday.find((entry) => entry.user_id === member.id);
            const paused = data.paused.find((pause) => pause.user_id === member.id);
            const shifts = data.shifts.filter((shift) => shift.user_id === member.id);
            const booked = shifts.map((shift) => shift.started_at).filter((stamp) => berlinDate(stamp) === today).sort();
            const ended = shifts.flatMap((shift) => shift.ended_at ? [shift.ended_at] : []).filter((stamp) => berlinDate(stamp) === today).sort();
            return <li key={member.id} className="staff-status-row">
              <div><strong>{member.full_name}</strong><div><DepartmentBadge department={member.department} /></div></div>
              <div><small>Erstes Einstempeln</small><strong>{booked[0] ? time.format(Date.parse(booked[0])) + " Uhr" : "–"}</strong></div>
              <div><small>Letztes Ausstempeln</small><strong>{ended.length ? time.format(Date.parse(ended.at(-1)!)) + " Uhr" : "–"}</strong></div>
              <span className={`entry-status ${paused ? "entry-status--rejected" : open ? "entry-status--recorded" : ""}`}>
                {paused ? <PauseTimer startedAt={paused.paused_at} /> : open ? (berlinDate(open.started_at) === today ? "Eingestempelt" : "Offene Buchung vom Vortag")
                  : away ? "Abwesend · " + absenceLabels[away.type] : "Ausgestempelt"}
              </span>
            </li>;
          })}
        </ul>
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
        {data.members.map((member) => <details key={member.id} className="staff-member-details">
          <summary><strong>{member.full_name}</strong> <DepartmentBadge department={member.department} /></summary>
          <form onSubmit={(event) => saveMember(event, member)} className="grid items-end gap-3 p-4 sm:grid-cols-2">
          <label>Name<input className={field} name="name" defaultValue={member.full_name} required maxLength={120} /></label>
          <label>Wochenstunden<input className={field} name="hours" type="number" min="0" max="168" step="0.01" defaultValue={member.weekly_hours} required /></label>
          <label>Jahresurlaub (Tage)<input className={field} name="leave" type="number" min="0" max="366" step="0.01" defaultValue={member.annual_leave_days} required /></label>
          <label>Abteilung<select className={field} name="department" defaultValue={member.department ?? ""}><DepartmentOptions optional /></select></label>
          {data.groups.length > 0 && <fieldset className="sm:col-span-2">
            <legend className="text-sm font-semibold">Teamgruppen</legend>
            <div className="mt-2 flex flex-wrap gap-3">{data.groups.map((group) => <label key={group.id} className="flex items-center gap-1.5">
              <input type="checkbox" name="group" value={group.id} defaultChecked={data.membership.some((row) => row.user_id === member.id && row.group_id === group.id)} />{group.name}
            </label>)}</div>
          </fieldset>}
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
        </details>)}
        <h3 className="mt-6 font-medium">Mitarbeiterkonto anlegen</h3>
        <form onSubmit={createMember} className="mt-3 grid gap-3 sm:grid-cols-2">
          <label>Name<input className={field} name="name" required maxLength={120} /></label>
          <label>E-Mail-Adresse<input className={field} name="email" type="email" required /></label>
          <label>Abteilung<select name="department" className={field} defaultValue="" required><DepartmentOptions /></select></label>
          <label>Startpasswort<input className={field} name="password" type="password" minLength={12} maxLength={72} required autoComplete="new-password" /></label>
          <div className="self-end"><button className={button} disabled={busy}>Konto anlegen</button></div>
        </form>
      </section>
      <section className={card}>
        <h2 className="text-lg font-semibold">Teamgruppen</h2>
        {data.groups.length > 0 && <ul className="request-history">{data.groups.map((group) => <li key={group.id}><span>{group.name}</span>
          <button className={secondary} type="button" disabled={busy} onClick={() => {
            if (!window.confirm(`Teamgruppe „${group.name}“ löschen?`)) return;
            void change(async () => {
              const { error } = await supabase.from("team_groups").delete().eq("id", group.id).select("id").single();
              if (error) throw error;
            }, "Teamgruppe gelöscht.");
          }}>Löschen</button>
        </li>)}</ul>}
        <form onSubmit={addGroup} className="mt-4 flex flex-wrap items-end gap-3">
          <label>Gruppenname<input name="name" className={field} maxLength={60} required /></label>
          <button className={button} disabled={busy}>Teamgruppe anlegen</button>
        </form>
      </section>
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


function PauseTimer({ startedAt }: { startedAt: string }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000));
  return <span className="team-pause-timer">In Pause · {duration(Math.floor(seconds / 60))}:{String(seconds % 60).padStart(2, "0")}</span>;
}
