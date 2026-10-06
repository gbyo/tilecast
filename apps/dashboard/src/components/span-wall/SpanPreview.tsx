import { useTranslation } from "react-i18next";
import type { SpanPanel } from "../../api/types";
import type { SpanCanvas } from "./spanWallModel";

/** The wall drawn to scale. Decorative to assistive technology beyond its name. */
export function SpanPreview({
  canvas,
  panels,
  screenNames,
}: {
  canvas: SpanCanvas;
  panels: readonly SpanPanel[];
  screenNames: ReadonlyMap<string, string>;
}) {
  const { t } = useTranslation("layouts");
  return (
    <div
      className="relative min-h-40 w-full overflow-hidden rounded-lg border border-border bg-black"
      style={{
        aspectRatio: `${Math.max(canvas.width, 1)} / ${Math.max(canvas.height, 1)}`,
      }}
      role="img"
      aria-label={t("spanWall.previewLabel")}
    >
      {panels.map((panel) => (
        <div
          className="absolute flex flex-col items-center justify-center gap-1 overflow-hidden border border-sky-300 bg-sky-900 text-slate-50"
          key={panel.screenId}
          style={{
            left: `${(panel.x / canvas.width) * 100}%`,
            top: `${(panel.y / canvas.height) * 100}%`,
            width: `${(panel.width / canvas.width) * 100}%`,
            height: `${(panel.height / canvas.height) * 100}%`,
            transform: `rotate(${panel.rotation}deg)`,
          }}
        >
          <strong className="text-sm">
            {screenNames.get(panel.screenId) ?? t("spanWall.unknownScreen")}
          </strong>
          <small className="text-xs text-sky-200">
            {panel.width} × {panel.height}
          </small>
        </div>
      ))}
    </div>
  );
}
