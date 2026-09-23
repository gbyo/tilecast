import { useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import type { ScreenGroup, SpanPanel, SpanStatus } from "../api/types";
import { Button, Field, Panel, SectionHeader } from "./legacy-ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import "./SpanWallEditor.css";

type Props = {
  group: ScreenGroup;
  manageable: boolean;
  csrfToken: string;
};

function preset(
  screens: ScreenGroup["screens"],
  width: number,
  height: number,
  columns: number,
): SpanPanel[] {
  const safeColumns = Math.max(1, Math.min(columns, screens.length || 1));
  const rows = Math.max(1, Math.ceil(screens.length / safeColumns));
  return screens.map((screen, index) => {
    const row = Math.floor(index / safeColumns);
    const column = index % safeColumns;
    const x = Math.floor((column * width) / safeColumns);
    const right = Math.floor(((column + 1) * width) / safeColumns);
    const y = Math.floor((row * height) / rows);
    const bottom = Math.floor(((row + 1) * height) / rows);
    return {
      screenId: screen.id,
      screenName: screen.name,
      order: index,
      x,
      y,
      width: right - x,
      height: bottom - y,
      rotation: 0,
      bezelLeft: 0,
      bezelTop: 0,
      bezelRight: 0,
      bezelBottom: 0,
    };
  });
}

export function SpanWallEditor({ group, manageable, csrfToken }: Props) {
  const client = useQueryClient();
  const status = useQuery({
    queryKey: ["screen-groups", group.id, "span"],
    queryFn: () => api.spanStatus(group.id),
    enabled: group.displayMode === "span",
    refetchInterval: 10_000,
  });
  const [canvas, setCanvas] = useState({ width: 1920, height: 1080 });
  const [panels, setPanels] = useState<SpanPanel[]>([]);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (dirty || !status.data) return;
    setCanvas(status.data.geometry.canvas);
    setPanels(status.data.geometry.panels);
  }, [dirty, status.data]);

  const update = useMutation({
    mutationFn: (input: {
      displayMode?: "mirror" | "span";
      canvas?: { width: number; height: number };
      panels?: SpanPanel[];
    }) => api.updateSpanGeometry(group.id, input, csrfToken),
    onSuccess: () => {
      setDirty(false);
      void client.invalidateQueries({ queryKey: ["screen-groups", group.id] });
      void client.invalidateQueries({
        queryKey: ["screen-groups", group.id, "span"],
      });
    },
  });

  const screenNames = useMemo(
    () => new Map(group.screens.map((screen) => [screen.id, screen.name])),
    [group.screens],
  );
  const preparationByScreen = useMemo(() => {
    const map = new Map<string, SpanStatus["preparations"][number]>();
    for (const item of status.data?.preparations ?? [])
      map.set(item.screenId, item);
    return map;
  }, [status.data]);

  const setPanel = (screenId: string, key: keyof SpanPanel, value: number) => {
    setDirty(true);
    setPanels((current) =>
      current.map((panel) =>
        panel.screenId === screenId ? { ...panel, [key]: value } : panel,
      ),
    );
  };

  if (group.displayMode !== "span") {
    return (
      <Panel className="sync-group-panel span-wall-panel">
        <SectionHeader
          title="Wall mode"
          description="Mirror keeps the existing synchronized group behavior. Switch to Span when the screens form one logical canvas."
        />
        {manageable && (
          <Button
            variant="secondary"
            loading={update.isPending}
            disabled={group.screens.length === 0}
            onClick={() => {
              setCanvas({ width: 3840, height: 1080 });
              setPanels(preset(group.screens, 3840, 1080, 2));
              update.mutate({
                displayMode: "span",
                canvas: { width: 3840, height: 1080 },
                panels: preset(group.screens, 3840, 1080, 2),
              });
            }}
          >
            Switch to Span
          </Button>
        )}
      </Panel>
    );
  }

  return (
    <Panel className="sync-group-panel span-wall-panel">
      <SectionHeader
        title="Span wall editor"
        description="Arrange each panel on one logical canvas. Video is prepared into normal-resolution H.264 panel files on the server before playback."
      />
      <div className="span-wall-toolbar">
        <Field label="Canvas width">
          <input
            type="number"
            min={320}
            max={16384}
            value={canvas.width}
            onChange={(event) => {
              setDirty(true);
              setCanvas({ ...canvas, width: Number(event.target.value) });
            }}
          />
        </Field>
        <Field label="Canvas height">
          <input
            type="number"
            min={320}
            max={16384}
            value={canvas.height}
            onChange={(event) => {
              setDirty(true);
              setCanvas({ ...canvas, height: Number(event.target.value) });
            }}
          />
        </Field>
        <div className="span-wall-presets" aria-label="Wall presets">
          <span>Presets</span>
          {[
            { label: "2 × 1", columns: 2 },
            { label: "1 × 2", columns: 1 },
            { label: "2 × 2", columns: 2 },
          ].map((item, index) => (
            <Button
              key={item.label}
              variant="quiet"
              compact
              onClick={() => {
                const nextCanvas =
                  index === 1
                    ? { width: 1920, height: 2160 }
                    : index === 2
                      ? { width: 3840, height: 2160 }
                      : { width: 3840, height: 1080 };
                setCanvas(nextCanvas);
                setPanels(
                  preset(
                    group.screens,
                    nextCanvas.width,
                    nextCanvas.height,
                    item.columns,
                  ),
                );
                setDirty(true);
              }}
            >
              {item.label}
            </Button>
          ))}
        </div>
        {manageable && (
          <div className="span-wall-actions">
            <Button
              variant="primary"
              loading={update.isPending}
              disabled={!dirty}
              onClick={() =>
                update.mutate({ displayMode: "span", canvas, panels })
              }
            >
              Save wall
            </Button>
            <Button
              variant="quiet"
              disabled={update.isPending}
              onClick={() => update.mutate({ displayMode: "mirror" })}
            >
              Return to Mirror
            </Button>
          </div>
        )}
      </div>
      {update.isError && (
        <div className="notice notice--error">
          The wall geometry could not be saved. Check that panels do not overlap
          and fit inside the canvas.
        </div>
      )}
      <div className="span-wall-layout">
        <div
          className="span-wall-preview"
          style={{
            aspectRatio: `${Math.max(canvas.width, 1)} / ${Math.max(canvas.height, 1)}`,
          }}
          aria-label="Span wall preview"
        >
          {panels.map((panel) => (
            <div
              className="span-wall-preview__panel"
              key={panel.screenId}
              style={{
                left: `${(panel.x / canvas.width) * 100}%`,
                top: `${(panel.y / canvas.height) * 100}%`,
                width: `${(panel.width / canvas.width) * 100}%`,
                height: `${(panel.height / canvas.height) * 100}%`,
                transform: `rotate(${panel.rotation}deg)`,
              }}
            >
              <strong>{screenNames.get(panel.screenId) ?? "Screen"}</strong>
              <small>
                {panel.width} × {panel.height}
              </small>
            </div>
          ))}
        </div>
        <div className="span-wall-panels">
          {panels.map((panel) => (
            <fieldset key={panel.screenId} className="span-wall-panel-fields">
              <legend>
                {screenNames.get(panel.screenId) ?? panel.screenId}
              </legend>
              <div className="span-wall-panel-fields__grid">
                {(["x", "y", "width", "height"] as const).map((key) => (
                  <Field key={key} label={key.toUpperCase()}>
                    <input
                      type="number"
                      min={0}
                      value={panel[key]}
                      disabled={!manageable}
                      onChange={(event) =>
                        setPanel(
                          panel.screenId,
                          key,
                          Number(event.target.value),
                        )
                      }
                    />
                  </Field>
                ))}
                <Field label="Rotation">
                  <select
                    value={panel.rotation}
                    disabled={!manageable}
                    onChange={(event) =>
                      setPanel(
                        panel.screenId,
                        "rotation",
                        Number(event.target.value),
                      )
                    }
                  >
                    {[0, 90, 180, 270].map((value) => (
                      <option key={value} value={value}>
                        {value}°
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
            </fieldset>
          ))}
        </div>
      </div>
      {status.isError && (
        <div className="notice notice--error">
          Span preparation status is unavailable.
        </div>
      )}
      {panels.length > 0 && (
        <div className="span-wall-preparations" aria-live="polite">
          <strong>Panel preparation</strong>
          {panels.map((panel) => {
            const item = preparationByScreen.get(panel.screenId);
            const label = item?.status ?? "idle";
            return (
              <span key={panel.screenId}>
                {screenNames.get(panel.screenId) ?? panel.screenId}:{" "}
                <b>{label}</b>
                {item?.progress != null
                  ? ` ${Math.round(item.progress * 100)}%`
                  : ""}
              </span>
            );
          })}
        </div>
      )}
    </Panel>
  );
}
