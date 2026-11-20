import assert from "node:assert/strict";
import test from "node:test";
import { reportCsv } from "../lib/monthly-report";

test("Monats-CSV nutzt BOM, Semikolon, Excel-Zeilenenden und sichere Textfelder", () => {
  const csv = reportCsv([{
    user_id: "test", full_name: '=Müller; "Team"', year: 2026, month: 11,
    target_minutes: 9600, worked_minutes: 9000, break_minutes: 600,
    balance_minutes: -540, carryover_minutes: 60,
    vacation_days: 1, sick_days: 2, comp_time_days: 0, is_locked: true,
  }]);
  assert.equal(csv.charCodeAt(0), 0xFEFF);
  assert.equal(csv.split("\r\n")[1], `"'=Müller; ""Team""";2026;11;9600;9000;600;-540;60;1;2;0;"Abgeschlossen"`);
  assert(csv.endsWith("\r\n"));
});
