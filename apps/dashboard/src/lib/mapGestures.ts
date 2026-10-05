import type { Map as MapLibreMap } from "maplibre-gl";

// MapLibre guesses "mouse wheel or trackpad?" for every wheel event and can
// change its mind in the middle of one gesture. It also zooms a trackpad pinch
// at a rate that feels sluggish. These handlers take over the gestures a Mac
// trackpad produces and leave the mouse wheel to MapLibre.

// Chrome reports each mouse-wheel notch on macOS as a multiple of this value.
const WHEEL_NOTCH = 4.000244140625;
const WHEEL_NOTCH_TOLERANCE = 1e-3;
// A trackpad gesture is a stream of events. A longer gap starts a new one.
const GESTURE_GAP_MS = 150;
// Browsers report a pinch as ctrl+wheel with a delta of about 100x the change
// in log scale, so exp(-delta / 100) tracks the fingers.
const PINCH_ZOOM_PER_DELTA = 0.01 / Math.LN2;
const MAX_PINCH_DELTA = 50;

export type WheelIntent = "pinch" | "pan" | "wheel";

type WheelLike = Pick<
  WheelEvent,
  "ctrlKey" | "deltaMode" | "deltaX" | "deltaY"
>;

function isMouseWheelDelta(deltaY: number): boolean {
  if (deltaY === 0) return false;
  const magnitude = Math.abs(deltaY);
  // Windows and Linux report whole notches of 100 or 120 pixels.
  if (magnitude >= 100) return true;
  const notches = magnitude / WHEEL_NOTCH;
  return (
    magnitude >= WHEEL_NOTCH &&
    Math.abs(notches - Math.round(notches)) * WHEEL_NOTCH <
      WHEEL_NOTCH_TOLERANCE
  );
}

// `current` is the intent of the gesture this event may continue, so one
// physical gesture never changes its meaning part-way through.
export function classifyWheel(
  event: WheelLike,
  current: WheelIntent | null,
): WheelIntent {
  if (event.ctrlKey) return "pinch";
  if (current === "pan" || current === "wheel") return current;
  if (event.deltaMode !== WheelEvent.DOM_DELTA_PIXEL) return "wheel";
  if (event.deltaX === 0 && isMouseWheelDelta(event.deltaY)) return "wheel";
  return "pan";
}

// Safari reports a trackpad pinch as gesture events, not as wheel events.
interface SafariGestureEvent extends UIEvent {
  scale: number;
  clientX: number;
  clientY: number;
}

export function installTrackpadGestures(map: MapLibreMap): () => void {
  const container = map.getContainer();
  let intent: WheelIntent | null = null;
  let lastWheelAt = 0;
  let gestureStartZoom = 0;

  const pointOf = (clientX: number, clientY: number): [number, number] => {
    const rect = container.getBoundingClientRect();
    return [clientX - rect.left, clientY - rect.top];
  };

  const zoomAround = (zoom: number, clientX: number, clientY: number) => {
    map.easeTo({
      zoom,
      around: map.unproject(pointOf(clientX, clientY)),
      duration: 0,
    });
  };

  const onWheel = (event: WheelEvent) => {
    const now = performance.now();
    if (now - lastWheelAt > GESTURE_GAP_MS) intent = null;
    lastWheelAt = now;
    intent = classifyWheel(event, intent);
    // Leave the mouse wheel to MapLibre's own handler.
    if (intent === "wheel") return;

    event.preventDefault();
    event.stopPropagation();

    if (intent === "pinch") {
      const delta = Math.max(
        -MAX_PINCH_DELTA,
        Math.min(MAX_PINCH_DELTA, event.deltaY),
      );
      zoomAround(
        map.getZoom() - delta * PINCH_ZOOM_PER_DELTA,
        event.clientX,
        event.clientY,
      );
      return;
    }

    map.panBy([event.deltaX, event.deltaY], { duration: 0 });
  };

  const onGestureStart = (event: Event) => {
    event.preventDefault();
    gestureStartZoom = map.getZoom();
  };

  const onGestureChange = (event: Event) => {
    event.preventDefault();
    const gesture = event as SafariGestureEvent;
    if (!(gesture.scale > 0)) return;
    zoomAround(
      gestureStartZoom + Math.log2(gesture.scale),
      gesture.clientX,
      gesture.clientY,
    );
  };

  const onGestureEnd = (event: Event) => event.preventDefault();

  // Capture on the container so these run before MapLibre's own listener on
  // the canvas container and can stop it from also zooming.
  container.addEventListener("wheel", onWheel, {
    capture: true,
    passive: false,
  });
  container.addEventListener("gesturestart", onGestureStart);
  container.addEventListener("gesturechange", onGestureChange);
  container.addEventListener("gestureend", onGestureEnd);

  return () => {
    container.removeEventListener("wheel", onWheel, { capture: true });
    container.removeEventListener("gesturestart", onGestureStart);
    container.removeEventListener("gesturechange", onGestureChange);
    container.removeEventListener("gestureend", onGestureEnd);
  };
}
