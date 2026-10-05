import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { WINDOWS, activeWindow } from "./demo-schedule-window.mjs";

// 2026-09-28 is a Monday; Chicago is on daylight time (UTC-5) in September.
const at = (isoUtc) => new Date(isoUtc);

test("a weekday lunch time is inside the Lunch Service window", () => {
  assert.equal(activeWindow(at("2026-09-28T16:00:00Z"))?.name, "Lunch Service");
});

test("the window counts as active shortly before it opens", () => {
  // 10:20 local, ten minutes before Lunch Service.
  assert.equal(activeWindow(at("2026-09-28T15:20:00Z"))?.name, "Lunch Service");
  // 10:00 local is outside the lead time.
  assert.equal(activeWindow(at("2026-09-28T15:00:00Z")), null);
});

test("evenings and weekends are clear, except Friday night", () => {
  assert.equal(activeWindow(at("2026-09-29T02:00:00Z")), null); // Mon 21:00
  assert.equal(activeWindow(at("2026-10-03T17:00:00Z")), null); // Sat noon
  assert.equal(
    activeWindow(at("2026-10-02T22:00:00Z"))?.name, // Fri 17:00
    "Friday Night Lights",
  );
});

test("the window ends when it ends", () => {
  assert.equal(activeWindow(at("2026-09-28T18:30:00Z")), null); // 13:30 local
});

test("the windows match the schedules the demo seeds", () => {
  const source = readFileSync(
    new URL("../../apps/server/internal/demo/scenarios.go", import.meta.url),
    "utf8",
  );
  // Only schedules seeded as scheduling.Input run against the current time. The
  // Homecoming campaign block starts two weeks out, so it never overlaps "now".
  const seeded = [
    ...source.matchAll(
      /scheduling\.Input\{Name: "([^"]+)"[\s\S]*?DailyStart: ptr\("(\d\d:\d\d)"\), DailyEnd: ptr\("(\d\d:\d\d)"\), DaysOfWeek: (weekdays|\[\]int\{[\d, ]+\})/g,
    ),
  ].map(([, name, start, end, days]) => ({
    name,
    start,
    end,
    days:
      days === "weekdays" ? [1, 2, 3, 4, 5] : days.match(/\d+/g).map(Number),
  }));
  assert.ok(seeded.length > 0, "found no seeded daily schedules");
  const sort = (windows) =>
    [...windows].sort((a, b) => a.name.localeCompare(b.name));
  assert.deepEqual(
    sort(WINDOWS),
    sort(seeded),
    "update WINDOWS in demo-schedule-window.mjs to match seedSchedules",
  );
});
