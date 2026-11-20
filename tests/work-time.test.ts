import assert from "node:assert/strict";
import test from "node:test";
import { berlinDate, calculateEntry, calculateMonth } from "../lib/work-time";

test("Ein voller Bürotag zieht 30 Minuten Mittagspause ab", () => {
  assert.deepEqual(calculateEntry("2026-11-20T08:00+01:00", "2026-11-20T17:00+01:00"), {
    grossMinutes: 540, breakMinutes: 30, workedMinutes: 510, breakAdjusted: false,
  });
});

test("Halbe Tage und exakte Pausengrenzen lösen keinen Abzug aus", () => {
  const day = "2026-11-20T";
  for (const [start, end] of [["08:00", "12:00"], ["08:00", "12:30"],
    ["12:00", "17:00"], ["12:31", "17:00"]]) {
    assert.equal(calculateEntry(day + start + "+01:00", day + end + "+01:00").breakMinutes, 0);
  }
});

test("Konfiguration und manuell gesetzte Nullpause werden berücksichtigt", () => {
  const args = ["2026-11-20T08:00+01:00", "2026-11-20T17:00+01:00"] as const;
  const settings = { start: "13:00", minutes: 45 };
  assert.equal(calculateEntry(...args, settings).breakMinutes, 45);
  assert.equal(calculateEntry(...args, settings, 0).breakMinutes, 0);
  assert.equal(calculateEntry(...args, settings, 0).breakAdjusted, true);
  assert.throws(() => calculateEntry(...args, settings, 541), RangeError);
  assert.throws(() => calculateEntry(args[1], args[0]), RangeError);
});

test("Berliner Tageswechsel werden auch bei Zeitumstellung korrekt ausgewertet", () => {
  assert.equal(berlinDate("2026-03-28T23:10Z"), "2026-03-29");
  const overnight = calculateEntry("2026-03-28T22:00+01:00", "2026-03-29T06:00+02:00");
  assert.equal(overnight.workedMinutes, 420);
  assert.equal(overnight.breakMinutes, 0);
  const intoNextDay = calculateEntry("2026-11-20T23:00+01:00", "2026-11-21T13:00+01:00");
  assert.equal(intoNextDay.breakMinutes, 30);
});

test("Bezahlte Abwesenheiten reduzieren das Soll, Zeitausgleich verbraucht den Vortrag", () => {
  const report = calculateMonth({
    year: 2026, month: 2, weeklyHours: 40, workedMinutes: 16 * 480,
    breakMinutes: 480, carryoverMinutes: 600,
    absences: [
      { type: "vacation", startDate: "2026-01-30", endDate: "2026-02-02" },
      { type: "sick", startDate: "2026-02-03", endDate: "2026-02-03" },
      { type: "other", startDate: "2026-02-04", endDate: "2026-02-04" },
      { type: "comp_time", startDate: "2026-02-06", endDate: "2026-02-08" },
    ],
  });
  assert.equal(report.targetMinutes, 17 * 480);
  assert.equal(report.balanceMinutes, 120);
  assert.deepEqual([report.vacationDays, report.sickDays, report.compTimeDays], [1, 1, 1]);
  const next = calculateMonth({
    year: 2026, month: 3, weeklyHours: 40, workedMinutes: 22 * 480,
    breakMinutes: 0, carryoverMinutes: report.balanceMinutes, absences: [],
  });
  assert.equal(next.carryoverMinutes, 120);
  assert.equal(next.balanceMinutes, 120);
});
