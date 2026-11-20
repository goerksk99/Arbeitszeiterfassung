import { COMPANY_ZONE } from "../lib/work-time";

export const time = new Intl.DateTimeFormat("de-DE", { timeZone: COMPANY_ZONE, hour: "2-digit", minute: "2-digit" });
export const date = new Intl.DateTimeFormat("de-DE", { timeZone: COMPANY_ZONE, dateStyle: "medium" });

export const entryColumns = "id, started_at, ended_at, break_minutes, break_adjusted, status, note";
export type Entry = {
  id: string;
  started_at: string;
  ended_at: string | null;
  break_minutes: number;
  break_adjusted: boolean;
  status: "open" | "recorded" | "submitted" | "approved" | "rejected";
  note: string | null;
};

export function duration(minutes: number) {
  const absolute = Math.abs(minutes);
  return `${minutes < 0 ? "−" : ""}${Math.floor(absolute / 60)}:${String(absolute % 60).padStart(2, "0")}`;
}

export function optionalBreak(input: FormDataEntryValue | null) {
  if (input === "" || input === null) return undefined;
  const minutes = Number(input);
  if (!Number.isInteger(minutes) || minutes < 0) throw new RangeError("Bitte ganze Pausenminuten ab null eingeben.");
  return minutes;
}
