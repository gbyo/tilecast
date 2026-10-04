/**
 * The bounded presentation states a Widget element may announce. The
 * element says only what it shows; the host (WidgetMount, then the Player
 * Runtime) decides what that means for playback evidence.
 */
import { boundedCode } from "./identity.ts";

export const WIDGET_READY_EVENT = "tilecast-widget-ready";
export const WIDGET_EMPTY_EVENT = "tilecast-widget-empty";
export const WIDGET_ERROR_EVENT = "tilecast-widget-error";

export interface WidgetReadyDetail {
  readonly revision: number;
}

export interface WidgetEmptyDetail {
  readonly reason: string;
  readonly revision: number;
}

export interface WidgetErrorDetail {
  readonly code: string;
  readonly revision: number;
}

export interface WidgetElementEventMap {
  [WIDGET_READY_EVENT]: CustomEvent<WidgetReadyDetail>;
  [WIDGET_EMPTY_EVENT]: CustomEvent<WidgetEmptyDetail>;
  [WIDGET_ERROR_EVENT]: CustomEvent<WidgetErrorDetail>;
}

const INPUT_REVISION = Symbol.for("tilecast.widget.inputRevision");

/** Read the input revision currently assigned by WidgetMount. */
export function widgetInputRevision(element: EventTarget): number {
  const revision = (
    element as EventTarget & {
      [key: symbol]: unknown;
    }
  )[INPUT_REVISION];
  return typeof revision === "number" && Number.isSafeInteger(revision)
    ? revision
    : 0;
}

/** @internal Set the revision before WidgetMount assigns the next inputs. */
export function setWidgetInputRevision(
  element: EventTarget,
  revision: number,
): void {
  Object.defineProperty(element, INPUT_REVISION, {
    configurable: true,
    value: revision,
  });
}

const init = <T>(detail: T): CustomEventInit<T> => ({
  bubbles: true,
  composed: true,
  detail,
});

/** Meaningful content is rendered for the current inputs. */
export function announceReady(
  element: EventTarget,
  revision = widgetInputRevision(element),
): void {
  element.dispatchEvent(
    new CustomEvent<WidgetReadyDetail>(WIDGET_READY_EVENT, init({ revision })),
  );
}

/** The current inputs have no content to show. Not a failure. */
export function announceEmpty(
  element: EventTarget,
  reason: string,
  revision = widgetInputRevision(element),
): void {
  element.dispatchEvent(
    new CustomEvent<WidgetEmptyDetail>(
      WIDGET_EMPTY_EVENT,
      init({ reason: boundedCode(reason, "no_content"), revision }),
    ),
  );
}

/** The Widget cannot render its current inputs. */
export function announceError(
  element: EventTarget,
  code: string,
  revision = widgetInputRevision(element),
): void {
  element.dispatchEvent(
    new CustomEvent<WidgetErrorDetail>(
      WIDGET_ERROR_EVENT,
      init({ code: boundedCode(code, "widget_error"), revision }),
    ),
  );
}
