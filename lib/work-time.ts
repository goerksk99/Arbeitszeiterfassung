import { Temporal } from "@js-temporal/polyfill";

export const COMPANY_ZONE = "Europe/Berlin";

export function berlinDate(instant: string): string {
  return Temporal.Instant.from(instant).toZonedDateTimeISO(COMPANY_ZONE).toPlainDate().toString();
}

export function calculateEntry(
  startedAt: string,
  endedAt: string,
  settings = { start: "12:00", minutes: 30 },
  adjustedBreak?: number,
) {
  const start = Temporal.Instant.from(startedAt);
  const end = Temporal.Instant.from(endedAt);
  if (Temporal.Instant.compare(end, start) <= 0) {
    throw new RangeError("Das Ende muss nach dem Beginn liegen.");
  }

  const grossMinutes = Number((end.epochNanoseconds - start.epochNanoseconds) / BigInt(60_000_000_000));
  if (!Number.isInteger(settings.minutes) || settings.minutes < 0 || settings.minutes > 1440) {
    throw new RangeError("Ungültige automatische Pausendauer.");
  }
  const pauseTime = Temporal.PlainTime.from(settings.start);
  let automaticMinutes = 0;
  if (adjustedBreak === undefined && settings.minutes > 0) {
    const last = Temporal.PlainDate.from(berlinDate(endedAt));
    for (let day = Temporal.PlainDate.from(berlinDate(startedAt));
      Temporal.PlainDate.compare(day, last) <= 0;
      day = day.add({ days: 1 })) {
      const pause = day.toPlainDateTime(pauseTime).toZonedDateTime(COMPANY_ZONE, { disambiguation: "later" }).toInstant();
      if (Temporal.Instant.compare(start, pause) < 0 &&
          Temporal.Instant.compare(end, pause.add({ minutes: settings.minutes })) > 0) {
        automaticMinutes += settings.minutes;
      }
    }
  }
  const breakMinutes = adjustedBreak ?? automaticMinutes;
  if (!Number.isInteger(breakMinutes) || breakMinutes < 0 || breakMinutes > grossMinutes) {
    throw new RangeError("Die Pause muss zwischen null und der Brutto-Arbeitszeit liegen.");
  }

  return { grossMinutes, breakMinutes, workedMinutes: grossMinutes - breakMinutes,
    breakAdjusted: adjustedBreak !== undefined };
}

export type AbsenceType = "vacation" | "sick" | "comp_time" | "other";

/** Abwesenheiten sind genehmigte, ganztägige Buchungen. Der Vortrag ist der vorige Endsaldo. */
export function calculateMonth(input: {
  year: number;
  month: number;
  weeklyHours: number;
  workedMinutes: number;
  breakMinutes: number;
  carryoverMinutes?: number;
  absences: ReadonlyArray<{ type: AbsenceType; startDate: string; endDate: string }>;
}) {
  const month = Temporal.PlainYearMonth.from({ year: input.year, month: input.month }, { overflow: "reject" });
  const first = month.toPlainDate({ day: 1 });
  const last = month.toPlainDate({ day: month.daysInMonth });
  const absences = new Map<string, AbsenceType>();

  for (const absence of input.absences) {
    const start = Temporal.PlainDate.from(absence.startDate);
    const end = Temporal.PlainDate.from(absence.endDate);
    if (Temporal.PlainDate.compare(start, end) > 0) throw new RangeError("Ungültiger Abwesenheitszeitraum.");
    for (let day = Temporal.PlainDate.compare(start, first) < 0 ? first : start;
      Temporal.PlainDate.compare(day, last) <= 0 && Temporal.PlainDate.compare(day, end) <= 0;
      day = day.add({ days: 1 })) {
      if (day.dayOfWeek > 5) continue;
      const key = day.toString();
      if (absences.has(key)) throw new RangeError("Genehmigte Abwesenheiten überschneiden sich.");
      absences.set(key, absence.type);
    }
  }

  let workdays = 0;
  for (let day = first; Temporal.PlainDate.compare(day, last) <= 0; day = day.add({ days: 1 })) {
    if (day.dayOfWeek <= 5) workdays++;
  }
  const days = { vacation: 0, sick: 0, comp_time: 0, other: 0 };
  for (const type of absences.values()) days[type]++;
  const targetMinutes = Math.round((workdays - days.vacation - days.sick - days.other) * input.weeklyHours * 60 / 5);
  const carryoverMinutes = input.carryoverMinutes ?? 0;
  return {
    targetMinutes,
    workedMinutes: input.workedMinutes,
    breakMinutes: input.breakMinutes,
    balanceMinutes: carryoverMinutes + input.workedMinutes - targetMinutes,
    carryoverMinutes,
    vacationDays: days.vacation,
    sickDays: days.sick,
    compTimeDays: days.comp_time,
  };
}
