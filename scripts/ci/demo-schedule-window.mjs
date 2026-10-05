// Decides whether the Demo Mode server clock sits inside a seeded schedule
// window. The server evaluates "expected now" with real time, so Studio
// screenshots taken inside a window show different content than the committed
// baselines. The visual job skips itself then, instead of failing for a reason
// nobody can fix in a pull request.
//
// The windows mirror seedSchedules in apps/server/internal/demo/scenarios.go.
// demo-schedule-window.test.mjs fails when the two drift apart.
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const DEMO_TIMEZONE = "America/Chicago";

// A visual run takes several minutes, so a window counts as active a little
// before it opens: a run that starts at 10:25 would cross into 10:30.
export const LEAD_MINUTES = 20;

// `days` use the server's numbering: Monday is 1.
export const WINDOWS = [
  {
    name: "Lunch Service",
    days: [1, 2, 3, 4, 5],
    start: "10:30",
    end: "13:30",
  },
  {
    name: "Morning Broadcast",
    days: [1, 2, 3, 4, 5],
    start: "07:15",
    end: "08:15",
  },
  { name: "Friday Night Lights", days: [5], start: "15:00", end: "23:00" },
];

const WEEKDAYS = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

function minutes(clock) {
  const [hours, mins] = clock.split(":").map(Number);
  return hours * 60 + mins;
}

function localParts(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: DEMO_TIMEZONE,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const read = (type) => parts.find((part) => part.type === type)?.value;
  return {
    day: WEEKDAYS[read("weekday")],
    minute: Number(read("hour")) * 60 + Number(read("minute")),
  };
}

/** The first seeded window that is active, or opens within the lead time. */
export function activeWindow(date = new Date()) {
  const { day, minute } = localParts(date);
  return (
    WINDOWS.find(
      (window) =>
        window.days.includes(day) &&
        minute >= minutes(window.start) - LEAD_MINUTES &&
        minute < minutes(window.end),
    ) ?? null
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const window = activeWindow();
  if (window) {
    console.log(
      `The demo clock is inside the "${window.name}" schedule window (${window.start}-${window.end} ${DEMO_TIMEZONE}).`,
    );
  } else {
    console.log("The demo clock is outside every seeded schedule window.");
  }
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `active=${window ? "true" : "false"}\nwindow=${window?.name ?? ""}\n`,
    );
  }
}
