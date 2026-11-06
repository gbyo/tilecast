import type { PlaybackAgendaSegment } from "../../api/domains/playbackPlan";

const hour = 60 * 60_000;
type Selection = PlaybackAgendaSegment["selected"];

export type PlaybackBlock = {
  start: Date;
  end: Date;
  selection: Selection;
  overlaps: {
    start: Date;
    end: Date;
    candidates: PlaybackAgendaSegment["superseded"];
  }[];
};

export function agendaDate(date: Date, days = 0) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

export function hoursSince(date: Date, start: Date) {
  return (date.getTime() - start.getTime()) / hour;
}

function sameSelection(a: Selection, b: Selection) {
  return (
    a?.source === b?.source &&
    a?.contentId === b?.contentId &&
    a?.selectionId === b?.selectionId &&
    a?.revision === b?.revision
  );
}

export function calendarDay(segments: PlaybackAgendaSegment[], date: Date) {
  const end = agendaDate(date, 1);
  const blocks: PlaybackBlock[] = [];
  for (const segment of segments) {
    const startMs = Math.max(Date.parse(segment.start), date.getTime());
    const endMs = Math.min(Date.parse(segment.end), end.getTime());
    if (startMs >= endMs) continue;
    const start = new Date(startMs);
    const finish = new Date(endMs);
    let block = blocks.at(-1);
    // A competing schedule can start and end without changing what's selected.
    // Keep that evidence inside one calendar event for the winning content.
    if (
      block &&
      block.end.getTime() === startMs &&
      sameSelection(block.selection, segment.selected)
    ) {
      block.end = finish;
    } else {
      block = { start, end: finish, selection: segment.selected, overlaps: [] };
      blocks.push(block);
    }
    if (segment.superseded.length) {
      block.overlaps.push({
        start,
        end: finish,
        candidates: segment.superseded,
      });
    }
  }
  const first = blocks[0];
  const allDay =
    first?.start.getTime() === date.getTime() &&
    first.end.getTime() === end.getTime()
      ? first
      : undefined;
  return {
    date,
    end,
    hours: hoursSince(end, date),
    blocks: allDay ? [] : blocks,
    allDay,
  };
}
