import { useTranslation } from "react-i18next";
import { MoreHorizontal } from "lucide-react";
import type { PlayerRelease, PlayerReleaseList } from "../../api/types";
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
  ItemGroup,
  Item,
  ItemContent,
  ItemTitle,
  ItemDescription,
} from "../../components/ui/item";
import { Progress } from "../../components/ui/progress";
import { Spinner } from "../../components/ui/spinner";
import { UpdateSurface } from "./UpdateSurface";
import {
  artifactIdentity,
  deployable,
  purgeAction,
  relativeTime,
  releaseReadiness,
} from "./model";

export function ReleaseLibraryHeader({
  catalog,
  owner,
  onConfigure,
}: {
  catalog?: PlayerReleaseList;
  owner: boolean;
  onConfigure: () => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const github = catalog?.githubAuth;
  return (
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
            ` · ${t("updates.console.checked", {
              time: relativeTime(catalog.lastCheckedAt, t),
            })}`}
        </p>
      </div>
      {owner && (
        <Button variant="ghost" size="sm" onClick={onConfigure}>
          {t("updates.console.configureSource")}
        </Button>
      )}
    </header>
  );
}

export function ReleaseLibraryAlerts({
  catalog,
  syncError,
  cacheError,
}: {
  catalog?: PlayerReleaseList;
  syncError?: unknown;
  cacheError?: unknown;
}) {
  const { t } = useTranslation(["settings", "common"]);
  return (
    <>
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
      {cacheError && (
        <Alert variant="destructive">
          <AlertDescription>{apiErrorMessage(cacheError)}</AlertDescription>
        </Alert>
      )}
    </>
  );
}

