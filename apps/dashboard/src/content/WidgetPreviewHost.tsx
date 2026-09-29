/**
 * The one Studio preview for migrated V2 Widgets
 * (docs/widgets-v2-authoring-and-first-wave.md).
 *
 * React owns this chrome; the Widget owns everything inside the frame.
 * The real Web Component renders through the shared WidgetMount from the
 * Studio registry — the same element the Player mounts. There are no
 * Studio-only Widget renderers on this path.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
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
  const viewportRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const mountRef = useRef<WidgetMount | null>(null);
  const [previewScale, setPreviewScale] = useState(1);
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

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const fitToWidth = (availableWidth: number) => {
      if (availableWidth <= 0) return;
      const nextScale = Math.min(1, availableWidth / frame.width);
      setPreviewScale((current) =>
        Math.abs(current - nextScale) < 0.001 ? current : nextScale,
      );
    };

    fitToWidth(viewport.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      // Modern ResizeObserver reports the actual content box directly. Keep
      // contentRect as the compatibility fallback for engines that do not.
      const contentBoxSize = entry.contentBoxSize;
      const firstContentBox = Array.isArray(contentBoxSize)
        ? (contentBoxSize as readonly ResizeObserverSize[])[0]
        : (contentBoxSize as unknown as ResizeObserverSize | undefined);
      fitToWidth(firstContentBox?.inlineSize ?? entry.contentRect.width);
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [frame.width]);

  // Keep the Widget at the selected intrinsic frame size so its container
  // queries match playback, then scale that whole surface down when the Studio
  // column is narrower. Shrinking only the outer box would crop a 960px Widget
  // inside a ~600px editor column.
  return (
    <div
      ref={viewportRef}
      role="img"
      aria-label={label}
      style={{
        width: `${frame.width}px`,
        maxWidth: "100%",
        aspectRatio: `${frame.width} / ${frame.height}`,
        overflow: "hidden",
        position: "relative",
        background: "#000",
      }}
    >
      <div
        style={{
          width: `${frame.width}px`,
          height: `${frame.height}px`,
          transform: `scale(${previewScale})`,
          transformOrigin: "top left",
        }}
      >
        <div
          ref={containerRef}
          style={{ width: `${frame.width}px`, height: `${frame.height}px` }}
        />
      </div>
    </div>
  );
}
