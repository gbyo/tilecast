/**
 * Render-tree intermediate representation.
 *
 * The runtime resolves every widget, layout, and declarative presentation
 * into this small, fully-resolved tree of primitives. All data binding,
 * typed formatting, and date selection happen here in the (testable) core;
 * the renderer receives only concrete strings, colors, and geometry and
 * builds DOM from them with no data logic of its own.
 *
 * This keeps the renderer process tiny and dependency-free — important on
 * 4 GiB / old-Intel hardware — and keeps the hard logic unit-testable in
 * Node without a DOM.
 */

export interface BoxStyle {
  /** Absolute placement (layout zones); omitted for flow children. */
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  background?: string;
  color?: string;
  padding?: number;
  gap?: number;
  direction?: "row" | "column";
  justify?: "start" | "center" | "end" | "space-between" | "space-around";
  align?: "start" | "center" | "end" | "stretch";
  radius?: number;
  borderWidth?: number;
  borderColor?: string;
  opacity?: number;
  grow?: number;
  wrap?: boolean;
  /** Grid template, e.g. "repeat(3, 1fr)". */
  columns?: string;
}

export interface TextStyle {
  color?: string;
  background?: string;
  fontSize?: number;
  fontWeight?: number;
  fontFamily?: string;
  align?: "left" | "center" | "right";
  verticalAlign?: "top" | "center" | "bottom";
  lineHeight?: number;
  letterSpacing?: number;
  maxLines?: number;
  /** Shrink font to fit the box (layout auto-fit primitives). */
  autoFit?: boolean;
  minFontSize?: number;
  padding?: number;
  radius?: number;
  borderWidth?: number;
  borderColor?: string;
}

export type RenderNode =
  | { t: "box"; style: BoxStyle; children: RenderNode[] }
  | { t: "text"; value: string; style: TextStyle }
  | { t: "image"; src: string; fit: string; radius?: number }
  | { t: "qr"; src: string; label?: string }
  | { t: "shape"; shape: "rectangle" | "circle" | "line"; style: ShapeStyle }
  | {
      t: "marquee";
      text: string;
      durationMs: number;
      direction: "left" | "right";
      style: TextStyle;
    }
  | { t: "progress"; ratio: number; color: string; track: string }
  | {
      t: "chart";
      chart: "line" | "bar" | "donut";
      series: number[];
      labels: string[];
      colors: string[];
      style: BoxStyle;
    }
  | { t: "divider"; color: string; vertical: boolean }
  | { t: "spacer"; grow: number }
  // Self-updating nodes: the renderer ticks these locally (once per second /
  // minute) instead of the runtime re-projecting and re-sending the whole
  // tree every tick — critical for keeping IPC and CPU near-idle on low-end
  // hardware while a clock or countdown is on screen.
  | {
      t: "clock";
      timezone: string;
      locale?: string;
      hour12?: boolean;
      showSeconds: boolean;
      style: TextStyle;
    }
  | {
      t: "countdown";
      target: string;
      timezone: string;
      recurrence: "none" | "daily" | "weekly" | "monthly" | "yearly";
      countUp: boolean;
      showDays: boolean;
      showHours: boolean;
      showMinutes: boolean;
      showSeconds: boolean;
      completionText: string;
      completionAction: "completed_text" | "hide" | "count_up";
      /** Use the compact schedule form: 1h 4m, 4m 12s, or 12s. */
      compact?: boolean;
      prefix?: string;
      suffix?: string;
      style: TextStyle;
    };

export interface ShapeStyle {
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  radius?: number;
}

/** A single-zone widget/presentation resolved to one root node. */
export interface WidgetRenderPayload {
  background: string;
  root: RenderNode;
  /** True only when an eligible fullscreen Widget explicitly reports no content. */
  autoSkip?: boolean;
}

/** A multi-zone layout resolved to positioned placements. */
export interface LayoutZone {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  layer: number;
  opacity: number;
  radius?: number;
  /** Exactly one of the following is set. */
  render?: RenderNode; // widget or primitive
  image?: { src: string; fit: string }; // asset placement
  playlistItems?: LayoutPlaylistItem[]; // playlistZone: rotates locally
}

export interface LayoutPlaylistItem {
  id: string;
  kind: "image" | "video";
  src: string;
  durationMs: number | null;
  fit: string;
  muted: boolean;
  volume: number;
  loop: boolean;
}

export interface LayoutRenderPayload {
  canvasWidth: number;
  canvasHeight: number;
  background: string;
  backgroundImage?: string;
  backgroundImageViewport?: {
    x: number;
    y: number;
    width: number;
    height: number;
    canvasWidth: number;
    canvasHeight: number;
  };
  zones: LayoutZone[];
}
