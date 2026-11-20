import { Temporal } from "@js-temporal/polyfill";
import { useEffect, useState } from "react";
import { type AbsenceType } from "../lib/work-time";
import { supabase, type Profile } from "./supabase";
import { absenceColors, absenceLabels, absenceStatus, button, card, DateNavigation, dayLabel, field, listMembers, Message, monthLabel, monthNow, secondary, type Member, type Notice } from "./ui";

type CalendarEntry = {
  id: string; user_id: string; full_name: string; type: AbsenceType;
  start_date: string; end_date: string; status: keyof typeof absenceStatus;
};
const kinds = Object.keys(absenceLabels) as AbsenceType[];
const weekdays = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];

function MonthGrid({ month, items, compact, selected, selectDay }: {
  month: Temporal.PlainYearMonth; items: CalendarEntry[]; compact: boolean;
  selected: string; selectDay: (day: string) => void;
}) {
  const first = month.toPlainDate({ day: 1 });
  const dayItems = Array.from({ length: month.daysInMonth }, (_, index) => {
    const day = first.add({ days: index }).toString();
    return { day, number: index + 1, items: items.filter((item) => item.start_date <= day && item.end_date >= day) };
  });
  return (
    <div className={compact ? "grid grid-cols-7 gap-0.5 text-xs" : "grid grid-cols-7 gap-1 text-xs sm:text-sm"}>
      {weekdays.map((label) => <div key={label} className="px-1 text-center font-medium text-slate-600">{label}</div>)}
      {Array.from({ length: first.dayOfWeek - 1 }, (_, index) => <span key={`pad-${index}`} aria-hidden="true" />)}
      {dayItems.map(({ day, number, items: entries }) => (
        <button key={day} type="button" aria-label={`${dayLabel(day)}, ${entries.length} Abwesenheiten`}
          aria-pressed={selected === day} onClick={() => selectDay(day)}
          className={`min-w-0 rounded border p-1 ${compact ? "min-h-7 text-center" : "min-h-16 text-left sm:min-h-20"} ${selected === day ? "border-teal-600 bg-teal-50" : "border-slate-200 bg-white"}`}>
          <span className="block font-medium">{number}</span>
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
    void supabase.rpc("team_calendar", { first_day: first.toString(), last_day: last.toString() })
      .abortSignal(controller.signal).then(({ data, error }) => {
        if (controller.signal.aborted) return;
        if (error) {
          setLoadError({ text: "Der Teamkalender konnte nicht geladen werden.", error: true });
          setEntries([]);
        } else setEntries(data as CalendarEntry[]);
        setLoading(false);
      });
    return () => controller.abort();
  }, [month, yearMode]);

  const currentMonth = Temporal.PlainYearMonth.from(month);
  const items = entries.filter((item) => filter.includes(item.type) && (!member || item.user_id === member));
  const details = items.filter((item) => !selectedDay || (item.start_date <= selectedDay && item.end_date >= selectedDay));
  function navigate(direction: number) {
    setSelectedDay("");
    setMonth(currentMonth.add(yearMode ? { years: direction } : { months: direction }).toString());
  }
  return (
    <div className="space-y-5">
      <section className={card}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">Teamkalender</h2>
          <div className="flex flex-wrap gap-2">
            <button className={secondary} onClick={onRequest}>Abwesenheit beantragen</button>
            <button className={yearMode ? secondary : button} aria-pressed={!yearMode} onClick={() => { setYearMode(false); setSelectedDay(""); }}>Monat</button>
            <button className={yearMode ? button : secondary} aria-pressed={yearMode} onClick={() => { setYearMode(true); setSelectedDay(""); }}>Jahr</button>
          </div>
        </div>
        <div className="my-4 flex flex-wrap items-center justify-between gap-3">
          <DateNavigation previous={() => navigate(-1)} next={() => navigate(1)}>{yearMode ? currentMonth.year : monthLabel(month)}</DateNavigation>
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
              <MonthGrid month={item} compact items={items} selected={selectedDay} selectDay={(day) => { setMonth(day.slice(0, 7)); setYearMode(false); setSelectedDay(day); }} />
            </section>)}
          </div>
        ) : <MonthGrid month={currentMonth} items={items} compact={false} selected={selectedDay} selectDay={(day) => setSelectedDay(selectedDay === day ? "" : day)} />}
        {!loading && (!yearMode || selectedDay) && <div className="mt-4">
          <h3 className="font-medium">{selectedDay ? dayLabel(selectedDay) : "Abwesenheiten im Monat"}</h3>
          {details.length ? <ul className="mt-2 space-y-1 text-sm">
            {details.map((item) => <li key={item.id}>
              <span className={`rounded px-1 ${absenceColors[item.type]}`}>{absenceLabels[item.type]}</span> {item.full_name} · {dayLabel(item.start_date)}{item.start_date !== item.end_date && ` bis ${dayLabel(item.end_date)}`} · {absenceStatus[item.status]}
            </li>)}
          </ul> : <p className="mt-2 text-sm text-slate-600">Keine Abwesenheiten für diese Auswahl.</p>}
        </div>}
      </section>
    </div>
  );
}
