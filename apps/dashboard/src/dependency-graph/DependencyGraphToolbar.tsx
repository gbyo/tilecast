import {
  Maximize,
  PanelRight,
  ZoomIn,
  ZoomOut,
  type LucideIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type { DependencyNode } from "../api/types";
import { Button } from "../components/ui/button";
import { ButtonGroup } from "../components/ui/button-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "../components/ui/toggle-group";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../components/ui/tooltip";
import { DependencyResourceSearch } from "./DependencyResourceSearch";
import type { GraphViewport } from "./DependencyGraphCanvas";
import type { Depth, Direction, GraphIndex } from "./graphModel";
import { parseDepth, parseDirection } from "./explorerUrlState";

const directions: Direction[] = ["dependencies", "both", "consumers"];
const depths: Depth[] = [1, 2, 3, "all"];

function IconAction({
  label,
  icon: Icon,
  onClick,
}: {
  label: string;
  icon: LucideIcon;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label={label}
            onClick={onClick}
          />
        }
      >
        <Icon aria-hidden="true" />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export function DependencyGraphToolbar({
  index,
  focused,
  direction,
  depth,
  view,
  onSelectResource,
  onDirectionChange,
  onDepthChange,
  onOpenDetails,
}: {
  index: GraphIndex;
  /** Direction and depth only apply once a resource is the root. */
  focused: boolean;
  direction: Direction;
  depth: Depth;
  view: GraphViewport;
  onSelectResource: (node: DependencyNode) => void;
  onDirectionChange: (direction: Direction) => void;
  onDepthChange: (depth: Depth) => void;
  /** Narrow layouts open the inspector Sheet from here. */
  onOpenDetails?: () => void;
}) {
  const { t } = useTranslation(["content", "common"]);
  const depthLabel = (value: Depth) =>
    value === "all"
      ? t("graph.toolbar.allDepths")
      : t("graph.toolbar.hops", { count: value });
  return (
    <div className="flex flex-wrap items-center gap-2">
      <DependencyResourceSearch index={index} onSelect={onSelectResource} />
      {focused && (
        <>
          <ToggleGroup
            aria-label={t("graph.toolbar.direction")}
            variant="outline"
            spacing={0}
            multiple={false}
            value={[direction]}
            onValueChange={(next) => {
              const first = next[0];
              if (first !== undefined) onDirectionChange(parseDirection(first));
            }}
          >
            {directions.map((value) => (
              <ToggleGroupItem key={value} value={value}>
                {t(`graph.toolbar.${value}`)}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <Select
            items={depths.map((value) => ({
              value: String(value),
              label: depthLabel(value),
            }))}
            value={String(depth)}
            onValueChange={(value) => onDepthChange(parseDepth(value))}
          >
            <SelectTrigger
              aria-label={t("graph.toolbar.depth")}
              className="w-28 max-sm:flex-1"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {depths.map((value) => (
                <SelectItem key={value} value={String(value)}>
                  {depthLabel(value)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </>
      )}
      <div className="ml-auto flex items-center gap-2">
        {onOpenDetails && (
          <Button type="button" variant="outline" onClick={onOpenDetails}>
            <PanelRight aria-hidden="true" />
            {t("graph.toolbar.details")}
          </Button>
        )}
        <ButtonGroup aria-label={t("graph.toolbar.zoom")}>
          <IconAction
            label={t("graph.toolbar.zoomOut")}
            icon={ZoomOut}
            onClick={view.zoomOut}
          />
          <IconAction
            label={t("graph.toolbar.zoomIn")}
            icon={ZoomIn}
            onClick={view.zoomIn}
          />
          <IconAction
            label={t("graph.toolbar.fitGraph")}
            icon={Maximize}
            onClick={view.fit}
          />
        </ButtonGroup>
      </div>
    </div>
  );
}
