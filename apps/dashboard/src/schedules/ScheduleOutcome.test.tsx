// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/errors";
import type { SchedulePreflight } from "../api/types";
import { ScheduleOutcomeContent } from "./ScheduleOutcome";
import { emptyDraft, type ScheduleDraft } from "./scheduleEditorModel";
import { preflightResult } from "./scheduleEditorTestKit";
import type { ScheduleEditorSession } from "./useScheduleEditorSession";
import type { SchedulePreflightState } from "./useSchedulePreflight";

afterEach(cleanup);

const draft = (changes: Partial<ScheduleDraft> = {}): ScheduleDraft => ({
  ...emptyDraft("America/Chicago"),
  name: "Morning Broadcast",
  dailyStart: "07:15",
  dailyEnd: "08:15",
  content: { kind: "playlist", id: "p1", name: "Morning Announcements" },
  targets: [
    { type: "group", id: "g1", name: "Libraries" },
    { type: "screen", id: "s1", name: "Front Office" },
  ],
  ...changes,
});

const ready = (
  result: SchedulePreflight,
  current = true,
): SchedulePreflightState => ({
  status: current ? "ready" : "checking",
  result,
  current,
  error: null,
  retry: () => undefined,
  blocking: current && result.issues.some((i) => i.severity === "blocking"),
});

function show(
  d: ScheduleDraft,
  preflight: SchedulePreflightState,
  readOnly = false,
) {
  const session = {
    draft: d,
    preflight,
    readOnly,
  } as unknown as ScheduleEditorSession;
  return render(<ScheduleOutcomeContent session={session} />);
}

describe("Schedule outcome: the draft read back", () => {
  it("answers what, when, where, and at which priority", () => {
    show(
      draft({ priority: 40 }),
      ready(preflightResult({ targetScreenCount: 5 })),
    );
    const read = (label: string) =>
      screen.getByText(label, { selector: "dt" })
        .nextElementSibling as HTMLElement;
    expect(read("What")).toHaveTextContent("Morning Announcements");
    expect(read("What")).toHaveTextContent("Playlist");
    expect(read("When")).toHaveTextContent("Mon–Fri");
    expect(read("When")).toHaveTextContent(/7:15\s*–\s*8:15\s*AM/);
    expect(read("When")).toHaveTextContent("America/Chicago");
    expect(read("Where")).toHaveTextContent("5 screens");
    expect(read("Where")).toHaveTextContent("via 2 targets");
    expect(read("Priority")).toHaveTextContent("Custom (40) · 40");
    expect(screen.getByText("Enabled")).toBeInTheDocument();
  });

  it("names a display-control action", () => {
    show(
      draft({
        presentationMode: "display_control",
        displayAction: { type: "display_set_brightness", brightness: 60 },
      }),
      ready(preflightResult()),
    );
    expect(
      screen.getByText("Set display brightness to 60"),
    ).toBeInTheDocument();
  });

  it("says Disabled, not inactive, for a disabled draft", () => {
    show(
      draft({ enabled: false }),
      ready(preflightResult({ draftEnabled: false })),
    );
    expect(screen.getAllByText("Disabled").length).toBeGreaterThan(0);
    expect(
      screen.getByText("The check below simulates this schedule as enabled."),
    ).toBeInTheDocument();
  });

  it("counts targets, not screens, until the server says how many screens they reach", () => {
    show(draft(), { status: "incomplete" });
    expect(screen.getByText("2 targets")).toBeInTheDocument();
  });

  it("has an empty state for everything not yet chosen", () => {
    show(draft({ content: null, targets: [] }), { status: "incomplete" });
    expect(screen.getByText("Nothing chosen yet")).toBeInTheDocument();
    expect(screen.getByText("No targets yet")).toBeInTheDocument();
  });
});

