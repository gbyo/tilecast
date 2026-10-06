import { useQuery } from "@tanstack/react-query";
import { Monitor, MonitorSpeaker, X } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import type { ScheduleTarget, Screen, ScreenGroup } from "../api/types";
import { screenQueries } from "../data/screens";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import {
  Combobox,
  ComboboxCollection,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
  ComboboxTrigger,
} from "../components/ui/combobox";
import { Field, FieldDescription, FieldError } from "../components/ui/field";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "../components/ui/item";
import { Spinner } from "../components/ui/spinner";
import type { SchedulesT } from "./scheduleBuilderModel";
import {
  problemMessage,
  targetKey,
  withoutTarget,
} from "./scheduleEditorModel";
import { EditorSection } from "./scheduleEditorParts";
import type { ScheduleEditorSession } from "./useScheduleEditorSession";

type TargetOption = {
  key: string;
  type: ScheduleTarget["type"];
  id: string;
  name: string;
  detail: string;
  /** Lower-cased text the search matches, including a group's members. */
  search: string;
};
type TargetGroup = {
  value: "groups" | "screens";
  label: string;
  items: TargetOption[];
};

const groupsQuery = {
  queryKey: ["screen-groups"],
  queryFn: () => api.screenGroups(),
} as const;

/** Where the schedule applies: Display Groups and individual screens. */
export function ScheduleTargetsSection({
  session,
}: {
  session: ScheduleEditorSession;
}) {
  const { t } = useTranslation("schedules");
  const { draft, edit, errors, readOnly } = session;
  const problem = errors.targets ? problemMessage(errors.targets, t) : null;
  // The fleet is read when someone opens the picker, not when the editor opens:
  // a saved schedule already names its targets.
  const [catalogWanted, setCatalogWanted] = useState(false);
  const screens = useQuery({
    ...screenQueries.list(),
    enabled: catalogWanted,
  });
  const groups = useQuery({ ...groupsQuery, enabled: catalogWanted });
  const catalog = useMemo(
    () => buildCatalog(screens.data?.items, groups.data?.items, t),
    [screens.data?.items, groups.data?.items, t],
  );
  const known = useMemo(
    () =>
      new Map(catalog.flatMap((group) => group.items).map((o) => [o.key, o])),
    [catalog],
  );
  const selected = draft.targets.map(
    (target) => known.get(targetKey(target)) ?? optionOf(target, t),
  );
  const loading = catalogWanted && (screens.isPending || groups.isPending);
  const failed = screens.isError || groups.isError;
  const remove = (target: ScheduleTarget) => {
    edit((current) => ({
      ...current,
      targets: withoutTarget(current.targets, target),
    }));
    // The removed row is gone, so focus returns to the control that adds more.
    setTimeout(() => document.getElementById("schedule-targets-add")?.focus());
  };
  return (
    <EditorSection
      id="schedule-targets"
      title={t("targets.title")}
      description={t("targets.description")}
    >
      <Field data-invalid={problem ? true : undefined}>
        <Combobox
          multiple
          items={catalog}
          value={selected}
          disabled={readOnly}
          filter={(option: TargetOption, query) =>
            option.search.includes(query.trim().toLowerCase())
          }
          isItemEqualToValue={(a: TargetOption, b: TargetOption) =>
            a.key === b.key
          }
          itemToStringLabel={(option: TargetOption) => option.name}
          onOpenChange={(open) => {
            if (open) setCatalogWanted(true);
          }}
          onValueChange={(next: TargetOption[]) =>
            edit((current) => ({
              ...current,
              targets: next.map(({ type, id, name }) => ({ type, id, name })),
            }))
          }
        >
          <div>
            <ComboboxTrigger
              id="schedule-targets-add"
              render={
                <Button
                  type="button"
                  variant="outline"
                  className="w-full justify-between gap-2 sm:w-64"
                  // A combobox takes its name from a label, never from its content.
                  aria-label={t("targets.add")}
                  aria-invalid={problem ? true : undefined}
                  aria-describedby={
                    problem ? "schedule-targets-error" : undefined
                  }
                />
              }
            >
              {t("targets.add")}
            </ComboboxTrigger>
          </div>
          <ComboboxContent className="min-w-80">
            <ComboboxInput
              showTrigger={false}
              placeholder={t("targets.search")}
              aria-label={t("targets.search")}
            />
            {loading ? (
              <p
                role="status"
                className="flex items-center justify-center gap-2 py-4 text-sm text-muted-foreground"
              >
                <Spinner aria-hidden="true" />
                {t("targets.loading")}
              </p>
            ) : failed ? (
              <div className="grid gap-2 p-3">
                <p className="text-sm text-destructive">
                  {t("targets.loadError")}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    void screens.refetch();
                    void groups.refetch();
                  }}
                >
                  {t("targets.retry")}
                </Button>
              </div>
            ) : (
              <>
                <ComboboxEmpty>{t("targets.empty")}</ComboboxEmpty>
                <ComboboxList>
                  {(group: TargetGroup) => (
                    <ComboboxGroup key={group.value} items={group.items}>
                      <ComboboxLabel>{group.label}</ComboboxLabel>
                      <ComboboxCollection>
                        {(option: TargetOption) => (
                          <ComboboxItem key={option.key} value={option}>
                            <span className="grid min-w-0 flex-1 gap-0.5 text-start">
                              <span className="truncate font-medium">
                                {option.name}
                              </span>
                              <span className="truncate text-xs text-muted-foreground">
                                {option.detail}
                              </span>
                            </span>
                          </ComboboxItem>
                        )}
                      </ComboboxCollection>
                    </ComboboxGroup>
                  )}
                </ComboboxList>
                <p className="border-t px-3 py-2 text-xs text-muted-foreground">
                  {t("targets.groupedHint")}
                </p>
              </>
            )}
          </ComboboxContent>
        </Combobox>
        {problem && (
          <FieldError id="schedule-targets-error">{problem}</FieldError>
        )}
      </Field>
      {selected.length > 0 ? (
        <ItemGroup
          className="gap-2"
          aria-label={t("targets.selectedLabel", { count: selected.length })}
        >
          {selected.map((option) => (
            <Item key={option.key} role="listitem" variant="outline" size="sm">
              <ItemMedia variant="icon" aria-hidden="true">
                {option.type === "group" ? <MonitorSpeaker /> : <Monitor />}
              </ItemMedia>
              <ItemContent>
                <ItemTitle>{option.name}</ItemTitle>
                <ItemDescription>{option.detail}</ItemDescription>
              </ItemContent>
              {!readOnly && (
                <ItemActions>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t("targets.remove", { name: option.name })}
                    onClick={() => remove(option)}
                  >
                    <X aria-hidden="true" />
                  </Button>
                </ItemActions>
              )}
            </Item>
          ))}
        </ItemGroup>
      ) : (
        <FieldDescription>{t("targets.none")}</FieldDescription>
      )}
      {selected.some((option) => option.type === "group") && (
        <Alert>
          <AlertDescription>{t("targets.sharedNote")}</AlertDescription>
        </Alert>
      )}
    </EditorSection>
  );
}

