import { Temporal } from "@js-temporal/polyfill";

export function isoWeek(date: Temporal.PlainDate): string {
  return `${String(date.yearOfWeek).padStart(4, "0")}-W${String(date.weekOfYear).padStart(2, "0")}`;
}

export function weekMonday(week: string): Temporal.PlainDate {
  if (!/^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/.test(week)) throw new RangeError("Ungültige Kalenderwoche.");
  const jan4 = Temporal.PlainDate.from({ year: Number(week.slice(0, 4)), month: 1, day: 4 });
  const monday = jan4.subtract({ days: jan4.dayOfWeek - 1 }).add({ weeks: Number(week.slice(-2)) - 1 });
  if (isoWeek(monday) !== week) throw new RangeError("Diese Kalenderwoche gibt es nicht.");
  return monday;
}