describe("Schedule outcome: the next-run check", () => {
  it.each([
    [
      draft({ content: null, targets: [] }),
      "Choose a presentation and at least one target to check this schedule.",
    ],
    [draft({ content: null }), "Choose a presentation to check this schedule."],
    [
      draft({ targets: [] }),
      "Choose at least one target to check this schedule.",
    ],
    [draft({ daysOfWeek: [] }), "Finish the timing to check this schedule."],
  ])("says what is missing before it can check", (d, message) => {
    show(d, { status: "incomplete" });
    expect(screen.getByText(message)).toBeInTheDocument();
  });

  it("shows placeholders on the first check", () => {
    show(draft(), {
      status: "checking",
      result: undefined,
      current: false,
      error: null,
      retry: () => undefined,
      blocking: false,
    });
    expect(screen.getAllByText("Checking…").length).toBeGreaterThan(0);
    expect(screen.queryByText(/wins on/)).not.toBeInTheDocument();
  });

  it("says when and where it checked, in the schedule's own timezone", () => {
    show(
      draft(),
      ready(preflightResult({ checkedAt: "2026-10-06T12:15:00Z" })),
    );
    // 12:15Z is 7:15 AM CDT in Chicago, whatever zone the browser is in.
    expect(
      screen.getByText(/Checked for .*Tue.*Oct 6.*7:15 AM.*CDT/),
    ).toBeInTheDocument();
    expect(
      screen.getByText("This schedule wins on all 8 targeted screens."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Checks the next run only. Later runs can differ."),
    ).toBeInTheDocument();
  });

  it("says so when the occurrence is already running", () => {
    show(draft(), ready(preflightResult({ running: true })));
    expect(screen.getByText(/Running now · checked as of/)).toBeInTheDocument();
  });

  it("reports a partial win with each overlapping schedule and why", () => {
    show(
      draft(),
      ready(
        preflightResult({
          winningScreenCount: 6,
          losingScreenCount: 2,
          competitors: [
            {
              scheduleId: "c1",
              name: "Friday Night Lights",
              priority: 100,
              presentationType: "playlist",
              affectedScreenCount: 2,
              outranksDraftScreenCount: 2,
              reason: "schedule_lower_priority",
            },
            {
              scheduleId: "c2",
              name: "Lunch Service",
              priority: 0,
              presentationType: "playlist",
              affectedScreenCount: 3,
              outranksDraftScreenCount: 0,
              reason: "schedule_lower_priority",
            },
            {
              scheduleId: "c3",
              name: "Direct Rival",
              priority: 0,
              presentationType: "playlist",
              affectedScreenCount: 2,
              outranksDraftScreenCount: 2,
              reason: "schedule_less_specific",
            },
            {
              scheduleId: "c4",
              name: "Mixed",
              priority: 0,
              presentationType: "playlist",
              affectedScreenCount: 4,
              outranksDraftScreenCount: 1,
              reason: "schedule_earlier_start",
            },
          ],
          screens: [
            {
              screenId: "a",
              name: "Cafeteria East",
              outcome: "superseded",
              reason: "schedule_lower_priority",
              winnerScheduleId: "c1",
              winnerName: "Friday Night Lights",
            },
          ],
        }),
      ),
    );
    expect(
      screen.getByText("This schedule wins on 6 of 8 screens."),
    ).toBeInTheDocument();
    const list = screen.getByRole("list", { name: "Overlapping schedules" });
    const row = (name: string) =>
      within(list).getByText(name).closest("[data-slot=item]") as HTMLElement;
    expect(row("Friday Night Lights")).toHaveTextContent(
      "Higher priority · 2 screens",
    );
    expect(row("Lunch Service")).toHaveTextContent(
      "Lower priority · this schedule wins on 3 screens",
    );
    expect(row("Direct Rival")).toHaveTextContent(
      "Targets the screens directly · 2 screens",
    );
    expect(row("Mixed")).toHaveTextContent(
      "Outranks this schedule on 1 of 4 screens",
    );
    expect(screen.getByText("Cafeteria East")).toBeInTheDocument();
    expect(
      screen.getByText("Shows Friday Night Lights instead"),
    ).toBeInTheDocument();
  });

  it("labels a schedule the account may not see without its name", () => {
    show(
      draft(),
      ready(
        preflightResult({
          winningScreenCount: 7,
          losingScreenCount: 1,
          competitors: [
            {
              scheduleId: "x",
              name: "",
              priority: 500,
              presentationType: "playlist",
              affectedScreenCount: 1,
              outranksDraftScreenCount: 1,
              reason: "schedule_lower_priority",
            },
          ],
          screens: [
            {
              screenId: "a",
              name: "Lobby",
              outcome: "superseded",
              reason: "schedule_lower_priority",
              winnerScheduleId: "x",
              winnerName: "",
            },
          ],
        }),
      ),
    );
    expect(screen.getByText("Another schedule")).toBeInTheDocument();
    expect(
      screen.getByText("Shows another schedule instead"),
    ).toBeInTheDocument();
  });

  it("says plainly when the draft loses everywhere", () => {
    show(
      draft(),
      ready(preflightResult({ winningScreenCount: 0, losingScreenCount: 8 })),
    );
    expect(
      screen.getByText("This schedule loses on all 8 targeted screens."),
    ).toBeInTheDocument();
  });

  it("keeps counts exact when the lists are cut short", () => {
    show(
      draft(),
      ready(
        preflightResult({
          winningScreenCount: 0,
          losingScreenCount: 120,
          targetScreenCount: 120,
          competitorsTruncated: true,
          screensTruncated: true,
          screens: Array.from({ length: 50 }, (_, i) => ({
            screenId: `s${i}`,
            name: `Screen ${i}`,
            outcome: "superseded" as const,
            reason: "schedule_lower_priority" as const,
            winnerName: "Rival",
          })),
        }),
      ),
    );
    expect(
      screen.getByText("This schedule loses on all 120 targeted screens."),
    ).toBeInTheDocument();
    expect(screen.getByText("and 115 more screens")).toBeInTheDocument();
    expect(
      screen.getByText("More overlapping schedules are not listed."),
    ).toBeInTheDocument();
  });

  it("flags screens that cannot run display control as a blocking problem", () => {
    show(
      draft({ presentationMode: "display_control" }),
      ready(
        preflightResult({
          unsupportedScreenCount: 2,
          issues: [
            {
              code: "display_control_unsupported",
              severity: "blocking",
              screenCount: 2,
            },
          ],
        }),
      ),
    );
    expect(
      screen.getByText("2 targeted screens can't run display control"),
    ).toBeInTheDocument();
  });

  it("counts only the screens that can run a display action when it says it wins", () => {
    show(
      draft({ presentationMode: "display_control" }),
      ready(
        preflightResult({
          targetScreenCount: 3,
          winningScreenCount: 1,
          unsupportedScreenCount: 2,
          issues: [
            {
              code: "display_control_unsupported",
              severity: "blocking",
              screenCount: 2,
            },
          ],
        }),
      ),
    );
    expect(
      screen.getByText("This schedule wins on the screen that can run it."),
    ).toBeInTheDocument();
  });

  it("explains a schedule that never runs again", () => {
    show(
      draft(),
      ready(
        preflightResult({
          checkedAt: undefined,
          winningScreenCount: 0,
          issues: [{ code: "no_upcoming_run", severity: "warning" }],
        }),
      ),
    );
    expect(screen.getByText("No upcoming run")).toBeInTheDocument();
    expect(screen.queryByText(/wins on/)).not.toBeInTheDocument();
  });

  it("marks an old answer as checking instead of presenting it as current", () => {
    show(draft(), ready(preflightResult(), false));
    expect(screen.getAllByText("Checking…").length).toBeGreaterThan(0);
    const verdict = screen.getByText(
      "This schedule wins on all 8 targeted screens.",
    );
    expect(verdict.closest("[aria-busy=true]")).not.toBeNull();
  });

  it("offers a retry when the check fails, and says saving still works", async () => {
    const retry = vi.fn();
    show(draft(), {
      status: "error",
      result: undefined,
      current: false,
      error: new ApiError("Server unavailable.", 503, "unavailable"),
      retry,
      blocking: false,
    });
    expect(screen.getByText("The check could not run")).toBeInTheDocument();
    expect(
      screen.getByText("You can still save this schedule."),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalled();
  });
});
