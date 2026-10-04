import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import { apiErrorMessage } from "../i18n";
import type { ScreenScope } from "../api/types";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import { Input } from "../components/ui/input";
import {
  Field,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "../components/ui/field";
import { RadioGroup, RadioGroupItem } from "../components/ui/radio-group";
import { Skeleton } from "../components/ui/skeleton";

// Screen access is an explicit choice, never an absence of checkboxes: the
// server treats no grants as full fleet access, so a failed load must never
// render as, or save as, an empty grant list.
export function ScreenScopeEditor({
  userId,
  userRole,
  csrf,
  disabled,
}: {
  userId: string;
  userRole: string;
  csrf: string;
  disabled?: boolean;
}) {
  const { t } = useTranslation(["screens", "common"]);
  const scopes = useQuery({
    queryKey: ["screen-scopes", userId],
    queryFn: () => api.userScreenScopes(userId),
    enabled: userRole !== "owner",
  });
  const locations = useQuery({
    queryKey: ["locations"],
    queryFn: api.locations,
    enabled: userRole !== "owner",
  });
  const groups = useQuery({
    queryKey: ["screen-groups"],
    queryFn: () => api.screenGroups(),
    enabled: userRole !== "owner",
  });

  const [mode, setMode] = useState<"full" | "limited">("full");
  const [selected, setSelected] = useState<ScreenScope[]>([]);
  const [saved, setSaved] = useState(false);
  const [search, setSearch] = useState("");
  const normalizedSearch = search.trim().toLowerCase();
  const allLocations = locations.data?.items ?? [];
  const allGroups = groups.data?.items ?? [];
  const showSearch = allLocations.length + allGroups.length > 8;
  const visibleLocations = normalizedSearch
    ? allLocations.filter((location) =>
        location.name.toLowerCase().includes(normalizedSearch),
      )
    : allLocations;
  const visibleGroups = normalizedSearch
    ? allGroups.filter((group) =>
        group.name.toLowerCase().includes(normalizedSearch),
      )
    : allGroups;
  useEffect(() => {
    // A response without the array must not take the dialog down with it: this
    // editor is embedded in the account editor, which has its own work to do.
    if (scopes.data) {
      const next = scopes.data.scopes ?? [];
      setSelected(next);
      setMode(next.length > 0 ? "limited" : "full");
    }
  }, [scopes.data]);

  const save = useMutation({
    mutationFn: () =>
      api.putUserScreenScopes(userId, mode === "full" ? [] : selected, csrf),
    onSuccess: () => {
      setSaved(true);
      void scopes.refetch();
    },
  });

  if (userRole === "owner")
    return (
      <p className="text-sm text-muted-foreground">{t("scope.ownerNote")}</p>
    );

  const loadError = scopes.error ?? locations.error ?? groups.error;
  const loaded = scopes.isSuccess && locations.isSuccess && groups.isSuccess;
  const limitedEmpty = mode === "limited" && selected.length === 0;
  const retryAll = () => {
    void scopes.refetch();
    void locations.refetch();
    void groups.refetch();
  };

  const toggle = (scope: ScreenScope, on: boolean) => {
    setSaved(false);
    setSelected((current) =>
      on
        ? [...current, scope]
        : current.filter(
            (item) => !(item.type === scope.type && item.id === scope.id),
          ),
    );
  };
  const has = (type: string, id: string) =>
    selected.some((item) => item.type === type && item.id === id);

  return (
    <div className="grid gap-4">
      {!loaded && !loadError ? (
        <div
          className="grid gap-2"
          role="status"
          aria-label={t("scope.loading")}
        >
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : loadError ? (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
            <span>
              {t("scope.loadError")} {apiErrorMessage(loadError)}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={
                scopes.isFetching || locations.isFetching || groups.isFetching
              }
              onClick={retryAll}
            >
              {t("common:actions.retry")}
            </Button>
          </AlertDescription>
        </Alert>
      ) : (
        <>
          <FieldSet>
            <FieldLegend>{t("scope.modeLegend")}</FieldLegend>
            <RadioGroup
              value={mode}
              onValueChange={(value) => {
                setSaved(false);
                setMode(value as "full" | "limited");
              }}
              className="grid gap-3"
            >
              <Field orientation="horizontal" className="items-start gap-3">
                <RadioGroupItem
                  value="full"
                  id="screen-scope-mode-full"
                  disabled={disabled}
                />
                <div className="grid gap-1">
                  <FieldLabel htmlFor="screen-scope-mode-full">
                    {t("scope.modeFull")}
                  </FieldLabel>
                  <p className="text-sm text-muted-foreground">
                    {t("scope.modeFullHint")}
                  </p>
                </div>
              </Field>
              <Field orientation="horizontal" className="items-start gap-3">
                <RadioGroupItem
                  value="limited"
                  id="screen-scope-mode-limited"
                  disabled={disabled}
                />
                <div className="grid gap-1">
                  <FieldLabel htmlFor="screen-scope-mode-limited">
                    {t("scope.modeLimited")}
                  </FieldLabel>
                  <p className="text-sm text-muted-foreground">
                    {t("scope.limited", { count: selected.length })}
                  </p>
                </div>
              </Field>
            </RadioGroup>
          </FieldSet>

          {mode === "limited" && (
            <>
              <p className="text-sm text-muted-foreground">
                {t("scope.combineNote")}
              </p>
              {showSearch && (
                <Field>
                  <FieldLabel htmlFor="screen-scope-search">
                    {t("scope.searchLabel")}
                  </FieldLabel>
                  <Input
                    id="screen-scope-search"
                    type="search"
                    value={search}
                    placeholder={t("scope.searchPlaceholder")}
                    onChange={(event) => setSearch(event.target.value)}
                  />
                </Field>
              )}
              <FieldSet className="grid gap-2">
                <FieldLegend variant="label">
                  {t("scope.locations")}
                </FieldLegend>
                {!visibleLocations.length ? (
                  <p className="text-sm text-muted-foreground">
                    {normalizedSearch
                      ? t("scope.noMatch")
                      : t("scope.noLocations")}
                  </p>
                ) : (
                  visibleLocations.map((location) => {
                    const id = `screen-scope-location-${location.id}`;
                    return (
                      <Field
                        key={location.id}
                        data-disabled={disabled}
                        orientation="horizontal"
                        className="items-center"
                      >
                        <Checkbox
                          id={id}
                          disabled={disabled}
                          checked={has("location", location.id)}
                          onCheckedChange={(checked) =>
                            toggle(
                              { type: "location", id: location.id },
                              checked === true,
                            )
                          }
                        />
                        <FieldLabel htmlFor={id}>{location.name}</FieldLabel>
                      </Field>
                    );
                  })
                )}
              </FieldSet>

              <FieldSet className="grid gap-2">
                <FieldLegend variant="label">{t("scope.groups")}</FieldLegend>
                {!visibleGroups.length ? (
                  <p className="text-sm text-muted-foreground">
                    {normalizedSearch
                      ? t("scope.noMatch")
                      : t("scope.noGroups")}
                  </p>
                ) : (
                  visibleGroups.map((group) => {
                    const id = `screen-scope-group-${group.id}`;
                    return (
                      <Field
                        key={group.id}
                        data-disabled={disabled}
                        orientation="horizontal"
                        className="items-center"
                      >
                        <Checkbox
                          id={id}
                          disabled={disabled}
                          checked={has("group", group.id)}
                          onCheckedChange={(checked) =>
                            toggle(
                              { type: "group", id: group.id },
                              checked === true,
                            )
                          }
                        />
                        <FieldLabel htmlFor={id}>{group.name}</FieldLabel>
                      </Field>
                    );
                  })
                )}
              </FieldSet>
              {limitedEmpty && (
                <p className="text-sm text-muted-foreground" role="note">
                  {t("scope.limitedEmpty")}
                </p>
              )}
            </>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>{saved && <span>{t("scope.saved")}</span>}</div>
            <Button
              type="button"
              disabled={disabled || save.isPending || limitedEmpty}
              onClick={() => save.mutate()}
            >
              {save.isPending
                ? t("common:actions.saving")
                : t("scope.saveAction")}
            </Button>
          </div>
          {save.error && (
            <Alert variant="destructive">
              <AlertDescription>{apiErrorMessage(save.error)}</AlertDescription>
            </Alert>
          )}
        </>
      )}
    </div>
  );
}
