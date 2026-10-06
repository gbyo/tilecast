import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api/client";
import type { ScreenGroup } from "../../api/types";
import { useAuth } from "../../auth/AuthProvider";
import { Button } from "../../components/ui/button";
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
} from "../../components/ui/combobox";
import { Field, FieldDescription, FieldLabel } from "../../components/ui/field";
import { Separator } from "../../components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { toast } from "../../components/ui/toast";
import { layoutQueries } from "../../data/layouts";
import { playlistQueries } from "../../data/playlists";
import { groupFallback, savedPresentationValue } from "./displayGroupModel";

type PresentationOption = {
  /** `none`, `playlist:<id>`, or `layout:<id>`. */
  value: string;
  label: string;
};
type OptionGroup = {
  value: string;
  label: string | null;
  items: PresentationOption[];
};

const NONE = "none";

/** One page for what a group plays when nothing outranks it, and its gateway. */
export function DisplayGroupPlayback({
  group,
  manageable,
}: {
  group: ScreenGroup;
  manageable: boolean;
}) {
  const { t } = useTranslation(["screens", "common"]);
  const csrf = useAuth().status?.csrfToken ?? "";
  const client = useQueryClient();
  const playlists = useQuery(playlistQueries.list());
  const layouts = useQuery(layoutQueries.list());
  const saved = savedPresentationValue(group);
  const [selected, setSelected] = useState(saved);
  // null while the person is not typing, so the field shows the stored choice.
  const [query, setQuery] = useState<string | null>(null);
  useEffect(() => setSelected(saved), [saved]);

  const noneOption = useMemo<PresentationOption>(
    () => ({ value: NONE, label: t("groups.detail.noFallbackOption") }),
    [t],
  );
  const optionGroups = useMemo<OptionGroup[]>(() => {
    const playlistOptions = (playlists.data?.items ?? []).map((playlist) => ({
      value: `playlist:${playlist.id}`,
      label: playlist.name,
    }));
    const layoutOptions = (layouts.data?.items ?? [])
      .filter((layout) => layout.publishedRevision)
      .map((layout) => ({
        value: `layout:${layout.id}`,
        label: layout.name,
      }));
    return [
      { value: NONE, label: null, items: [noneOption] },
      {
        value: "playlists",
        label: t("groups.detail.playlistsGroup"),
        items: playlistOptions,
      },
      {
        value: "layouts",
        label: t("groups.detail.layoutsGroup"),
        items: layoutOptions,
      },
    ];
  }, [layouts.data, noneOption, playlists.data, t]);
  const allOptions = useMemo(
    () => optionGroups.flatMap((entry) => entry.items),
    [optionGroups],
  );
  const filteredGroups = useMemo(() => {
    const needle = (query ?? "").trim().toLowerCase();
    return optionGroups
      .map((entry) => ({
        ...entry,
        items: needle
          ? entry.items.filter((item) =>
              item.label.toLowerCase().includes(needle),
            )
          : entry.items,
      }))
      .filter((entry) => entry.items.length > 0);
  }, [optionGroups, query]);
  const current = allOptions.find((option) => option.value === selected);

  const refresh = () =>
    client.invalidateQueries({ queryKey: ["screen-groups"] });
  const assign = useMutation({
    mutationFn: (value: string) => {
      const [type, presentationId] = value.split(":");
      if (type === "layout" && presentationId)
        return api.assignSyncGroupLayout(group.id, presentationId, csrf);
      if (type === "playlist" && presentationId)
        return api.assignSyncGroupPlaylist(group.id, presentationId, csrf);
      return api.unassignSyncGroupPlaylist(group.id, csrf);
    },
    onSuccess: () => {
      toast.add({
        title: t("groups.detail.assignmentUpdated"),
        type: "success",
      });
      return refresh();
    },
    onError: () =>
      toast.add({ title: t("groups.errors.assignment"), type: "error" }),
  });
  const gateway = useMutation({
    mutationFn: (next: string | null) =>
      api.updateScreenGroup(
        group.id,
        next
          ? {
              name: group.name,
              description: group.description,
              presentationGatewayScreenId: next,
            }
          : {
              name: group.name,
              description: group.description,
              clearPresentationGateway: true,
            },
        csrf,
      ),
    onSuccess: () => {
      toast.add({ title: t("groups.detail.gatewayUpdated"), type: "success" });
      return refresh();
    },
    onError: () =>
      toast.add({ title: t("groups.errors.update"), type: "error" }),
  });

  const fallback = groupFallback(group);
  const gatewayName = group.presentationGatewayScreenId
    ? (group.screens.find(
        (screen) => screen.id === group.presentationGatewayScreenId,
      )?.name ?? group.presentationGatewayScreenId)
    : t("groups.detail.gatewayAutomatic");

  return (
    <div className="grid max-w-2xl gap-6">
      <section className="grid gap-4">
        <header className="grid gap-1">
          <h2 className="text-base font-semibold">
            {t("groups.detail.syncTitle")}
          </h2>
          <p className="text-sm text-muted-foreground">
            {t("groups.detail.syncDescription")}
          </p>
        </header>
        {manageable ? (
          <>
            <Field>
              <FieldLabel htmlFor="group-fallback">
                {t("groups.detail.fallbackFieldLabel")}
              </FieldLabel>
              <Combobox<PresentationOption>
                items={filteredGroups}
                filteredItems={filteredGroups}
                filter={null}
                value={current ?? noneOption}
                inputValue={query ?? (current ?? noneOption).label}
                onInputValueChange={(value, details) =>
                  setQuery(
                    details.reason === "input-change" ||
                      details.reason === "input-clear"
                      ? value
                      : null,
                  )
                }
                itemToStringLabel={(option) => option.label}
                isItemEqualToValue={(left, right) => left.value === right.value}
                onValueChange={(option) => {
                  setSelected(option?.value ?? NONE);
                  setQuery(null);
                }}
                autoHighlight
              >
                <ComboboxInput
                  id="group-fallback"
                  aria-label={t("groups.detail.fallbackFieldLabel")}
                  placeholder={t("groups.detail.fallbackSearch")}
                  className="w-full"
                />
                <ComboboxContent>
                  <ComboboxEmpty>
                    {t("groups.detail.fallbackNoMatch")}
                  </ComboboxEmpty>
                  <ComboboxList>
                    {(entry: OptionGroup) => (
                      <ComboboxGroup key={entry.value} items={entry.items}>
                        {entry.label && (
                          <ComboboxLabel>{entry.label}</ComboboxLabel>
                        )}
                        <ComboboxCollection>
                          {(option: PresentationOption) => (
                            <ComboboxItem key={option.value} value={option}>
                              {option.label}
                            </ComboboxItem>
                          )}
                        </ComboboxCollection>
                      </ComboboxGroup>
                    )}
                  </ComboboxList>
                </ComboboxContent>
              </Combobox>
              <FieldDescription>
                {t("groups.detail.fallbackHint")}
              </FieldDescription>
            </Field>
            <div>
              <Button
                type="button"
                disabled={assign.isPending || selected === saved}
                onClick={() => assign.mutate(selected)}
              >
                {assign.isPending
                  ? t("common:actions.saving")
                  : t("common:actions.saveChanges")}
              </Button>
            </div>
          </>
        ) : (
          <p className="flex flex-wrap gap-x-2 text-sm">
            {fallback ? (
              <>
                <span className="text-muted-foreground">
                  {t(`groups.fallbackType.${fallback.kind}`)}
                </span>
                <strong>{fallback.name}</strong>
              </>
            ) : (
              <span className="text-muted-foreground">
                {t("groups.noFallback")}
              </span>
            )}
          </p>
        )}
      </section>

      {manageable && group.screens.length > 0 && (
        <>
          <Separator />
          <section className="grid gap-4">
            <header className="grid gap-1">
              <h2 className="text-base font-semibold">
                {t("groups.detail.gatewayTitle")}
              </h2>
              <p className="text-sm text-muted-foreground">
                {t("groups.detail.gatewayDescription")}
              </p>
            </header>
            <Field>
              <FieldLabel htmlFor="group-gateway">
                {t("groups.detail.gatewayLabel")}
              </FieldLabel>
              <Select
                items={[
                  {
                    value: "automatic",
                    label: t("groups.detail.gatewayAutomatic"),
                  },
                  ...group.screens.map((screen) => ({
                    value: screen.id,
                    label: screen.name,
                  })),
                ]}
                value={group.presentationGatewayScreenId || "automatic"}
                onValueChange={(next) =>
                  gateway.mutate(!next || next === "automatic" ? null : next)
                }
                disabled={gateway.isPending}
              >
                <SelectTrigger
                  id="group-gateway"
                  aria-label={t("groups.detail.gatewayLabel")}
                  className="w-full sm:w-72"
                >
                  <SelectValue>{gatewayName}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="automatic">
                    {t("groups.detail.gatewayAutomatic")}
                  </SelectItem>
                  {group.screens.map((screen) => (
                    <SelectItem key={screen.id} value={screen.id}>
                      {screen.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </section>
        </>
      )}
    </div>
  );
}
