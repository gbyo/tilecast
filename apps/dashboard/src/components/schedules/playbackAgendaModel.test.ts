import { describe, expect, it } from "vitest";
import type { PlaybackAgendaSegment } from "../../api/domains/playbackPlan";
import { calendarDay, hoursSince } from "./playbackAgendaModel";

const date = new Date(2026, 10, 4);
const at = (hour: number) => new Date(2026, 10, 4, hour);
const selected: PlaybackAgendaSegment["selected"] = {
  contentId: "playlist",
  contentType: "playlist",
  selectionId: "winning-schedule",
  source: "schedule",
  reason: "schedule_highest_precedence",
};
const losing: PlaybackAgendaSegment["superseded"] = [
  {
    id: "other-schedule",
    source: "schedule",
    status: "superseded",
    reason: "schedule_lower_priority",
  },
];
function segment(
  start: Date,
  end: Date,
  selection = selected,
  superseded: PlaybackAgendaSegment["superseded"] = [],
) {
  return {
    start: start.toISOString(),
    end: end.toISOString(),
    selected: selection,
    superseded,
  };
}

describe("calendarDay", () => {
  it("joins a winner across overlap boundaries without losing the exact overlap window", () => {
    const day = calendarDay(
      [
        segment(at(8), at(9)),
        segment(at(9), at(10), selected, losing),
        segment(at(10), at(11)),
        segment(at(11), at(12), {
          ...selected,
          selectionId: "separate-schedule",
        }),
      ],
      date,
    );
    expect(day.allDay).toBeUndefined();
    expect(day.blocks).toHaveLength(2);
    const [block] = day.blocks;
    expect(hoursSince(block!.start, date)).toBe(8);
    expect(hoursSince(block!.end, block!.start)).toBe(3);
    expect(block!.overlaps).toEqual([
      { start: at(9), end: at(10), candidates: losing },
    ]);
  });

  it("clips continuous playback to each day and keeps elapsed gaps blank", () => {
    const acrossMidnight = [segment(at(-1), at(27))];
    expect(calendarDay(acrossMidnight, date).allDay).toMatchObject({
      start: date,
      end: at(24),
    });
    expect(calendarDay(acrossMidnight, at(24)).blocks).toMatchObject([
      { start: at(24), end: at(27) },
    ]);
    expect(calendarDay([segment(at(9), at(11))], date).allDay).toBeUndefined();
    expect(calendarDay([], date).blocks).toEqual([]);
  });
});
