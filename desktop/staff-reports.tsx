import { useEffect, useState } from "react";
import { Temporal } from "@js-temporal/polyfill";
import type { MonthlyReport } from "../lib/monthly-report";
import type { AbsenceType } from "../lib/work-time";
import { supabase } from "./supabase";
import { DepartmentBadge } from "./team";
import { duration } from "./time-display";
import { absenceLabels, card, dayLabel, field, Message, monthLabel, requestError, type Member, type Notice } from "./ui";

type DailyRow = {
  day: string; target_minutes: number; worked_minutes: number; break_minutes: number;
  difference_minutes: number; holiday: string | null; absence_type: AbsenceType | null;
};
type DailyReport = { days: DailyRow[]; archived: boolean; reconstructed: boolean };

export function signedDuration(value: number) { return value > 0 ? "+" + duration(value) : duration(value); }

export function DailyReportTable({ member, month, refresh }: { member: string; month: string; refresh: number }) {
  const [data, setData] = useState<DailyReport>();
  const [notice, setNotice] = useState<Notice>();
  useEffect(() => {
    const controller = new AbortController();
    const selected = Temporal.PlainYearMonth.from(month);
    void supabase.rpc("read_daily_report", {
      member_id: member, report_year: selected.year, report_month: selected.month,
    }).abortSignal(controller.signal).then(({ data, error }) => {
      if (controller.signal.aborted) return;
      if (error) setNotice({ text: requestError(error), error: true });
      else setData(data as DailyReport);
    });
    return () => controller.abort();
  }, [member, month, refresh]);

  if (notice) return <Message notice={notice} />;
  if (!data) return <p role="status" className="muted-notice">Tageswerte werden geladen …</p>;
  if (!data.days.length) return <p className="muted-notice">Für diesen Monat liegen noch keine Buchungstage vor.</p>;
  const today = Temporal.Now.plainDateISO("Europe/Berlin").toString();
  return <div className="mt-6">
    <h3 className="panel-heading">Tagesübersicht · {monthLabel(month)}</h3>
    {today.slice(0, 7) === month && <p className="muted-notice">Stand {dayLabel(today)} · einschließlich heute</p>}
    {data.reconstructed && <p className="muted-notice">Dieser Monat wurde vor dem Update abgeschlossen. Die Tageswerte sind rekonstruiert, die gespeicherte Monatssumme gilt.</p>}
    <div className="overflow-x-auto">
      <table className="daily-report">
        <thead><tr><th>Datum</th><th>Ist</th><th>Soll</th><th>Differenz</th><th>Hinweis</th></tr></thead>
        <tbody>{data.days.map((row) => {
          const day = Temporal.PlainDate.from(row.day);
          return <tr key={row.day} className={day.dayOfWeek > 5 || row.holiday ? "daily-nonwork" : ""}>
            <th scope="row">{day.toLocaleString("de-DE", { weekday: "short" })} {dayLabel(row.day)}</th>
            <td>{duration(row.worked_minutes)}</td><td>{duration(row.target_minutes)}</td>
            <td className={row.difference_minutes > 0 ? "text-emerald-800 font-semibold" : row.difference_minutes < 0 ? "text-red-700 font-semibold" : ""}>{signedDuration(row.difference_minutes)}</td>
            <td>{row.holiday ?? (row.absence_type ? absenceLabels[row.absence_type] : "–")}</td>
          </tr>;
        })}</tbody>
        <tfoot><tr>
          <th scope="row">Summe</th>
          <td>{duration(data.days.reduce((sum, row) => sum + row.worked_minutes, 0))}</td>
          <td>{duration(data.days.reduce((sum, row) => sum + row.target_minutes, 0))}</td>
          <td>{signedDuration(data.days.reduce((sum, row) => sum + row.difference_minutes, 0))}</td><td />
        </tr></tfoot>
      </table>
    </div>
  </div>;
}

export function CalendarStaffReport({ members, month }: { members: Member[]; month: string }) {
  const [memberId, setMemberId] = useState("");
  const person = members.find((member) => member.id === memberId);
  return <section className={card} id="calendar-staff-report">
    <h2 className="panel-heading">Mitarbeiterauswertung</h2>
    <label className="mt-3 block max-w-xs">Mitarbeiter<select className={field} value={memberId} onChange={(event) => setMemberId(event.target.value)}>
      <option value="">Bitte wählen</option>{members.map((member) => <option key={member.id} value={member.id}>{member.full_name}</option>)}
    </select></label>
    {person && <CalendarStaffMetrics key={person.id + month} person={person} month={month} />}
  </section>;
}

function CalendarStaffMetrics({ person, month }: { person: Member; month: string }) {
  const [report, setReport] = useState<MonthlyReport>();
  const [notice, setNotice] = useState<Notice>();
  useEffect(() => {
    const controller = new AbortController();
    const selected = Temporal.PlainYearMonth.from(month);
    void supabase.rpc("read_monthly_report", { member_id: person.id, report_year: selected.year, report_month: selected.month })
      .abortSignal(controller.signal).then(({ data, error }) => {
        if (controller.signal.aborted) return;
        if (error) setNotice({ text: requestError(error), error: true });
        else setReport(data as MonthlyReport);
      });
    return () => controller.abort();
  }, [person.id, month]);
  return <>
    <div className="mt-4 flex flex-wrap items-center gap-2"><strong>{monthLabel(month)}</strong><DepartmentBadge department={person.department} /></div>
    <Message notice={notice} />
    {!notice && !report && <p className="muted-notice">Auswertung wird geladen …</p>}
    {report && <div className="time-metrics">
      <div><span>Ist-Arbeitszeit</span><strong>{duration(report.worked_minutes)} <small>Std.</small></strong></div>
      <div><span>Plus-/Minusstunden inkl. Vortrag</span><strong>{signedDuration(report.balance_minutes)} <small>Std.</small></strong></div>
      <div><span>Urlaub</span><strong>{report.vacation_days} <small>Tage</small></strong></div>
      <div><span>Krankheit</span><strong>{report.sick_days} <small>Tage</small></strong></div>
    </div>}
  </>;
}