export function ReleaseGroupList({
  groups,
  owner,
  manageable,
  cachePending,
  purgePending,
  onOpenDetails,
  onDeploy,
  onCache,
  onRequestPurge,
}: {
  groups: PlayerRelease[][];
  owner: boolean;
  manageable: boolean;
  cachePending: boolean;
  purgePending: boolean;
  onOpenDetails: (ids: string[]) => void;
  onDeploy: (id: string) => void;
  onCache: (id: string) => void;
  onRequestPurge: (release: PlayerRelease) => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const locale = useFormatLocale();
  if (!groups.length) {
    return (
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
    );
  }
  return (
    <ItemGroup render={<ul />} className="gap-0 divide-y">
      {groups.map((variants) => {
        const release = variants[0]!;
        return (
          <Item key={release.id} render={<li />} className="rounded-none px-0">
            <ItemContent>
              <ItemTitle className="flex-wrap [display:flex] [-webkit-line-clamp:unset]">
                <Button
                  variant="link"
                  className="h-auto p-0 font-semibold"
                  onClick={() => onOpenDetails(variants.map((item) => item.id))}
                >
                  {release.versionName}
                </Button>
                <Badge variant="outline">
                  {release.channel === "beta"
                    ? t("updates.panel.channelBeta")
                    : t("updates.panel.channelStable")}
                </Badge>
              </ItemTitle>
              <ItemDescription className="line-clamp-none text-xs">
                {artifactIdentity({ ...release, architecture: "" }, t)} ·{" "}
                {release.source === "upload"
                  ? t("updates.panel.sourceUpload")
                  : t("updates.panel.sourceGitHub")}{" "}
                · {new Date(release.publishedAt).toLocaleDateString(locale)}
              </ItemDescription>
              {variants.map((item) => (
                <ReleaseArtifact
                  key={item.id}
                  release={item}
                  owner={owner}
                  manageable={manageable}
                  cachePending={cachePending}
                  purgePending={purgePending}
                  onDeploy={onDeploy}
                  onCache={onCache}
                  onRequestPurge={onRequestPurge}
                />
              ))}
            </ItemContent>
          </Item>
        );
      })}
    </ItemGroup>
  );
}

function ReleaseArtifact({
  release,
  owner,
  manageable,
  cachePending,
  purgePending,
  details = false,
  onDeploy,
  onCache,
  onRequestPurge,
}: {
  release: PlayerRelease;
  owner: boolean;
  manageable: boolean;
  cachePending: boolean;
  purgePending: boolean;
  details?: boolean;
  onDeploy: (id: string) => void;
  onCache: (id: string) => void;
  onRequestPurge: (release: PlayerRelease) => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const locale = useFormatLocale();
  const readiness = releaseReadiness(release, t);
  return (
    <div className="grid gap-1 py-2">
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
        <ReleaseCommands
          release={release}
          owner={owner}
          manageable={manageable}
          cachePending={cachePending}
          purgePending={purgePending}
          onDeploy={onDeploy}
          onCache={onCache}
          onRequestPurge={onRequestPurge}
        />
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
      <ReleaseProgress release={release} />
      {details && <ReleaseTechnicalDetails release={release} />}
    </div>
  );
}

function ReleaseCommands({
  release,
  owner,
  manageable,
  cachePending,
  purgePending,
  onDeploy,
  onCache,
  onRequestPurge,
}: {
  release: PlayerRelease;
  owner: boolean;
  manageable: boolean;
  cachePending: boolean;
  purgePending: boolean;
  onDeploy: (id: string) => void;
  onCache: (id: string) => void;
  onRequestPurge: (release: PlayerRelease) => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const readiness = releaseReadiness(release, t);
  const action = purgeAction(release);
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1">
      {manageable && (
        <Button
          variant="outline"
          size="sm"
          disabled={!deployable(release)}
          onClick={() => onDeploy(release.id)}
        >
          {t("updates.console.deployArtifact", {
            architecture: release.architecture || artifactIdentity(release, t),
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
                cachePending ||
                release.source === "upload"
              }
              onClick={() => onCache(release.id)}
            >
              {t("updates.console.prepareArtifact")}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!action || purgePending}
              variant="destructive"
              onClick={() => onRequestPurge(release)}
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

function ReleaseProgress({ release }: { release: PlayerRelease }) {
  const { t } = useTranslation(["settings", "common"]);
  const locale = useFormatLocale();
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

function ReleaseTechnicalDetails({ release }: { release: PlayerRelease }) {
  const { t } = useTranslation(["settings", "common"]);
  const artifactName =
    release.playerFamily === "edge"
      ? `tilecast-edge-${release.versionName}-${release.architecture}.tar.zst`
      : release.playerFamily === "windows"
        ? `tilecast-windows-${release.versionName}-${release.architecture}.msix`
        : release.playerFamily === "electron-linux"
          ? "tilecast-player.AppImage"
          : "tilecast-player.apk";
  const verification =
    release.verificationStatus === "verified"
      ? t("updates.console.fullyVerified")
      : release.verificationStatus === "verified_manifest"
        ? t("updates.console.manifestVerified")
        : t("updates.panel.readinessVerificationFailed");
  const rows = [
    [t("updates.console.versionCode"), String(release.versionCode)],
    [t("updates.console.sha256"), release.apkSha256],
    [t("updates.console.signature"), release.manifestSignature],
    [t("updates.console.verification"), verification],
    [t("updates.console.artifact"), artifactName],
    ...(release.signingCertificateSha256
      ? [[t("updates.console.certificate"), release.signingCertificateSha256]]
      : []),
  ];
  return (
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
            {rows.map(([label, value]) => (
              <div key={label}>
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="break-all font-mono">{value}</dd>
              </div>
            ))}
          </dl>
        </CollapsibleContent>
      </Collapsible>
    </>
  );
}

export function ReleaseDetailSurface({
  releases,
  owner,
  manageable,
  cachePending,
  purgePending,
  onClose,
  onDeploy,
  onCache,
  onRequestPurge,
}: {
  releases: PlayerRelease[];
  owner: boolean;
  manageable: boolean;
  cachePending: boolean;
  purgePending: boolean;
  onClose: () => void;
  onDeploy: (id: string) => void;
  onCache: (id: string) => void;
  onRequestPurge: (release: PlayerRelease) => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const locale = useFormatLocale();
  const release = releases[0];
  if (!release) return null;
  return (
    <UpdateSurface
      open
      onOpenChange={(open) => !open && onClose()}
      title={release.versionName}
      description={artifactIdentity({ ...release, architecture: "" }, t)}
    >
      <div className="flex flex-wrap gap-2 text-sm">
        <Badge variant="outline">
          {release.channel === "beta"
            ? t("updates.panel.channelBeta")
            : t("updates.panel.channelStable")}
        </Badge>
        <span>
          {release.source === "github"
            ? t("updates.panel.sourceGitHub")
            : t("updates.panel.sourceUpload")}
        </span>
        <time dateTime={release.publishedAt}>
          {new Date(release.publishedAt).toLocaleString(locale)}
        </time>
      </div>
      {releases.map((item) => (
        <ReleaseArtifact
          key={item.id}
          release={item}
          owner={owner}
          manageable={manageable}
          cachePending={cachePending}
          purgePending={purgePending}
          details
          onDeploy={onDeploy}
          onCache={onCache}
          onRequestPurge={onRequestPurge}
        />
      ))}
      <section>
        <h3 className="mb-2 text-sm font-semibold">
          {t("updates.console.releaseNotes")}
        </h3>
        <p className="whitespace-pre-wrap text-sm text-muted-foreground">
          {release.releaseNotes || t("updates.console.noNotes")}
        </p>
      </section>
    </UpdateSurface>
  );
}

export function PurgeReleaseDialog({
  release,
  pending,
  error,
  onClose,
  onConfirm,
}: {
  release?: PlayerRelease;
  pending: boolean;
  error?: unknown;
  onClose: () => void;
  onConfirm: (release: PlayerRelease) => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const action = release ? purgeAction(release) : undefined;
  return (
    <AlertDialog open={!!release} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {action === "delete"
              ? t("updates.panel.purgeDeleteHeading")
              : t("updates.panel.purgeFreeHeading")}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {release && (
              <>
                {action === "delete"
                  ? t("updates.panel.neverDeployed")
                  : t("updates.panel.purgeFreeTitle")}{" "}
                {release.source === "upload" && t("updates.panel.directHint")}
              </>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{apiErrorMessage(error)}</AlertDescription>
          </Alert>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>
            {t("common:actions.cancel")}
          </AlertDialogCancel>
          <Button
            variant="destructive"
            disabled={pending || !release}
            onClick={() => release && onConfirm(release)}
          >
            {pending && <Spinner />}
            {action === "delete"
              ? t("updates.panel.confirmDelete")
              : t("updates.panel.confirmFree")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
