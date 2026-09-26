import {
  type FocusEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { cn } from "cn";
import { Badge } from "../components/ui/badge";
import type { Box, GraphLayout, LayoutItem } from "./graphLayout";
import { typePresentation } from "./resourceTypes";

export type Viewport = { x: number; y: number; scale: number };

export const MIN_SCALE = 0.25;
export const MAX_SCALE = 2;
/** Automatic views never shrink a focused graph below this scale. */
export const READABLE_SCALE = 0.8;
const FIT_MARGIN = 24;

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

function fittedScale(layout: GraphLayout, width: number, height: number) {
  return Math.min(
    (width - FIT_MARGIN * 2) / layout.width,
    (height - FIT_MARGIN * 2) / layout.height,
  );
}

function centred(
  layout: GraphLayout,
  width: number,
  height: number,
  scale: number,
): Viewport {
  return {
    scale,
    x: (width - layout.width * scale) / 2,
    y: Math.max(FIT_MARGIN, (height - layout.height * scale) / 2),
  };
}

/**
 * The view an operator lands on. A graph that fits at a readable scale is
 * centred whole; a larger one stays readable and centres on its root, and
 * Fit shows the rest on request.
 */
export function automaticViewport(
  layout: GraphLayout,
  width: number,
  height: number,
): Viewport {
  const fit = fittedScale(layout, width, height);
  if (!layout.focusKey)
    return centred(layout, width, height, clamp(fit, 0.5, 1));
  if (fit >= READABLE_SCALE)
    return centred(layout, width, height, Math.min(1, fit));
  const focus = layout.items.find((item) => item.key === layout.focusKey);
  if (!focus) return centred(layout, width, height, READABLE_SCALE);
  const scale = READABLE_SCALE;
  return {
    scale,
    x: width / 2 - (focus.box.x + focus.box.width / 2) * scale,
    y: height / 2 - (focus.box.y + focus.box.height / 2) * scale,
  };
}

/**
 * Viewport state for one canvas. `viewKey` names the visible graph: when it
 * changes, the view resets to the automatic view of the new layout. Resizing
 * the pane re-applies that view until the operator pans or zooms, and keeps
 * their view after that.
 */
export function useGraphViewport(layout: GraphLayout, viewKey: string) {
  // A state-backed ref, so the view is applied once the canvas mounts after
  // loading rather than only when the graph changes.
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [viewport, setViewport] = useState<Viewport>({
    x: 0,
    y: 0,
    scale: 1,
  });
  const appliedKey = useRef<string | undefined>(undefined);
  const adjusted = useRef(false);
  const layoutRef = useRef(layout);
  useLayoutEffect(() => {
    layoutRef.current = layout;
  }, [layout]);

  const size = useCallback(() => {
    const bounds = element?.getBoundingClientRect();
    return bounds && bounds.width > 0 && bounds.height > 0 ? bounds : undefined;
  }, [element]);

  const applyAutomatic = useCallback(() => {
    const bounds = size();
    if (!bounds) return;
    setViewport(
      automaticViewport(layoutRef.current, bounds.width, bounds.height),
    );
    appliedKey.current = viewKey;
    adjusted.current = false;
  }, [size, viewKey]);

  useLayoutEffect(() => {
    if (appliedKey.current !== viewKey) applyAutomatic();
  }, [applyAutomatic, viewKey]);

  useEffect(() => {
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (appliedKey.current !== viewKey || !adjusted.current) applyAutomatic();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [applyAutomatic, element, viewKey]);

  /** Every change the operator makes goes through here. */
  const adjust = useCallback((update: (current: Viewport) => Viewport) => {
    adjusted.current = true;
    setViewport(update);
  }, []);

  const zoomAt = useCallback(
    (factor: number, pointX?: number, pointY?: number) => {
      const bounds = size();
      if (!bounds) return;
      const x = pointX ?? bounds.width / 2;
      const y = pointY ?? bounds.height / 2;
      adjust((current) => {
        const scale = clamp(current.scale * factor, MIN_SCALE, MAX_SCALE);
        const worldX = (x - current.x) / current.scale;
        const worldY = (y - current.y) / current.scale;
        return { scale, x: x - worldX * scale, y: y - worldY * scale };
      });
    },
    [adjust, size],
  );

  const fit = useCallback(() => {
    const bounds = size();
    if (!bounds) return;
    const current = layoutRef.current;
    const scale = clamp(
      fittedScale(current, bounds.width, bounds.height),
      MIN_SCALE,
      1,
    );
    adjust(() => centred(current, bounds.width, bounds.height, scale));
  }, [adjust, size]);

  /** Pans just enough to bring a box on screen, as keyboard focus moves. */
  const reveal = useCallback(
    (box: Box) => {
      const bounds = size();
      if (!bounds) return;
      adjust((current) => {
        const left = current.x + box.x * current.scale;
        const top = current.y + box.y * current.scale;
        const right = left + box.width * current.scale;
        const bottom = top + box.height * current.scale;
        let dx = 0;
        let dy = 0;
        if (left < FIT_MARGIN) dx = FIT_MARGIN - left;
        else if (right > bounds.width - FIT_MARGIN)
          dx = bounds.width - FIT_MARGIN - right;
        if (top < FIT_MARGIN) dy = FIT_MARGIN - top;
        else if (bottom > bounds.height - FIT_MARGIN)
          dy = bounds.height - FIT_MARGIN - bottom;
        return dx === 0 && dy === 0
          ? current
          : { ...current, x: current.x + dx, y: current.y + dy };
      });
    },
    [adjust, size],
  );

  return {
    element,
    canvasRef: setElement,
    viewport,
    adjust,
    zoomIn: useCallback(() => zoomAt(1.2), [zoomAt]),
    zoomOut: useCallback(() => zoomAt(1 / 1.2), [zoomAt]),
    zoomAt,
    fit,
    reveal,
  };
}

export type GraphViewport = ReturnType<typeof useGraphViewport>;

const nodeClass =
  "absolute flex items-center gap-2.5 rounded-md border border-border bg-card px-3 text-left text-card-foreground outline-none transition-colors hover:bg-accent focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 motion-reduce:transition-none [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground";
// The root keeps its primary border while a group beside it is inspected;
// whatever the inspector shows also gets the ring.
const rootClass = "border-primary";
const currentClass = "border-primary ring-1 ring-primary";

function GraphNode({
  item,
  root,
  current,
  onActivate,
  onFocus,
}: {
  item: LayoutItem;
  root: boolean;
  current: boolean;
  onActivate: (item: LayoutItem) => void;
  onFocus: (box: Box) => void;
}) {
  const { t } = useTranslation(["content", "common"]);
  const style = {
    left: item.box.x,
    top: item.box.y,
    width: item.box.width,
    height: item.box.height,
  };
  const common = {
    type: "button" as const,
    "data-graph-node": "",
    style,
    onClick: () => onActivate(item),
    // Only keyboard focus pans: panning under a pointer would move the node
    // away before the click lands.
    onFocus: (event: FocusEvent<HTMLButtonElement>) => {
      if (event.currentTarget.matches(":focus-visible")) onFocus(item.box);
    },
  };
  if (item.kind === "type") {
    const presentation = typePresentation[item.type];
    const Icon = presentation.icon;
    return (
      <button
        {...common}
        aria-pressed={current}
        className={cn(nodeClass, current && currentClass)}
      >
        <Icon aria-hidden="true" />
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-sm font-medium",
            item.count === 0 && "text-muted-foreground",
          )}
        >
          {t(presentation.pluralKey)}
        </span>{" "}
        <Badge variant="secondary" className="tabular-nums">
          {item.count}
        </Badge>
      </button>
    );
  }
  if (item.kind === "group") {
    const presentation = typePresentation[item.group.type];
    const Icon = presentation.icon;
    return (
      <button
        {...common}
        aria-pressed={current}
        className={cn(nodeClass, "border-dashed", current && currentClass)}
      >
        <Icon aria-hidden="true" />
        <span className="grid min-w-0">
          <span className="truncate text-sm font-medium">
            {t(presentation.countKey, { count: item.group.members.length })}
          </span>{" "}
          <span className="truncate text-xs text-muted-foreground">
            {t(presentation.viewKey)}
          </span>
        </span>
      </button>
    );
  }
  const presentation = typePresentation[item.node.type];
  const Icon = presentation.icon;
  return (
    <button
      {...common}
      aria-current={root ? "true" : undefined}
      className={cn(nodeClass, root && rootClass, current && currentClass)}
    >
      <Icon aria-hidden="true" />
      <span className="grid min-w-0">
        <span className="truncate text-sm font-medium">{item.node.name}</span>{" "}
        <span className="truncate text-xs text-muted-foreground">
          {t(presentation.labelKey)}
        </span>
      </span>
    </button>
  );
}

