/**
 * The one Studio preview for migrated V2 Widgets
 * (docs/widgets-v2-authoring-and-first-wave.md).
 *
 * React owns this chrome; the Widget owns everything inside the frame.
 * The real Web Component renders through the shared WidgetMount from the
 * Studio registry — the same element the Player mounts. There are no
 * Studio-only Widget renderers on this path.
 */
import { useEffect, useRef } from "react";
import {
  WidgetMount,
  type WidgetComponentRef,
  type WidgetMountState,
} from "@tilecast/widget-sdk/mount";
import type { WidgetContext, WidgetResources } from "@tilecast/widget-sdk";
import { studioWidgetDiscovery } from "./studioWidgets";

export interface PreviewFrame {
  readonly width: number;
  readonly height: number;
}

export function WidgetPreviewHost({
  component,
  resources,
  context,
  frame,
  label,
  onState,
}: {
  /** Compiled component config; form edits update it in place. */
  component: WidgetComponentRef;
  resources: WidgetResources;
  context: WidgetContext;
  /** Preview container dimensions. Sizes the frame, never the Widget. */
  frame: PreviewFrame;
  label: string;
  onState?: (state: WidgetMountState) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mountRef = useRef<WidgetMount | null>(null);
  const stateRef = useRef(onState);
  stateRef.current = onState;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const mount = new WidgetMount({
      registry: studioWidgetDiscovery.registry,
      container,
      component,
      resources,
      context,
      onState: (state) => stateRef.current?.(state),
    });
    mountRef.current = mount;
    return () => {
      mountRef.current = null;
      mount.dispose();
    };
    // Mount once per placement: type/version changes below remount through
    // update(), and anything else updates the element in place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // Ordinary form edits compile locally and update the element in place,
    // so the preview never remounts (and never calls the Server) per keystroke.
    mountRef.current?.update({ component, resources, context });
  }, [component, resources, context]);

  // A new frame resizes the container only; the mounted element survives
  // and its container queries respond to the new box.
  return (
    <div
      role="img"
      aria-label={label}
      style={{
        width: `${frame.width}px`,
        height: `${frame.height}px`,
        maxWidth: "100%",
        overflow: "auto",
        position: "relative",
        background: "#000",
      }}
    >
      <div
        ref={containerRef}
        style={{ width: `${frame.width}px`, height: `${frame.height}px` }}
      />
    </div>
  );
}
