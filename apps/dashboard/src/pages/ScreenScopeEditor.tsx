import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import { apiErrorMessage } from "../i18n";
import type { MyAccess } from "../api/types";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { Skeleton } from "../components/ui/skeleton";
import {
  ScreenAccessFields,
  type ScreenAccessDraft,
} from "../settings/access/ScreenAccessFields";

type Place = { id: string; name: string };

/**
 * The places the signed-in account may grant. Restricted access can hand on
 * only the locations and Display Groups granted to it directly; the server
 * enforces the same rule.
 */
export function delegablePlaces(
  access: MyAccess | undefined,
  locations: readonly Place[],
  groups: readonly Place[],
) {
  if (!access || access.screens.mode === "all") {
    return { locations, groups, allowAll: true };
  }
  const ownLocations = new Set(access.screens.locationIds);
  const ownGroups = new Set(access.screens.groupIds);
  return {
    locations: locations.filter((place) => ownLocations.has(place.id)),
    groups: groups.filter((place) => ownGroups.has(place.id)),
    allowAll: false,
  };
}

// Screen access is an explicit choice read from the stored mode, never
// inferred from how many grants exist. A failed load must never render as,
// or save as, a policy.
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
  const enabled = userRole !== "owner";
  const scopes = useQuery({
    queryKey: ["screen-scopes", userId],
    queryFn: () => api.userScreenScopes(userId),
    enabled,
  });
  const locations = useQuery({
    queryKey: ["locations"],
    queryFn: api.locations,
    enabled,
  });
  const groups = useQuery({
    queryKey: ["screen-groups"],
    queryFn: () => api.screenGroups(),
    enabled,
  });
  const myAccess = useQuery({
    queryKey: ["my-access"],
    queryFn: api.myAccess,
    enabled,
  });

  const [draft, setDraft] = useState<ScreenAccessDraft>();
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    // A response without the array must not take the dialog down with it:
    // this editor is embedded in the account editor.
    if (scopes.data) {
      setDraft({
        mode: scopes.data.mode === "all" ? "all" : "restricted",
        scopes: scopes.data.scopes ?? [],
      });
    }
  }, [scopes.data]);

  const save = useMutation({
    mutationFn: (value: ScreenAccessDraft) =>
      api.putUserScreenScopes(
        userId,
        { mode: value.mode, scopes: value.mode === "all" ? [] : value.scopes },
        csrf,
      ),
    onSuccess: () => {
      setSaved(true);
      void scopes.refetch();
    },
  });

  if (!enabled)
    return (
      <p className="text-sm text-muted-foreground">{t("scope.ownerNote")}</p>
    );

  const loadError =
    scopes.error ?? locations.error ?? groups.error ?? myAccess.error;
  const retryAll = () => {
    void scopes.refetch();
    void locations.refetch();
    void groups.refetch();
    void myAccess.refetch();
  };
  const offered = delegablePlaces(
    myAccess.data,
    locations.data?.items ?? [],
    groups.data?.items ?? [],
  );
  const ready =
    scopes.isSuccess &&
    locations.isSuccess &&
    groups.isSuccess &&
    myAccess.isSuccess;

  return (
    <div className="grid gap-4">
      {loadError ? (
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
                scopes.isFetching ||
                locations.isFetching ||
                groups.isFetching ||
                myAccess.isFetching
              }
              onClick={retryAll}
            >
              {t("common:actions.retry")}
            </Button>
          </AlertDescription>
        </Alert>
      ) : !ready || !draft ? (
        <div
          className="grid gap-2"
          role="status"
          aria-label={t("scope.loading")}
        >
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : (
        <>
          {scopes.data.configured === false && (
            <p className="text-sm text-muted-foreground" role="note">
              {t("scope.unconfigured")}
            </p>
          )}
          <ScreenAccessFields
            value={draft}
            onChange={(next) => {
              setSaved(false);
              setDraft(next);
            }}
            locations={offered.locations}
            groups={offered.groups}
            allowAll={offered.allowAll}
            idPrefix="screen-scope"
            disabled={disabled}
          />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>{saved && <span>{t("scope.saved")}</span>}</div>
            <Button
              type="button"
              disabled={disabled || save.isPending}
              onClick={() => save.mutate(draft)}
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