function optionOf(target: ScheduleTarget, t: SchedulesT): TargetOption {
  return {
    key: targetKey(target),
    type: target.type,
    id: target.id,
    name: target.name ?? t("targets.unknown"),
    detail:
      target.type === "group"
        ? t("targets.kindGroup")
        : t("targets.kindScreen"),
    search: (target.name ?? "").toLowerCase(),
  };
}

/**
 * Display Groups first, then screens that belong to no group. A grouped
 * screen schedules through its group, as the server normalizes it, so it is
 * found by its own name but offered as the group.
 */
function buildCatalog(
  screens: Screen[] | undefined,
  groups: ScreenGroup[] | undefined,
  t: SchedulesT,
): TargetGroup[] {
  const grouped = new Set(
    (groups ?? []).flatMap((group) => group.screens.map((s) => s.id)),
  );
  const groupOptions: TargetOption[] = (groups ?? []).map((group) => {
    const members = group.screens.map((screen) => screen.name);
    return {
      key: `group:${group.id}`,
      type: "group",
      id: group.id,
      name: group.name,
      detail: t("targets.groupDetail", { count: group.membershipCount }),
      search: [group.name, ...members].join(" ").toLowerCase(),
    };
  });
  const screenOptions: TargetOption[] = (screens ?? [])
    .filter((screen) => !grouped.has(screen.id))
    .map((screen) => ({
      key: `screen:${screen.id}`,
      type: "screen",
      id: screen.id,
      name: screen.name,
      detail: screen.location
        ? t("targets.screenDetail", { location: screen.location })
        : t("targets.kindScreen"),
      search: `${screen.name} ${screen.location}`.toLowerCase(),
    }));
  return [
    { value: "groups", label: t("targets.groups"), items: groupOptions },
    { value: "screens", label: t("targets.screens"), items: screenOptions },
  ].filter((group) => group.items.length > 0) as TargetGroup[];
}
