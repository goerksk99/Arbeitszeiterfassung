import { FileDown } from "lucide-react";
import { Temporal } from "@js-temporal/polyfill";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { MonthlyReport } from "../lib/monthly-report";
import type {} from "./desktop-api";
import { Modal } from "./modal";
import { type DailyReport, signedDuration } from "./staff-reports";
import { supabase } from "./supabase";
import { duration } from "./time-display";
import { button, dayLabel, Message, monthLabel, requestError, secondary, type Notice } from "./ui";

type ProofData = { summary: MonthlyReport; daily: DailyReport };

function ProofSheet({ data, name, month }: { data: ProofData; name: string; month: string }) {
  return <article className="proof-sheet">
    <header>
      <h2>Monatsnachweis Arbeitszeit</h2>
      <p>{monthLabel(month)} · {name}</p>
      <small>{data.summary.is_locked ? "Abgeschlossener Monat" : "Vorläufiger Stand"}</small>
    </header>
    {data.daily.reconstructed && <p>Die Tageswerte wurden rekonstruiert. Es gilt die gespeicherte Monatssumme.</p>}
    <table>
      <thead><tr><th>Datum</th><th>Ist</th><th>Soll</th><th>Pause</th><th>Differenz</th></tr></thead>
      <tbody>{data.daily.days.map((day) => <tr key={day.day}>
        <th scope="row">{dayLabel(day.day)}</th>
        <td>{duration(day.worked_minutes)}</td><td>{duration(day.target_minutes)}</td>
        <td>{duration(day.break_minutes)}</td><td>{signedDuration(day.difference_minutes)}</td>
      </tr>)}</tbody>
      <tfoot><tr>
        <th scope="row">Monatssumme</th><td>{duration(data.summary.worked_minutes)}</td>
        <td>{duration(data.summary.target_minutes)}</td><td>{duration(data.summary.break_minutes)}</td>
        <td>{signedDuration(data.summary.worked_minutes - data.summary.target_minutes)}</td>
      </tr></tfoot>
    </table>
    <p className="proof-note">Zeitwerte in Stunden:Minuten. Saldo inkl. Vortrag {signedDuration(data.summary.balance_minutes)} Std.</p>
    <div className="proof-signatures">
      <div>Datum und Unterschrift Mitarbeiter/in</div>
      <div>Datum und Unterschrift Vorgesetzte/r</div>
    </div>
  </article>;
}

export function MonthlyProof({ member, name, month, onClose }: {
  member: string; name: string; month: string; onClose: () => void;
}) {
  const [data, setData] = useState<ProofData>();
  const [notice, setNotice] = useState<Notice>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    const period = Temporal.PlainYearMonth.from(month);
    const params = { member_id: member, report_year: period.year, report_month: period.month };
    void Promise.all([
      supabase.rpc("read_monthly_report", params).abortSignal(controller.signal),
      supabase.rpc("read_daily_report", params).abortSignal(controller.signal),
    ]).then(([summary, daily]) => {
      if (controller.signal.aborted) return;
      const error = summary.error ?? daily.error;
      if (error) setNotice({ text: requestError(error), error: true });
      else setData({ summary: summary.data as MonthlyReport, daily: daily.data as DailyReport });
    }).catch(() => {
      if (!controller.signal.aborted) setNotice({ text: "Der Monatsnachweis konnte nicht geladen werden.", error: true });
    });
    return () => controller.abort();
  }, [member, month]);

  async function save() {
    if (!data || !data.daily.days.length || busy) return;
    setBusy(true);
    setNotice(undefined);
    try {
      if (!window.desktop) window.print();
      else if (await window.desktop.saveMonthlyPdf(month)) setNotice({ text: "PDF gespeichert." });
    } catch {
      setNotice({ text: "Das PDF konnte nicht gespeichert werden.", error: true });
    } finally { setBusy(false); }
  }

  return <>
    <Modal title="Monatsnachweis als PDF" onClose={onClose} busy={busy}>
      <Message notice={notice} />
      {data ? <>
        <ProofSheet data={data} name={name} month={month} />
        {!data.daily.days.length && <p className="muted-notice">Für diesen Monat sind noch keine Tage verfügbar.</p>}
      </> : !notice && <p role="status">Monatsnachweis wird geladen …</p>}
      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" className={button} disabled={busy || !data?.daily.days.length} onClick={save}><FileDown size={18} aria-hidden="true" />PDF speichern</button>
        <button type="button" className={secondary} disabled={busy} onClick={onClose}>Schließen</button>
      </div>
    </Modal>
    {data && createPortal(<div className="pdf-print-root"><ProofSheet data={data} name={name} month={month} /></div>, document.body)}
  </>;
}
