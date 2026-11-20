import { useEffect, useState } from "react";
import { Temporal } from "@js-temporal/polyfill";
import { reportCsv, type MonthlyReport, type NamedReport } from "../lib/monthly-report";
import { berlinDate } from "../lib/work-time";
import { MonthlyProof } from "./monthly-proof";
import { DailyReportTable, signedDuration } from "./staff-reports";
import { supabase, type Profile } from "./supabase";
import { button, card, field, listMembers, Message, monthLabel, monthNow, requestError, secondary, type Member, type Notice } from "./ui";

import type {} from "./desktop-api";

function minutes(value: number) {
  const absolute = Math.abs(value);
  return `${value < 0 ? "−" : ""}${Math.floor(absolute / 60)}:${String(absolute % 60).padStart(2, "0")}`;
}

export function Reports({ profile }: { profile: Profile }) {
  const [month, setMonth] = useState(monthNow);
  const [member, setMember] = useState(profile.id);
  const [members, setMembers] = useState<Member[]>([]);
  const [rows, setRows] = useState<NamedReport[]>([]);
  const [notice, setNotice] = useState<Notice>();
  const [loading, setLoading] = useState(true);
  const [closing, setClosing] = useState("");
  const [confirm, setConfirm] = useState<NamedReport | null>(null);
  const [proof, setProof] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const admin = profile.role === "admin";

  useEffect(() => {
    if (!admin) return;
    const controller = new AbortController();
    const reload = async () => {
      const people = await listMembers(controller.signal);
      const selected = Temporal.PlainYearMonth.from(month);
      const reportRows = await Promise.all(people.filter((person) => !member || member === person.id).map(async (person) => {
        const { data, error } = await supabase.rpc("read_monthly_report", {
          member_id: person.id, report_year: selected.year, report_month: selected.month,
        }).abortSignal(controller.signal);
        if (error) throw error;
        return { ...(data as MonthlyReport), full_name: person.full_name };
      }));
      if (controller.signal.aborted) return;
      setMembers(people);
      setRows(reportRows);
      setLoading(false);
    };
    void reload().catch((error) => {
      if (controller.signal.aborted) return;
      setNotice({ text: requestError(error), error: true });
      setRows([]);
      setLoading(false);
    });
    return () => controller.abort();
  }, [admin, month, member, refresh]);

  async function close() {
    if (!confirm || closing) return;
    setClosing(confirm.user_id);
    setNotice(undefined);
    try {
      const { data, error } = await supabase.rpc("close_month", {
        member_id: confirm.user_id, report_year: confirm.year, report_month: confirm.month,
      });
      if (error) throw error;
      setRows((previous) => previous.map((row) => row.user_id === confirm.user_id
        ? { ...(data as MonthlyReport), full_name: row.full_name } : row));
      setNotice({ text: `Monat für ${confirm.full_name} abgeschlossen.` });
      setConfirm(null);
      setRefresh((value) => value + 1);
    } catch (error) { setNotice({ text: requestError(error), error: true }); }
    finally { setClosing(""); }
  }

  function exportCsv() {
    const url = URL.createObjectURL(new Blob([reportCsv(rows)], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `arbeitszeiterfassung-${month}.csv`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  if (!admin) return null;
  const past = month < berlinDate(new Date().toISOString()).slice(0, 7);
  const selectedRow = member ? rows.find((row) => row.user_id === member) : undefined;
  function closeAction(row: NamedReport) {
    return !row.is_locked && (past
      ? <button className={secondary} disabled={Boolean(closing)} onClick={() => { setNotice(undefined); setConfirm(row); }}>Monat abschließen</button>
      : <span className="text-sm text-slate-600">Abschluss nach Monatsende</span>);
  }
  return (
    <section className={`${card} report-print`}>
      <div className="flex flex-wrap justify-between gap-3">
        <h2 className="panel-heading">Monatsübersicht</h2>
        <div className="no-print flex flex-wrap gap-2">
          <button className={secondary} disabled={loading || !rows.length} onClick={exportCsv}>CSV exportieren</button>
          {selectedRow && <button className={button} disabled={loading} onClick={() => setProof(true)}>Monatsnachweis als PDF</button>}
          <button className={secondary} disabled={loading || !rows.length} onClick={() => window.desktop ? window.desktop.printReport() : window.print()}>Drucken</button>
        </div>
      </div>
      <p className="print-month mt-2 font-medium">{monthLabel(month)}</p>
      <div className="no-print my-4 flex flex-wrap gap-4">
        <label>Monat<input type="month" className={field} min="0002-01" max="9999-12" value={month} disabled={Boolean(closing)} onChange={(event) => {
          if (!event.target.validity.valid || !event.target.value) return;
          setMonth(event.target.value); setConfirm(null); setNotice(undefined); setLoading(true);
        }} /></label>
        <label>Mitarbeiter<select className={field} value={member} disabled={Boolean(closing)} onChange={(event) => {
          setMember(event.target.value); setConfirm(null); setNotice(undefined); setLoading(true);
        }}><option value="">Alle</option>{members.map((person) => <option key={person.id} value={person.id}>{person.full_name}</option>)}</select></label>
        <button className={`${secondary} self-end`} disabled={loading || Boolean(closing)} onClick={() => {
          setLoading(true); setNotice(undefined); setRefresh((value) => value + 1);
        }}>Aktualisieren</button>
      </div>
      <div className="no-print my-3"><Message notice={notice} /></div>
      {loading ? <p role="status">Berichte werden geladen …</p> : selectedRow ? <div className="report-overview">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2"><strong>{selectedRow.full_name}</strong>
            <span className="entry-status">{selectedRow.is_locked ? "Abgeschlossen" : "Offen"}</span>
          </div>
          <div className="no-print">{closeAction(selectedRow)}</div>
        </div>
        <div className="time-metrics">
          <div><span>Ist</span><strong>{minutes(selectedRow.worked_minutes)} <small>Std.</small></strong></div>
          <div><span>Soll</span><strong>{minutes(selectedRow.target_minutes)} <small>Std.</small></strong></div>
          <div><span>Differenz</span><strong>{signedDuration(selectedRow.worked_minutes - selectedRow.target_minutes)} <small>Std.</small></strong></div>
          <div><span>Saldo inkl. Vortrag</span><strong>{signedDuration(selectedRow.balance_minutes)} <small>Std.</small></strong></div>
        </div>
        <p className="mt-3 text-sm text-slate-600">Pause {minutes(selectedRow.break_minutes)} Std. · Vortrag {signedDuration(selectedRow.carryover_minutes)} Std. · Urlaub {selectedRow.vacation_days} Tage · Krankheit {selectedRow.sick_days} Tage · Zeitausgleich {selectedRow.comp_time_days} Tage</p>
      </div> : <div className="overflow-x-auto">
        {!!rows.length && <table className="w-full border-collapse text-left text-sm">
          <caption className="sr-only">Zeitwerte im Format Stunden:Minuten</caption>
          <thead><tr className="border-b border-slate-300">
            {["Mitarbeiter", "Soll", "Netto", "Pause", "Vortrag", "Saldo", "Urlaub", "Krank", "Zeitausgleich", "Status"].map((label) => <th className="p-2" key={label}>{label}</th>)}
            <th className="no-print p-2">Aktion</th>
          </tr></thead>
          <tbody>{rows.map((row) => <tr className="border-b border-slate-200" key={row.user_id}>
            <th scope="row" className="p-2 font-medium">{member ? row.full_name : <>
              <button type="button" className="no-print underline" onClick={() => {
                setMember(row.user_id); setNotice(undefined); setConfirm(null); setLoading(true);
              }} title="Tagesübersicht öffnen">{row.full_name}</button>
              <span className="print-month">{row.full_name}</span>
            </>}</th>
            {[row.target_minutes, row.worked_minutes, row.break_minutes, row.carryover_minutes, row.balance_minutes].map((value, index) => <td className="p-2" key={index}>{minutes(value)}</td>)}
            <td className="p-2">{row.vacation_days}</td><td className="p-2">{row.sick_days}</td><td className="p-2">{row.comp_time_days}</td>
            <td className="p-2">{row.is_locked ? "Abgeschlossen" : "Laufend"}</td>
            <td className="no-print p-2">{closeAction(row)}</td>
          </tr>)}</tbody>
        </table>}
        <p className="mt-3 text-xs text-slate-600">Zeitwerte in Stunden:Minuten. Abwesenheiten in Tagen.</p>
      </div>}
      {!loading && member && rows.some((row) => row.user_id === member) &&
        <DailyReportTable key={member + month + refresh} member={member} month={month} refresh={refresh} />}
      {proof && selectedRow && <MonthlyProof member={selectedRow.user_id} name={selectedRow.full_name} month={month} onClose={() => setProof(false)} />}
      {confirm && <div className="no-print mt-5 rounded-lg border border-amber-300 bg-amber-50 p-4">
        <p>Monat {monthLabel(month)} für {confirm.full_name} abschließen? Die Summen werden fest gespeichert und Mitarbeiterbuchungen gesperrt.</p>
        <div className="mt-3 flex gap-2">
          <button className={button} disabled={Boolean(closing)} onClick={close}>Abschluss bestätigen</button>
          <button className={secondary} disabled={Boolean(closing)} onClick={() => setConfirm(null)}>Abbrechen</button>
        </div>
      </div>}
    </section>
  );
}
