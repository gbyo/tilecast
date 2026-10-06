/**
 * The server's next-occurrence check of the draft, as the editor consumes it.
 *
 * One aggregated request describes every targeted screen. It is asked only for
 * a draft complete enough to check, only after the scheduling-relevant fields
 * stop changing, and never for edits to the name or description. The last
 * answer stays on screen while a new one loads, marked as checking, so the
 * outcome pane never blanks or shows an old green check as current.
 */
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import type { ScheduleInput, SchedulePreflight } from "../api/types";
import { scheduleQueries } from "../data/schedules";
import { useDebouncedValue } from "../hooks/use-debounced-value";
import { preflightBody, type ScheduleDraft } from "./scheduleEditorModel";

export const PREFLIGHT_DEBOUNCE_MS = 400;

export type SchedulePreflightState =
  /** The draft is missing something the check needs. */
  | { status: "incomplete" }
  | {
      status: "ready" | "checking" | "error";
      /** The last answer. While checking it may describe an earlier draft. */
      result: SchedulePreflight | undefined;
      /** The result describes the draft as it stands now. */
      current: boolean;
      error: Error | null;
      retry: () => void;
      /** The check found something that stops this schedule from saving. */
      blocking: boolean;
    };

type Request = { signature: string; body: ScheduleInput } | null;

export function useSchedulePreflight(
  draft: ScheduleDraft,
  scheduleId: string | undefined,
): SchedulePreflightState {
  // The request and its signature travel together, so a debounced signature
  // can never be sent with a newer body.
  const body = useMemo(() => preflightBody(draft), [draft]);
  const request = useMemo<Request>(
    () => (body ? { signature: JSON.stringify(body), body } : null),
    [body],
  );
  const debounced = useDebouncedValue(request, PREFLIGHT_DEBOUNCE_MS);
  const query = useQuery({
    ...scheduleQueries.preflight(
      scheduleId ?? "",
      debounced?.signature ?? "",
      debounced?.body ?? ({} as ScheduleInput),
    ),
    enabled: debounced !== null,
    placeholderData: keepPreviousData,
  });
  if (!request) return { status: "incomplete" };
  const settled = debounced?.signature === request.signature;
  const current = settled && !query.isFetching && !query.isPlaceholderData;
  const status =
    query.isError && settled ? "error" : current ? "ready" : "checking";
  return {
    status,
    result: query.data,
    current,
    error: query.error,
    retry: () => void query.refetch(),
    blocking:
      current &&
      Boolean(query.data?.issues.some((i) => i.severity === "blocking")),
  };
}

/** How many things the next-run check wants the author to look at. */
export function attentionCount(preflight: SchedulePreflightState) {
  if (preflight.status === "incomplete" || !preflight.result) return 0;
  const { issues, losingScreenCount } = preflight.result;
  return issues.length + (losingScreenCount > 0 ? 1 : 0);
}
