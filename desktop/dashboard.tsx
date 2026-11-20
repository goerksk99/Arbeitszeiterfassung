import { CalendarDays, Check, ClipboardList, Clock3, X } from "lucide-react";
import { Temporal } from "@js-temporal/polyfill";
import { useEffect, useState } from "react";
import { COMPANY_ZONE, type AbsenceType } from "../lib/work-time";
import { isoWeek, weekMonday } from "../lib/iso-week";
import { Clock } from "./clock";
import { supabase, type Profile } from "./supabase";
import { absenceLabels, card, dayLabel, Message, secondary, type Notice } from "./ui";

type FinalStatus = "approved" | "rejected";
type Decision = { id: string; title: string; detail: string; status: FinalStatus; when: string };
type Leave = { type: AbsenceType; start_date: string; end_date: string };
type Data = { time: number; leave: number; decisions: Decision[]; absences: Leave[]; holidays: Map<string, string> };

export function Dashboard({ profile, onEntries, onCalendar, onRequests, onClockProblem }: {
  profile: Profile; onEntries: () => void; onCalendar: (day?: string) => void; onRequests: () => void; onClockProblem: () => void;
}) {
  const [data, setData] = useState<Data>();
  const [notice, setNotice] = useState<Notice>();
  const [refresh, setRefresh] = useState(0);
  const today = Temporal.Now.plainDateISO(COMPANY_ZONE).toString();
  const monday = weekMonday(isoWeek(Temporal.PlainDate.from(today)));
  const first = monday.toString();
  const last = monday.add({ days: 6 }).toString();

  useEffect(() => {
    if (notice?.error) return;
    const ticker = window.setInterval(() => setRefresh((value) => value + 1), 30000);
    return () => window.clearInterval(ticker);
  }, [notice?.error]);

  useEffect(() => {
    const controller = new AbortController();
    const signal = controller.signal;
    const id = profile.id;
    async function load() {
      const [time, leave, timeDecisions, leaveDecisions, absences, holidays] = await Promise.all([
        supabase.from("time_entries").select("id", { count: "exact", head: true }).eq("user_id", id).eq("status", "submitted").abortSignal(signal),
        supabase.from("absences").select("id", { count: "exact", head: true }).eq("user_id", id).eq("status", "submitted").abortSignal(signal),
        supabase.from("time_entries").select("id,started_at,status,created_at,decided_at")
          .eq("user_id", id).in("status", ["approved","rejected"]).not("correction_reason","is",null)
          .order("decided_at", { ascending: false, nullsFirst: false }).order("created_at", { ascending: false }).limit(10).abortSignal(signal),
        supabase.from("absences").select("id,type,start_date,end_date,status,created_at,decided_at")
          .eq("user_id", id).in("status", ["approved","rejected"])
          .order("decided_at", { ascending: false, nullsFirst: false }).order("created_at", { ascending: false }).limit(10).abortSignal(signal),
        supabase.from("absences").select("type,start_date,end_date").eq("user_id", id).eq("status","approved")
          .lte("start_date", last).gte("end_date", first).abortSignal(signal),
        supabase.rpc("company_holidays", { first_day: first, last_day: last }).abortSignal(signal),
      ]);
      if (signal.aborted) return;
      if ([time, leave, timeDecisions, leaveDecisions, absences, holidays].some((result) => result.error)) {
        setNotice({ text: "Die Anträge oder Kalenderdaten konnten nicht geladen werden. Prüfe, ob das neue SQL-Update ausgeführt wurde.", error: true });
        return;
      }
      const decisions: Decision[] = [
        ...(timeDecisions.data ?? []).map((item) => ({
          id: "time-" + item.id, title: "Zeitkorrektur",
          detail: dayLabel(Temporal.Instant.from(item.started_at).toZonedDateTimeISO(COMPANY_ZONE).toPlainDate().toString()),
          status: item.status as FinalStatus, when: item.decided_at ?? item.created_at,
        })),
        ...(leaveDecisions.data ?? []).map((item) => ({
          id: "leave-" + item.id, title: absenceLabels[item.type as AbsenceType],
          detail: dayLabel(item.start_date) + (item.end_date !== item.start_date ? " – " + dayLabel(item.end_date) : ""),
          status: item.status as FinalStatus, when: item.decided_at ?? item.created_at,
        })),
      ];
      setData({
        time: time.count ?? 0, leave: leave.count ?? 0,
        decisions: decisions.sort((a, b) => Date.parse(b.when) - Date.parse(a.when)).slice(0, 10),
        absences: (absences.data ?? []) as Leave[],
        holidays: new Map((holidays.data as { day: string; name: string }[]).map((item) => [item.day, item.name])),
      });
      setNotice(undefined);
    }
    void load().catch(() => {
      if (!signal.aborted) setNotice({ text: "Anträge und Kalenderdaten konnten nicht geladen werden.", error: true });
    });
    return () => controller.abort();
  }, [profile.id, first, last, refresh]);

  const count = (data?.time ?? 0) + (data?.leave ?? 0);
  const days = Array.from({ length: 7 }, (_, index) => monday.add({ days: index }));
  return <div className="dashboard">
    <Clock profile={profile} onEntries={onEntries} onTrayError={onClockProblem} />
    <Message notice={notice} />
    {notice && <button className={secondary} onClick={() => setRefresh((value) => value + 1)}>Erneut laden</button>}
    <div className="dashboard-grid">
      <section className={card}>
        <div className="dashboard-title"><CalendarDays size={19} aria-hidden="true" /><h2>Diese Woche</h2></div>
        <div className="dashboard-week">
          {days.map((day) => {
            const value = day.toString();
            const holiday = data?.holidays.get(value);
            const away = data?.absences.find((item) => item.start_date <= value && item.end_date >= value);
            const detail = holiday ?? (away ? absenceLabels[away.type] : "");
            return <button key={value} type="button" onClick={() => onCalendar(value)} aria-current={today === value ? "date" : undefined}
              aria-label={dayLabel(value) + (detail ? ", " + detail : "")} title={detail}
              className={`dashboard-day ${day.dayOfWeek > 5 ? "calendar-weekend" : ""}`}>
              <span>{day.toLocaleString("de-DE", { weekday: "short" })}</span>
              <strong>{day.day}</strong>
              {detail && <i aria-hidden="true" />}
            </button>;
          })}
        </div>
        <div className="dashboard-legend"><span aria-hidden="true" />Eigene Abwesenheit oder Feiertag</div>
        <button type="button" className={`${secondary} mt-4`} onClick={() => onCalendar()}>Teamkalender öffnen</button>
      </section>
      <section className={card}>
        <div className="dashboard-title"><ClipboardList size={19} aria-hidden="true" /><h2>Meine Anträge</h2></div>
        {data ? <>
          <p className="dashboard-count">{count}</p>
          <p className="dashboard-count-label">{count === 1 ? "Antrag wartet auf Prüfung" : "Anträge warten auf Prüfung"}</p>
          <div className="dashboard-actions">
            <button className={secondary} onClick={onRequests}>Abwesenheiten <span>{data.leave}</span></button>
            <button className={secondary} onClick={onEntries}>Zeitkorrekturen <span>{data.time}</span></button>
          </div>
        </> : <p className="muted-notice">{notice ? "Zurzeit keine Antragsübersicht verfügbar." : "Anträge werden geladen …"}</p>}
      </section>
    </div>
    <section className={card}>
      <div className="dashboard-title"><Clock3 size={19} aria-hidden="true" /><h2>Letzte Entscheidungen</h2></div>
      {data?.decisions.length ? <ul className="dashboard-decisions">{data.decisions.map((event) => (
        <li key={event.id}>
          <div><strong>{event.title}</strong><small>{event.detail}</small></div>
          <span className={`entry-status entry-status--${event.status}`}>
            {event.status === "approved" ? <Check size={14} aria-hidden="true" /> : <X size={14} aria-hidden="true" />}
            {event.status === "approved" ? "Genehmigt" : "Abgelehnt"}
          </span>
        </li>
      ))}</ul> : <p className="muted-notice">{data ? "Bisher keine Entscheidungen zu deinen Anträgen." : notice ? "Zurzeit keine Entscheidungen verfügbar." : "Entscheidungen werden geladen …"}</p>}
    </section>
  </div>;
}
