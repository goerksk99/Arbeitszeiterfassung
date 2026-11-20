export type MonthlyReport = {
  user_id: string;
  year: number;
  month: number;
  target_minutes: number;
  worked_minutes: number;
  break_minutes: number;
  balance_minutes: number;
  carryover_minutes: number;
  vacation_days: number;
  sick_days: number;
  comp_time_days: number;
  is_locked: boolean;
};

export type NamedReport = MonthlyReport & { full_name: string };

export function reportCsv(rows: NamedReport[]) {
  const headings = ["Mitarbeiter", "Jahr", "Monat", "Soll (Min.)", "Netto (Min.)",
    "Pause (Min.)", "Saldo (Min.)", "Vortrag (Min.)", "Urlaub (Tage)",
    "Krankheit (Tage)", "Zeitausgleich (Tage)", "Status"];

  function cell(value: string | number) {
    if (typeof value === "number") return String(value);
    const safe = /^[\s]*[=+@-]|^[\t\r\n]/u.test(value) ? "'" + value : value;
    return '"' + safe.replaceAll('"', '""') + '"';
  }

  const lines = rows.map((row) => [
    row.full_name, row.year, row.month, row.target_minutes, row.worked_minutes,
    row.break_minutes, row.balance_minutes, row.carryover_minutes, row.vacation_days,
    row.sick_days, row.comp_time_days, row.is_locked ? "Abgeschlossen" : "Laufend",
  ]);
  return "\uFEFF" + [headings, ...lines].map((line) => line.map(cell).join(";")).join("\r\n") + "\r\n";
}
