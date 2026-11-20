import { Temporal } from "@js-temporal/polyfill";
import { useEffect, useState } from "react";
import { CalendarDays, ChartNoAxesColumn, Plus } from "lucide-react";
import { type AbsenceType, berlinDate } from "../lib/work-time";
import { CalendarStaffReport } from "./staff-reports";
import { DepartmentBadge, type Department, type TeamGroup } from "./team";
import { supabase, type Profile } from "./supabase";
import { absenceColors, absenceLabels, absenceStatus, button, card, DateNavigation, dayLabel, field, listMembers, Message, monthLabel, monthNow, secondary, type Member, type Notice } from "./ui";

type CalendarEntry = {
  id: string; user_id: string; full_name: string; type: AbsenceType;
  start_date: string; end_date: string; status: keyof typeof absenceStatus; department: Department | null; group_ids: string[];
};
const kinds = Object.keys(absenceLabels) as AbsenceType[];
const weekdays = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];

function MonthGrid({ month, items, holidays, compact, selected, selectDay }: {
  month: Temporal.PlainYearMonth; items: CalendarEntry[]; compact: boolean;
  holidays: Map<string, string>; selected: string; selectDay: (day: string) => void;
}) {
  const first = month.toPlainDate({ day: 1 });
  const today = berlinDate(new Date().toISOString());
  const dayItems = Array.from({ length: month.daysInMonth }, (_, index) => {
    const value = first.add({ days: index });
    const day = value.toString();
    return { day, weekend: value.dayOfWeek > 5, holiday: holidays.get(day), number: index + 1, items: items.filter((item) => item.start_date <= day && item.end_date >= day) };
  });
  return (
    <div className={`calendar-grid ${compact ? "calendar-grid--compact" : ""}`}>
      {weekdays.map((label) => <div key={label} className="px-1 text-center font-medium text-slate-600">{label}</div>)}
      {Array.from({ length: first.dayOfWeek - 1 }, (_, index) => <span key={`pad-${index}`} aria-hidden="true" />)}
      {dayItems.map(({ day, number, holiday, weekend, items: entries }) => (
        <button key={day} type="button" aria-label={`${dayLabel(day)}${holiday ? ", " + holiday : ""}, ${entries.length} Abwesenheiten`}
          aria-pressed={selected === day} onClick={() => selectDay(day)}
          title={holiday} className={`calendar-cell ${weekend ? "calendar-weekend" : ""} ${holiday ? "calendar-holiday" : ""} ${selected === day ? "calendar-selected" : ""}`}>
          <span className={`calendar-day-number ${today === day ? "calendar-today" : ""}`}>{number}</span>
          {holiday && !compact && <span className="calendar-holiday-name" title={holiday}>{holiday}</span>}
          {compact ? <span className="flex min-h-1 justify-center gap-px" aria-hidden="true">
            {[...new Set(entries.map((item) => item.type))].map((kind) => <span key={kind} className={`h-1 w-1 rounded-full ${absenceColors[kind].split(" ")[0]}`} />)}
          </span> : (
            <>
              {entries.slice(0, 2).map((entry) => <span key={entry.id} title={`${entry.full_name} · ${absenceLabels[entry.type]}`} className={`mt-0.5 block truncate rounded px-0.5 ${absenceColors[entry.type]}`}>{entry.full_name}</span>)}
              {entries.length > 2 && <span className="text-slate-600">+{entries.length - 2}</span>}
            </>
          )}
        </button>
      ))}
    </div>
  );
}

