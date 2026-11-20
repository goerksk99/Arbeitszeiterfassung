import assert from "node:assert/strict";
import test from "node:test";
import { Temporal } from "@js-temporal/polyfill";
import { isoWeek, weekMonday } from "../lib/iso-week";

test("ISO-Kalenderwoche beginnt Montag und verwendet das richtige Wochenjahr", () => {
  assert.equal(isoWeek(Temporal.PlainDate.from("2027-01-01")), "2026-W53");
  const monday = weekMonday("2026-W53");
  assert.equal(monday.toString(), "2026-12-28");
  assert.equal(monday.add({ days: 6 }).toString(), "2027-01-03");
  assert.equal(isoWeek(monday.add({ weeks: 1 })), "2027-W01");
  assert.throws(() => weekMonday("2027-W53"), RangeError);
});