/**
 * The graph surface. Connections are drawn in SVG for sighted readers only;
 * every node is a real button in reading order, and the inspector carries
 * the same relationships as text.
 */
export function DependencyGraphCanvas({
  layout,
  view,
  currentKey,
  showEdgeCounts,
  onActivate,
}: {
  layout: GraphLayout;
  view: GraphViewport;
  /** The root, or the selected type or group. */
  currentKey?: string;
  /** Label edges touching the current node with their relationship counts. */
  showEdgeCounts?: boolean;
  onActivate: (item: LayoutItem) => void;
}) {
  const { t } = useTranslation(["content", "common"]);
  const markerId = `dependency-arrow-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const { element, canvasRef, viewport, adjust, zoomAt, reveal } = view;
  const drag = useRef<
    { pointerX: number; pointerY: number; x: number; y: number } | undefined
  >(undefined);
  const [dragging, setDragging] = useState(false);

  // React's wheel listener is passive, so it cannot stop the page scrolling.
  useEffect(() => {
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const bounds = element.getBoundingClientRect();
      zoomAt(
        clamp(Math.exp(-event.deltaY * 0.0015), 0.9, 1.1),
        event.clientX - bounds.left,
        event.clientY - bounds.top,
      );
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [element, zoomAt]);

  const handlePointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest("[data-graph-node]")) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      pointerX: event.clientX,
      pointerY: event.clientY,
      x: viewport.x,
      y: viewport.y,
    };
    setDragging(true);
  };
  const handlePointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const start = drag.current;
    if (!start) return;
    adjust((current) => ({
      ...current,
      x: start.x + event.clientX - start.pointerX,
      y: start.y + event.clientY - start.pointerY,
    }));
  };
  const endDrag = () => {
    drag.current = undefined;
    setDragging(false);
  };

  const touches = (key: string) => key === currentKey;
  return (
    <section
      ref={canvasRef}
      aria-label={t("graph.canvasLabel")}
      // overflow-clip, unlike hidden, cannot be scrolled when focus lands on
      // an off-screen node, so the viewport stays the only source of position.
      className={cn(
        "relative size-full min-h-0 touch-none overflow-clip bg-background select-none",
        dragging ? "cursor-grabbing" : "cursor-grab",
      )}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      <div
        className="absolute top-0 left-0 origin-top-left"
        style={{
          width: layout.width,
          height: layout.height,
          transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})`,
        }}
      >
        <svg
          className="pointer-events-none absolute inset-0 overflow-visible"
          width={layout.width}
          height={layout.height}
          aria-hidden="true"
        >
          <defs>
            <marker
              id={markerId}
              markerWidth="8"
              markerHeight="8"
              refX="7"
              refY="4"
              orient="auto"
              markerUnits="userSpaceOnUse"
            >
              <path d="M0,0 L8,4 L0,8 Z" className="fill-muted-foreground" />
            </marker>
            <marker
              id={`${markerId}-current`}
              markerWidth="8"
              markerHeight="8"
              refX="7"
              refY="4"
              orient="auto"
              markerUnits="userSpaceOnUse"
            >
              <path d="M0,0 L8,4 L0,8 Z" className="fill-primary" />
            </marker>
          </defs>
          {layout.edges.map((edge) => {
            const active = touches(edge.from) || touches(edge.to);
            return (
              <path
                key={edge.key}
                data-graph-edge=""
                d={edge.d}
                className={cn(
                  "fill-none",
                  active
                    ? "stroke-primary [stroke-width:2]"
                    : "stroke-muted-foreground/45 [stroke-width:1.25]",
                )}
                markerEnd={`url(#${active ? `${markerId}-current` : markerId})`}
              />
            );
          })}
        </svg>
        {showEdgeCounts &&
          layout.edges
            .filter((edge) => touches(edge.from) || touches(edge.to))
            .map((edge) => (
              <span
                key={edge.key}
                aria-hidden="true"
                className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-sm bg-background px-1 text-xs text-foreground tabular-nums"
                style={{ left: edge.labelX, top: edge.labelY }}
              >
                {edge.count}
              </span>
            ))}
        {layout.headings.map((heading) => (
          <p
            key={heading.key}
            className="absolute truncate text-xs font-medium text-muted-foreground"
            style={{ left: heading.x, top: heading.y, width: heading.width }}
          >
            {t(`graph.stages.${heading.key}`)}
          </p>
        ))}
        {layout.items.map((item) => (
          <GraphNode
            key={item.key}
            item={item}
            root={item.key === layout.focusKey}
            current={item.key === currentKey}
            onActivate={onActivate}
            onFocus={reveal}
          />
        ))}
      </div>
      <p className="pointer-events-none absolute bottom-2 left-3 text-xs text-muted-foreground max-sm:hidden">
        {t("graph.panHint")}
      </p>
    </section>
  );
}