export function Calendar({ profile, onRequest }: { profile: Profile; onRequest: () => void }) {
  const [month, setMonth] = useState(monthNow);
  const [yearMode, setYearMode] = useState(false);
  const [selectedDay, setSelectedDay] = useState("");
  const [filter, setFilter] = useState<AbsenceType[]>(kinds);
  const [member, setMember] = useState("");
  const [members, setMembers] = useState<Member[]>([]);
  const [entries, setEntries] = useState<CalendarEntry[]>([]);
  const [groups, setGroups] = useState<TeamGroup[]>([]);
  const [group, setGroup] = useState("");
  const [holidays, setHolidays] = useState(new Map<string, string>());
  const [showReport, setShowReport] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<Notice>();
  const admin = profile.role === "admin";

  useEffect(() => {
    if (!admin) return;
    const controller = new AbortController();
    void listMembers(controller.signal).then((rows) => {
      if (!controller.signal.aborted) setMembers(rows);
    }).catch(() => {
      if (!controller.signal.aborted) setLoadError({ text: "Mitarbeiterliste konnte nicht geladen werden.", error: true });
    });
    return () => controller.abort();
  }, [admin]);

  useEffect(() => {
    const controller = new AbortController();
    const selected = Temporal.PlainYearMonth.from(month);
    const first = (yearMode ? selected.with({ month: 1 }) : selected).toPlainDate({ day: 1 });
    const lastMonth = yearMode ? selected.with({ month: 12 }) : selected;
    const last = lastMonth.toPlainDate({ day: lastMonth.daysInMonth });
    setLoading(true);
    setLoadError(undefined);
    const params = { first_day: first.toString(), last_day: last.toString() };
    void Promise.all([
      supabase.rpc("team_calendar_details", params).abortSignal(controller.signal),
      supabase.rpc("company_holidays", params).abortSignal(controller.signal),
      supabase.from("team_groups").select("id,name").order("name").abortSignal(controller.signal),
    ]).then(([calendar, days, groupList]) => {
      if (controller.signal.aborted) return;
      if (calendar.error || days.error || groupList.error) {
        setLoadError({ text: "Der Teamkalender konnte nicht geladen werden. Prüfe, ob das aktuelle SQL-Update eingespielt ist.", error: true });
        setEntries([]); setHolidays(new Map()); setGroups([]);
      } else {
        setEntries(calendar.data as CalendarEntry[]);
        setHolidays(new Map((days.data as { day: string; name: string }[]).map((day) => [day.day, day.name])));
        setGroups(groupList.data as TeamGroup[]);
      }
      setLoading(false);
    });
    return () => controller.abort();
  }, [month, yearMode]);

  const currentMonth = Temporal.PlainYearMonth.from(month);
  const items = entries.filter((item) => filter.includes(item.type) && (!member || item.user_id === member) && (!group || item.group_ids.includes(group)));
  const details = items.filter((item) => !selectedDay || (item.start_date <= selectedDay && item.end_date >= selectedDay));
  function navigate(direction: number) {
    setSelectedDay("");
    setMonth(currentMonth.add(yearMode ? { years: direction } : { months: direction }).toString());
  }
  return (
    <div className="space-y-5">
      <section className={card}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="panel-heading flex items-center gap-2"><CalendarDays size={20} aria-hidden="true" />Kalenderübersicht</h2>
          <div className="flex flex-wrap gap-2">
            {admin && <button className={secondary} aria-expanded={showReport} onClick={() => { if (!showReport) requestAnimationFrame(() => document.getElementById("calendar-staff-report")?.scrollIntoView({ block: "start" })); setShowReport(!showReport); }}>
              <ChartNoAxesColumn size={17} aria-hidden="true" />{showReport ? "Admin-Auswertung ausblenden" : "Admin-Auswertung"}
            </button>}
            <button className={secondary} onClick={onRequest}><Plus size={17} aria-hidden="true" />Abwesenheit beantragen</button>
            <button className={yearMode ? secondary : button} aria-pressed={!yearMode} onClick={() => { setYearMode(false); setSelectedDay(""); }}>Monat</button>
            <button className={yearMode ? button : secondary} aria-pressed={yearMode} onClick={() => { setYearMode(true); setSelectedDay(""); }}>Jahr</button>
          </div>
        </div>
        <div className="my-4 flex flex-wrap items-center justify-between gap-3">
          <DateNavigation previous={() => navigate(-1)} next={() => navigate(1)}>{yearMode ? currentMonth.year : monthLabel(month)}</DateNavigation>
          <label>Teamgruppe<select className={field} value={group} onChange={(event) => setGroup(event.target.value)}>
            <option value="">Alle Gruppen</option>{groups.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select></label>
          {admin && <label>Mitarbeiter<select className={field} value={member} onChange={(event) => setMember(event.target.value)}>
            <option value="">Alle</option>{members.map((person) => <option key={person.id} value={person.id}>{person.full_name}</option>)}
          </select></label>}
        </div>
        <fieldset className="my-4 flex flex-wrap gap-3">
          <legend className="mb-2 text-sm font-medium">Abwesenheiten filtern</legend>
          {kinds.map((kind) => <label key={kind} className={`flex items-center gap-2 rounded px-2 py-1 text-sm ${absenceColors[kind]}`}>
            <input type="checkbox" checked={filter.includes(kind)} onChange={(event) => setFilter(event.target.checked ? [...filter, kind] : filter.filter((value) => value !== kind))} />{absenceLabels[kind]}
          </label>)}
        </fieldset>
        <Message notice={loadError} />
        {loading ? <p role="status">Kalender wird geladen …</p> : yearMode ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 12 }, (_, index) => currentMonth.with({ month: index + 1 })).map((item) => <section key={item.toString()} className="rounded border border-slate-200 p-2">
              <h3 className="mb-2 text-sm font-medium">{monthLabel(item.toString())}</h3>
              <MonthGrid month={item} compact items={items} holidays={holidays} selected={selectedDay} selectDay={(day) => { setMonth(day.slice(0, 7)); setYearMode(false); setSelectedDay(day); }} />
            </section>)}
          </div>
        ) : <MonthGrid month={currentMonth} items={items} holidays={holidays} compact={false} selected={selectedDay} selectDay={(day) => setSelectedDay(selectedDay === day ? "" : day)} />}
        {!loading && (!yearMode || selectedDay) && <div className="mt-4">
          <h3 className="font-medium">{selectedDay ? dayLabel(selectedDay) : "Abwesenheiten im Monat"}</h3>
          {selectedDay && holidays.has(selectedDay) && <p className="mt-2 text-sm font-semibold">{holidays.get(selectedDay)}</p>}
          {details.length ? <ul className="calendar-details">
            {details.map((item) => <li key={item.id}>
              <div><strong>{item.full_name}</strong> <DepartmentBadge department={item.department} />
                <p>{dayLabel(item.start_date)}{item.start_date !== item.end_date && ` bis ${dayLabel(item.end_date)}`} · {absenceStatus[item.status]}</p>
                {item.group_ids.length > 0 && <div className="calendar-group-tags">{groups.filter((group) => item.group_ids.includes(group.id)).map((group) => <span key={group.id}>{group.name}</span>)}</div>}
              </div>
              <span className={`rounded px-2 py-1 ${absenceColors[item.type]}`}>{absenceLabels[item.type]}</span>
            </li>)}
          </ul> : <p className="mt-2 text-sm text-slate-600">Keine Abwesenheiten für diese Auswahl.</p>}
        </div>}
      </section>
      {admin && showReport && <CalendarStaffReport members={members} month={month} />}
    </div>
  );
}
