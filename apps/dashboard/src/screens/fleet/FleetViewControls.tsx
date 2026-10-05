import {
  ArrowDownUp,
  ChevronDown,
  Grid2X2,
  List,
  MapPinned,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/button";
import { ButtonGroup } from "../../components/ui/button-group";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "../../components/ui/toggle-group";
import { useDesktopLayout } from "../../hooks/use-desktop-layout";
import { fleetGroupOptions, fleetSortOptions } from "./fleetModel";

export type FleetView = "table" | "grid" | "map";

type Props = {
  groupBy: string;
  onGroupByChange: (value: string) => void;
  sort: string;
  onSortChange: (value: string) => void;
};

function useOptionLabels() {
  const { t } = useTranslation("screens");
  const groupLabel = (value: string) => {
    const option = fleetGroupOptions.find((item) => item.value === value);
    return option ? t(option.labelKey) : value;
  };
  const sortLabel = (value: string) => {
    const option = fleetSortOptions.find((item) => item.value === value);
    return option ? t(option.labelKey) : value;
  };
  return { t, groupLabel, sortLabel };
}

/**
 * Grouping and sorting both reorganize the same result set, so on wider
 * screens they read as one compound control: the group is a visible Select,
 * because it changes the structure of the results and its value should stay
 * on screen, and the sort is a compact icon menu.
 */
export function FleetGroupSort({
  groupBy,
  onGroupByChange,
  sort,
  onSortChange,
}: Props) {
  const { t, groupLabel, sortLabel } = useOptionLabels();
  return (
    <ButtonGroup aria-label={t("list.organizeGroup")}>
      <Select
        items={fleetGroupOptions.map((option) => ({
          value: option.value,
          label: t(option.labelKey),
        }))}
        value={groupBy}
        onValueChange={(next) => {
          if (next) onGroupByChange(next);
        }}
      >
        <SelectTrigger
          aria-label={t("list.groupSelectLabel", {
            value: groupLabel(groupBy),
          })}
          className="min-w-32"
        >
          <span className="text-muted-foreground">{t("list.groupPrefix")}</span>
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="start">
          {fleetGroupOptions.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {t(option.labelKey)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="outline" size="icon" />}
          aria-label={t("list.sortButtonLabel", { value: sortLabel(sort) })}
          title={t("list.sortButtonLabel", { value: sortLabel(sort) })}
        >
          <ArrowDownUp aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-52">
          <DropdownMenuGroup>
            <DropdownMenuLabel>{t("list.sortMenuTitle")}</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={sort}
              onValueChange={(next) => onSortChange(String(next))}
            >
              {fleetSortOptions.map((option) => (
                <DropdownMenuRadioItem key={option.value} value={option.value}>
                  {t(option.labelKey)}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </ButtonGroup>
  );
}

/** Phone layout: Group and Sort share one menu so the toolbar stays one row. */
export function FleetViewOptionsMenu({
  groupBy,
  onGroupByChange,
  sort,
  onSortChange,
}: Props) {
  const { t } = useOptionLabels();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="outline" />}>
        <ArrowDownUp aria-hidden="true" />
        {/* The label gives way to the icon on the narrowest phones so the
            Filters count never pushes the view controls onto a second row. */}
        <span className="max-[479px]:sr-only">{t("list.viewOptions")}</span>
        <ChevronDown aria-hidden="true" className="text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{t("list.groupBy")}</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={groupBy}
            onValueChange={(next) => onGroupByChange(String(next))}
          >
            {fleetGroupOptions.map((option) => (
              <DropdownMenuRadioItem key={option.value} value={option.value}>
                {t(option.labelKey)}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>{t("list.sortMenuTitle")}</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={sort}
            onValueChange={(next) => onSortChange(String(next))}
          >
            {fleetSortOptions.map((option) => (
              <DropdownMenuRadioItem key={option.value} value={option.value}>
                {t(option.labelKey)}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function FleetViewToggle({
  view,
  onViewChange,
}: {
  view: FleetView;
  onViewChange: (view: FleetView) => void;
}) {
  const { t } = useTranslation("screens");
  // Below the desktop width the page always shows the preview grid, so the
  // table option is not offered at all rather than hidden.
  const desktop = useDesktopLayout();
  return (
    <ToggleGroup
      className="flex"
      value={[view]}
      multiple={false}
      onValueChange={(values) => {
        const selected = values[0];
        if (selected === "table" || selected === "grid" || selected === "map") {
          onViewChange(selected);
        }
      }}
      aria-label={t("list.viewLabel")}
      variant="outline"
      spacing={0}
    >
      {desktop && (
        <ToggleGroupItem
          value="table"
          aria-label={t("list.tableView")}
          title={t("list.tableView")}
        >
          <List aria-hidden="true" />
        </ToggleGroupItem>
      )}
      <ToggleGroupItem
        value="grid"
        aria-label={t("list.gridView")}
        title={t("list.gridView")}
      >
        <Grid2X2 aria-hidden="true" />
      </ToggleGroupItem>
      <ToggleGroupItem
        value="map"
        aria-label={t("list.mapView")}
        title={t("list.mapView")}
      >
        <MapPinned aria-hidden="true" />
      </ToggleGroupItem>
    </ToggleGroup>
  );
}
