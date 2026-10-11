import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { MoreHorizontal } from "lucide-react";
import { api } from "../../api/client";
import type { PlayerRelease, PlayerReleaseList } from "../../api/types";
import { useAuth } from "../../auth/AuthProvider";
import { apiErrorMessage, useFormatLocale } from "../../i18n";
import { formatBytes } from "../../lib/formatBytes";
import { Alert, AlertTitle, AlertDescription } from "../../components/ui/alert";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
} from "../../components/ui/alert-dialog";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "../../components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "../../components/ui/dropdown-menu";
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from "../../components/ui/empty";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card";
import { Progress } from "../../components/ui/progress";
import { Spinner } from "../../components/ui/spinner";
import { toast } from "../../components/ui/toast";
import { UpdateSurface } from "./UpdateSurface";
import {
  artifactIdentity,
  deployable,
  groupReleases,
  purgeAction,
  relativeTime,
  releaseReadiness,
} from "./model";

export function ReleaseLibrary({
  items,
  catalog,
  owner,
  manageable,
  syncError,
  onDeploy,
  onConfigure,
}: {
  items: PlayerRelease[];
  catalog?: PlayerReleaseList;
  owner: boolean;
  manageable: boolean;
  syncError?: unknown;
  onDeploy: (id: string) => void;
  onConfigure: () => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const locale = useFormatLocale();
  const auth = useAuth();
  const client = useQueryClient();
  const [detailIds, setDetailIds] = useState<string[]>();
  const [purging, setPurging] = useState<PlayerRelease>();
  const [showAll, setShowAll] = useState(false);
  const cache = useMutation({
    mutationFn: (id: string) =>
      api.cachePlayerRelease(id, auth.status?.csrfToken ?? ""),
    onSuccess: () => {
      toast.add({
        title: t("updates.console.prepareRequested"),
        type: "success",
      });
      return client.invalidateQueries({ queryKey: ["player-releases"] });
    },
  });
  const purge = useMutation({
    mutationFn: (release: PlayerRelease) =>
      api.deletePlayerRelease(release.id, auth.status?.csrfToken ?? ""),
    onSuccess: (result) => {
      setPurging(undefined);
      toast.add({
        title: result.deleted
          ? t("updates.panel.purgeDeleted")
          : t("updates.panel.purgeFreed"),
        type: "success",
      });
      return client.invalidateQueries({ queryKey: ["player-releases"] });
    },
  });
  const grouped = groupReleases(items);
  const visibleGroups = showAll ? grouped : grouped.slice(0, 5);
  const detailed = items.filter((r) => detailIds?.includes(r.id));
  const github = catalog?.githubAuth;
  function progress(release: PlayerRelease) {
    if (release.cacheStatus !== "downloading") return null;
    const value =
      release.apkSizeBytes > 0
        ? Math.min(
            100,
            Math.round((release.downloadedBytes / release.apkSizeBytes) * 100),
          )
        : 0;
    const label = t("updates.panel.cachingLabel", {
      version: release.versionName,
      downloaded: formatBytes(release.downloadedBytes, locale),
      total: formatBytes(release.apkSizeBytes, locale),
    });
    return (
      <div className="mt-2 grid max-w-md gap-1">
        <Progress value={value} aria-label={label} />
        <p className="text-xs tabular-nums text-muted-foreground">
          {t("updates.panel.downloadProgress", {
            downloaded: formatBytes(release.downloadedBytes, locale),
            total: formatBytes(release.apkSizeBytes, locale),
          })}{" "}
          · {value}%
        </p>
      </div>
    );
  }
  function commands(release: PlayerRelease) {
    const readiness = releaseReadiness(release, t);
    const action = purgeAction(release);
    return (
      <div className="flex shrink-0 flex-wrap items-center gap-1">
        {manageable && (
          <Button
            variant="outline"
            size="sm"
            disabled={!deployable(release)}
            onClick={() => {
              setDetailIds(undefined);
              onDeploy(release.id);
            }}
          >
            {t("updates.console.deployArtifact", {
              architecture:
                release.architecture || artifactIdentity(release, t),
            })}
          </Button>
        )}
        {owner && (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("updates.console.releaseCommands", {
                    version: release.versionName,
                    architecture: release.architecture,
                  })}
                />
              }
            >
              <MoreHorizontal aria-hidden="true" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                disabled={
                  !readiness.cacheable ||
                  cache.isPending ||
                  release.source === "upload"
                }
                onClick={() => cache.mutate(release.id)}
              >
                {t("updates.console.prepareArtifact")}
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!action || purge.isPending}
                variant="destructive"
                onClick={() => {
                  purge.reset();
                  setPurging(release);
                }}
              >
                {action === "delete"
                  ? t("updates.panel.confirmDelete")
                  : t("updates.panel.confirmFree")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    );
  }
  function artifact(release: PlayerRelease, details = false) {
    const readiness = releaseReadiness(release, t);
    return (
      <div
        key={release.id}
        className="grid gap-2 rounded-lg bg-muted/30 px-3 py-3"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="grid gap-1">
            <p className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-mono font-medium">
                {release.architecture || artifactIdentity(release, t)}
              </span>
              <span
                className={
                  readiness.tone === "danger"
                    ? "text-destructive"
                    : "text-muted-foreground"
                }
              >
                {readiness.label}
              </span>
            </p>
            <p className="text-xs text-muted-foreground">
              {formatBytes(release.apkSizeBytes, locale)}
            </p>
          </div>
          {commands(release)}
        </div>
        {readiness.detail && (
          <p
            className={
              readiness.tone === "danger"
                ? "text-sm text-destructive"
                : "text-xs text-muted-foreground"
            }
          >
            {readiness.detail}
          </p>
        )}
        {progress(release)}
        {details && (
          <>
            <p className="text-xs text-muted-foreground">
              {t("updates.console.deploymentUsage", {
                count: release.deploymentCount,
                active: release.activeDeploymentCount,
              })}
            </p>
            <Collapsible>
              <CollapsibleTrigger render={<Button variant="ghost" size="sm" />}>
                {t("updates.console.technicalDetails")}
              </CollapsibleTrigger>
              <CollapsibleContent>
                <dl className="grid gap-3 py-3 text-xs">
                  {[
                    [
                      t("updates.console.versionCode"),
                      String(release.versionCode),
                    ],
                    [t("updates.console.sha256"), release.apkSha256],
                    [t("updates.console.signature"), release.manifestSignature],
                    [
                      t("updates.console.verification"),
                      release.verificationStatus === "verified"
                        ? t("updates.console.fullyVerified")
                        : release.verificationStatus === "verified_manifest"
                          ? t("updates.console.manifestVerified")
                          : t("updates.panel.readinessVerificationFailed"),
                    ],
                    [
                      t("updates.console.artifact"),
                      release.playerFamily === "edge"
                        ? `tilecast-edge-${release.versionName}-${release.architecture}.tar.zst`
                        : release.playerFamily === "windows"
                          ? `tilecast-windows-${release.versionName}-${release.architecture}.msix`
                          : release.playerFamily === "electron-linux"
                            ? "tilecast-player.AppImage"
                            : "tilecast-player.apk",
                    ],
                    ...(release.signingCertificateSha256
                      ? [
                          [
                            t("updates.console.certificate"),
                            release.signingCertificateSha256,
                          ],
                        ]
                      : []),
                  ].map(([label, value]) => (
                    <div key={label}>
                      <dt className="text-muted-foreground">{label}</dt>
                      <dd className="break-all font-mono">{value}</dd>
                    </div>
                  ))}
                </dl>
              </CollapsibleContent>
            </Collapsible>
          </>
        )}
      </div>
    );
  }
  return (
    <div className="grid gap-5">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">
            {t("updates.console.releaseLibrary")}
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("updates.panel.sourceGitHub")} ·{" "}
            {github?.connected
              ? github.login
                ? t("updates.panel.authorizedAs", { login: github.login })
                : t("updates.panel.authorizedToken")
              : t("updates.panel.anonymous")}
            {catalog?.lastCheckedAt &&
              ` · ${t("updates.console.checked", { time: relativeTime(catalog.lastCheckedAt, t) })}`}
          </p>
        </div>
        {owner && (
          <Button variant="ghost" size="sm" onClick={onConfigure}>
            {t("updates.console.configureSource")}
          </Button>
        )}
      </header>
      {(syncError || catalog?.providerError) && (
        <Alert variant="destructive">
          <AlertTitle>{t("updates.panel.syncErrorTitle")}</AlertTitle>
          <AlertDescription>
            {syncError ? apiErrorMessage(syncError) : catalog?.providerError}
          </AlertDescription>
        </Alert>
      )}
      {catalog && !catalog.manifestKeyConfigured && (
        <Alert variant="destructive">
          <AlertTitle>{t("updates.panel.verificationTitle")}</AlertTitle>
          <AlertDescription>
            {t("updates.console.trustedKeyMissing")}
          </AlertDescription>
        </Alert>
      )}
      {cache.error && (
        <Alert variant="destructive">
          <AlertDescription>{apiErrorMessage(cache.error)}</AlertDescription>
        </Alert>
      )}
      {grouped.length ? (
        <div className="grid gap-4">
          {visibleGroups.map((variants) => {
            const release = variants[0]!;
            return (
              <Card key={release.id} size="sm">
                <CardHeader>
                  <CardTitle className="flex flex-wrap items-center gap-2">
                    <Button
                      variant="link"
                      className="h-auto p-0 text-base font-semibold"
                      onClick={() => setDetailIds(variants.map((r) => r.id))}
                    >
                      {release.versionName}
                    </Button>
                  </CardTitle>
                  <CardDescription>
                    {artifactIdentity({ ...release, architecture: "" }, t)} ·{" "}
                    {release.source === "upload"
                      ? t("updates.panel.sourceUpload")
                      : t("updates.panel.sourceGitHub")}{" "}
                    · {new Date(release.publishedAt).toLocaleDateString(locale)}
                  </CardDescription>
                  <CardAction>
                    <Badge variant="outline">
                      {release.channel === "beta"
                        ? t("updates.panel.channelBeta")
                        : t("updates.panel.channelStable")}
                    </Badge>
                  </CardAction>
                </CardHeader>
                <CardContent className="gap-2">
                  {variants.map((r) => artifact(r))}
                </CardContent>
              </Card>
            );
          })}
        <>
          </div>
          {grouped.length > 5 && (
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
              <span>
                {t("updates.panel.showing", {
                  shown: visibleGroups.length,
                  total: grouped.length,
                })}
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowAll((value) => !value)}
              >
                {showAll
                  ? t("updates.panel.showFewer")
                  : t("updates.panel.showAll", { total: grouped.length })}
              </Button>
            </div>
          )}
        </>
      ) : (
        <Empty className="gap-2 py-8">
          <EmptyHeader>
            <EmptyTitle className="text-sm">
              {t("updates.console.noReleases")}
            </EmptyTitle>
            <EmptyDescription>
              {t("updates.console.noReleasesHint")}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
      {detailed.length > 0 && (
        <UpdateSurface
          open
          onOpenChange={(open) => !open && setDetailIds(undefined)}
          title={detailed[0]!.versionName}
          description={artifactIdentity(
            { ...detailed[0]!, architecture: "" },
            t,
          )}
        >
          <div className="flex flex-wrap gap-2 text-sm">
            <Badge variant="outline">
              {detailed[0]!.channel === "beta"
                ? t("updates.panel.channelBeta")
                : t("updates.panel.channelStable")}
            </Badge>
            <span>
              {detailed[0]!.source === "github"
                ? t("updates.panel.sourceGitHub")
                : t("updates.panel.sourceUpload")}
            </span>
            <time dateTime={detailed[0]!.publishedAt}>
              {new Date(detailed[0]!.publishedAt).toLocaleString(locale)}
            </time>
          </div>
          {detailed.map((r) => artifact(r, true))}
          <section>
            <h3 className="mb-2 text-sm font-semibold">
              {t("updates.console.releaseNotes")}
            </h3>
            <p className="whitespace-pre-wrap text-sm text-muted-foreground">
              {detailed[0]!.releaseNotes || t("updates.console.noNotes")}
            </p>
          </section>
        </UpdateSurface>
      )}
      <AlertDialog
        open={!!purging}
        onOpenChange={(open) => !open && setPurging(undefined)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {purging && purgeAction(purging) === "delete"
                ? t("updates.panel.purgeDeleteHeading")
                : t("updates.panel.purgeFreeHeading")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {purging && (
                <>
                  {purgeAction(purging) === "delete"
                    ? t("updates.panel.neverDeployed")
                    : t("updates.panel.purgeFreeTitle")}{" "}
                  {purging.source === "upload" && t("updates.panel.directHint")}
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {purge.error && (
            <Alert variant="destructive">
              <AlertDescription>
                {apiErrorMessage(purge.error)}
              </AlertDescription>
            </Alert>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={purge.isPending}>
              {t("common:actions.cancel")}
            </AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={purge.isPending}
              onClick={() => purging && purge.mutate(purging)}
            >
              {purge.isPending && <Spinner />}
              {purging && purgeAction(purging) === "delete"
                ? t("updates.panel.confirmDelete")
                : t("updates.panel.confirmFree")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
