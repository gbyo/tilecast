/**
 * The bounded presentation states a Widget element may announce. The
 * element says only what it shows; the host (WidgetMount, then the Player
 * Runtime) decides what that means for playback evidence.
 */
import { boundedCode } from "./identity.ts";

export const WIDGET_READY_EVENT = "tilecast-widget-ready";
export const WIDGET_EMPTY_EVENT = "tilecast-widget-empty";
export const WIDGET_ERROR_EVENT = "tilecast-widget-error";

export interface WidgetEmptyDetail {
  readonly reason: string;
}

export interface WidgetErrorDetail {
  readonly code: string;
}

export interface WidgetElementEventMap {
  [WIDGET_READY_EVENT]: CustomEvent<null>;
  [WIDGET_EMPTY_EVENT]: CustomEvent<WidgetEmptyDetail>;
  [WIDGET_ERROR_EVENT]: CustomEvent<WidgetErrorDetail>;
}

const init = <T>(detail: T): CustomEventInit<T> => ({
  bubbles: true,
  composed: true,
  detail,
});

/** Meaningful content is rendered for the current inputs. */
export function announceReady(element: EventTarget): void {
  element.dispatchEvent(new CustomEvent(WIDGET_READY_EVENT, init(null)));
}

/** The current inputs have no content to show. Not a failure. */
export function announceEmpty(element: EventTarget, reason: string): void {
  element.dispatchEvent(
    new CustomEvent<WidgetEmptyDetail>(
      WIDGET_EMPTY_EVENT,
      init({ reason: boundedCode(reason, "no_content") }),
    ),
  );
}

/** The Widget cannot render its current inputs. */
export function announceError(element: EventTarget, code: string): void {
  element.dispatchEvent(
    new CustomEvent<WidgetErrorDetail>(
      WIDGET_ERROR_EVENT,
      init({ code: boundedCode(code, "widget_error") }),
    ),
  );
}
