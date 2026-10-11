import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../../api/client";
import type {
  PlayerRelease,
  Screen,
  ScreenGroup,
  UpdateDeploymentMode,
} from "../../api/types";
import { useAuth } from "../../auth/AuthProvider";
import { apiErrorMessage, useFormatLocale } from "../../i18n";
import { formatBytes } from "../../lib/formatBytes";
import {
  releaseUpdateTab,
  screenUpdateTab,
  type UpdateFamilyTab,
} from "../../playerPlatform";
import { DateTimeInput } from "../../components/date-picker";
import { Alert, AlertTitle, AlertDescription } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../../components/ui/collapsible";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../../components/ui/card";
import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
  ComboboxValue,
  useComboboxAnchor,
} from "../../components/ui/combobox";
import {
  Field,
  FieldSet,
  FieldLegend,
  FieldGroup,
  FieldLabel,
  FieldDescription,
  FieldContent,
  FieldError,
} from "../../components/ui/field";
import { Input } from "../../components/ui/input";
import { Progress } from "../../components/ui/progress";
import { RadioGroup, RadioGroupItem } from "../../components/ui/radio-group";
import { Switch } from "../../components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { Spinner } from "../../components/ui/spinner";
import { toast } from "../../components/ui/toast";
import { UpdateSurface } from "./UpdateSurface";
import {
  architectureLabel,
  artifactIdentity,
  deployable,
  families,
  familyLabel,
  groupReleases,
  modeLabel,
  releaseReadiness,
} from "./model";

type TargetChoice = { value: string; label: string; type: "screen" | "group" };

function releaseGroupKey(releases: PlayerRelease[]) {
  return releases
    .map((release) => release.id)
    .sort()
    .join(":");
}

function UpdateSelectionStep({
  family,
  releaseGroups,
  releaseGroupId,
  releaseGroup,
  releaseId,
  release,
  familyScreens,
  selectedBuildScreenCount,
  selectedBuildPreparing,
  prepareError,
  onFamilyChange,
  onVersionChange,
  onBuildChange,
}: {
  family: UpdateFamilyTab;
  releaseGroups: PlayerRelease[][];
  releaseGroupId: string;
  releaseGroup?: PlayerRelease[];
  releaseId: string;
  release?: PlayerRelease;
  familyScreens: Screen[];
  selectedBuildScreenCount: number;
  selectedBuildPreparing: boolean;
  prepareError: unknown;
  onFamilyChange: (family: UpdateFamilyTab) => void;
  onVersionChange: (key: string) => void;
  onBuildChange: (id: string) => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const locale = useFormatLocale();
  const readiness = release ? releaseReadiness(release, t) : undefined;
  return (
    <div className="grid gap-6">
      <Field>
        <FieldLabel htmlFor="update-player-family">
          {t("updates.console.playerFamily")}
        </FieldLabel>
        <Select
          items={families.map((value) => ({
            value,
            label: familyLabel(value, t),
          }))}
          value={family}
          onValueChange={(value) =>
            value && onFamilyChange(value as UpdateFamilyTab)
          }
        >
          <SelectTrigger id="update-player-family">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {families.map((value) => (
              <SelectItem key={value} value={value}>
                {familyLabel(value, t)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field>
        <FieldLabel htmlFor="update-version">
          {t("updates.console.versionLabel")}
        </FieldLabel>
        {releaseGroups.length ? (
          <>
            <Select
              items={releaseGroups.map((variants) => {
                const representative = variants[0]!;
                return {
                  value: releaseGroupKey(variants),
                  label: `${representative.versionName} · ${
                    representative.channel === "beta"
                      ? t("updates.panel.channelBeta")
                      : t("updates.panel.channelStable")
                  }`,
                };
              })}
              value={releaseGroupId}
              onValueChange={(value) => value && onVersionChange(String(value))}
            >
              <SelectTrigger id="update-version">
                <SelectValue
                  placeholder={t("updates.console.chooseVersion")}
                />
              </SelectTrigger>
              <SelectContent>
                {releaseGroups.map((variants) => {
                  const representative = variants[0]!;
                  const key = releaseGroupKey(variants);
                  return (
                    <SelectItem key={key} value={key}>
                      {representative.versionName} ·{" "}
                      {representative.channel === "beta"
                        ? t("updates.panel.channelBeta")
                        : t("updates.panel.channelStable")}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
            {releaseGroup && (
              <FieldDescription>
                {new Date(releaseGroup[0]!.publishedAt).toLocaleDateString(
                  locale,
                )}
                {" · "}
                {releaseGroup[0]!.source === "github"
                  ? t("updates.panel.sourceGitHub")
                  : t("updates.panel.sourceUpload")}
              </FieldDescription>
            )}
          </>
        ) : (
          <Alert>
            <AlertDescription>
              {t("updates.console.noReleasesForFamily", {
                family: familyLabel(family, t),
              })}
            </AlertDescription>
          </Alert>
        )}
      </Field>

      {releaseGroup?.length === 1 && release && (
        <Card size="sm">
          <CardContent className="grid gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="grid gap-0.5">
                <span className="text-sm font-medium">
                  {architectureLabel(release.architecture, t)}
                </span>
                <span className="text-xs text-muted-foreground">
                  {release.architecture && (
                    <>
                      <span className="font-mono">{release.architecture}</span>
                      {" · "}
                    </>
                  )}
                  {t("updates.console.buildScreenCount", {
                    count: selectedBuildScreenCount,
                  })}
                  {" · "}
                  {formatBytes(release.apkSizeBytes, locale)}
                </span>
              </div>
              <Badge variant={deployable(release) ? "outline" : "secondary"}>
                {deployable(release)
                  ? t("updates.console.buildReady")
                  : selectedBuildPreparing
                    ? t("updates.console.preparingBuild")
                    : t("updates.console.buildPrepareNeeded")}
              </Badge>
            </div>
            {readiness?.detail && (
              <p
                className={
                  readiness.tone === "danger"
                    ? "text-xs text-destructive"
                    : "text-xs text-muted-foreground"
                }
              >
                {readiness.detail}
              </p>
            )}
            {selectedBuildPreparing && (
              <div className="grid gap-1">
                <Progress
                  value={
                    release.apkSizeBytes > 0
                      ? Math.min(
                          100,
                          Math.round(
                            (release.downloadedBytes / release.apkSizeBytes) *
                              100,
                          ),
                        )
                      : 0
                  }
                  aria-label={t("updates.console.preparingBuild")}
                />
                <p className="text-xs text-muted-foreground">
                  {t("updates.console.preparationContinuesHint")}
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {releaseGroup && releaseGroup.length > 1 && (
        <FieldSet>
          <FieldLegend>{t("updates.console.buildLabel")}</FieldLegend>
          <FieldDescription>{t("updates.console.buildHint")}</FieldDescription>
          <RadioGroup
            value={releaseId}
            onValueChange={(value) => onBuildChange(String(value))}
            aria-label={t("updates.console.buildLabel")}
          >
            <div className="grid gap-2 sm:grid-cols-2">
              {releaseGroup.map((item) => {
                const itemReadiness = releaseReadiness(item, t);
                const matchingScreens = familyScreens.filter(
                  (screen) =>
                    !item.architecture ||
                    screen.playerArchitecture === item.architecture,
                ).length;
                const preparing =
                  releaseId === item.id && selectedBuildPreparing;
                return (
                  <Card
                    key={item.id}
                    size="sm"
                    className={
                      releaseId === item.id
                        ? "ring-2 ring-primary/50"
                        : "transition-colors hover:bg-accent/20"
                    }
                  >
                    <CardContent>
                      <Field orientation="horizontal" className="gap-3">
                        <RadioGroupItem
                          id={`release-build-${item.id}`}
                          value={item.id}
                          aria-label={`${architectureLabel(
                            item.architecture,
                            t,
                          )} (${item.architecture || familyLabel(family, t)})`}
                        />
                        <FieldContent>
                          <FieldLabel
                            htmlFor={`release-build-${item.id}`}
                            className="flex flex-wrap gap-2"
                          >
                            {architectureLabel(item.architecture, t)}
                            <Badge
                              variant={
                                deployable(item) ? "outline" : "secondary"
                              }
                            >
                              {deployable(item)
                                ? t("updates.console.buildReady")
                                : preparing ||
                                    item.cacheStatus === "downloading"
                                  ? t("updates.console.preparingBuild")
                                  : t("updates.console.buildPrepareNeeded")}
                            </Badge>
                          </FieldLabel>
                          <FieldDescription>
                            {item.architecture && (
                              <>
                                <span className="font-mono">
                                  {item.architecture}
                                </span>
                                {" · "}
                              </>
                            )}
                            {t("updates.console.buildScreenCount", {
                              count: matchingScreens,
                            })}
                            {" · "}
                            {formatBytes(item.apkSizeBytes, locale)}
                          </FieldDescription>
                          {itemReadiness.detail && (
                            <p
                              className={
                                itemReadiness.tone === "danger"
                                  ? "text-xs text-destructive"
                                  : "text-xs text-muted-foreground"
                              }
                            >
                              {itemReadiness.detail}
                            </p>
                          )}
                          {(preparing ||
                            item.cacheStatus === "downloading") && (
                            <div className="grid gap-1 pt-1">
                              <Progress
                                value={
                                  item.apkSizeBytes > 0
                                    ? Math.min(
                                        100,
                                        Math.round(
                                          (item.downloadedBytes /
                                            item.apkSizeBytes) *
                                            100,
                                        ),
                                      )
                                    : 0
                                }
                                aria-label={t(
                                  "updates.console.preparingBuild",
                                )}
                              />
                              <p className="text-xs text-muted-foreground">
                                {t("updates.console.preparationContinuesHint")}
                              </p>
                            </div>
                          )}
                        </FieldContent>
                      </Field>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          </RadioGroup>
        </FieldSet>
      )}

      {prepareError && (
        <Alert variant="destructive">
          <AlertDescription>{apiErrorMessage(prepareError)}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}

function DeploymentStepRail({ stage }: { stage: number }) {
  const { t } = useTranslation(["settings", "common"]);
  return (
    <ol
      className="grid grid-cols-3 gap-2"
      aria-label={t("updates.panel.deployAction")}
    >
      {(["release", "targets", "rollout"] as const).map((key, index) => (
        <li key={key} className="grid min-w-0 gap-1">
          <div className="flex items-center gap-2">
            <span
              className={`grid size-6 shrink-0 place-items-center rounded-full border text-xs font-semibold ${
                stage === index + 1
                  ? "border-primary bg-primary text-primary-foreground"
                  : stage > index + 1
                    ? "border-primary/40 bg-primary/10 text-foreground"
                    : "border-border text-muted-foreground"
              }`}
              aria-current={stage === index + 1 ? "step" : undefined}
            >
              {index + 1}
            </span>
            {index < 2 && (
              <span
                className={`h-px min-w-2 flex-1 ${
                  stage > index + 1 ? "bg-primary/40" : "bg-border"
                }`}
                aria-hidden="true"
              />
            )}
          </div>
          <span
            className={`truncate text-xs ${
              stage === index + 1
                ? "font-semibold text-foreground"
                : "text-muted-foreground"
            }`}
          >
            {t(`updates.console.steps.${key}`)}
          </span>
        </li>
      ))}
    </ol>
  );
}

function RolloutStep({
  release,
  family,
  mode,
  onModeChange,
  windowStart,
  onWindowStartChange,
  invalidWindow,
  canary,
  onCanaryChange,
  canarySize,
  onCanarySizeChange,
  invalidCanary,
  result,
}: {
  release?: PlayerRelease;
  family: UpdateFamilyTab;
  mode: UpdateDeploymentMode;
  onModeChange: (mode: UpdateDeploymentMode) => void;
  windowStart: string;
  onWindowStartChange: (value: string) => void;
  invalidWindow: boolean;
  canary: boolean;
  onCanaryChange: (checked: boolean) => void;
  canarySize: number;
  onCanarySizeChange: (value: number) => void;
  invalidCanary: boolean;
  result?: import("../../api/types").UpdateDeploymentPreview;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const locale = useFormatLocale();
  const playerFamily = release ? releaseUpdateTab(release) : family;
  const noteKey =
    playerFamily === "android"
      ? "androidNote"
      : playerFamily === "edge"
        ? "edgeNote"
        : playerFamily === "windows"
          ? "windowsNote"
          : "linuxNote";

  return (
    <>
      <Card size="sm" role="region" aria-label={t("updates.console.review")}>
        <CardHeader>
          <CardTitle>{t("updates.console.review")}</CardTitle>
        </CardHeader>
        <CardContent className="gap-1">
          <strong className="text-sm">{release?.versionName}</strong>
          {release && (
            <p className="text-sm text-muted-foreground">
              {familyLabel(family, t)}
              {release.architecture &&
                ` · ${architectureLabel(release.architecture, t)} (${release.architecture})`}
            </p>
          )}
          <p className="text-sm">
            {t("updates.console.targetCount", {
              count: result?.targetCount ?? 0,
            })}{" "}
            · {modeLabel(mode, t)}
            {canary &&
              ` · ${t("updates.console.canarySummary", { count: canarySize })}`}
          </p>
          {mode === "maintenance_window" && windowStart && (
            <p className="text-sm">
              {new Date(windowStart).toLocaleString(locale)}
            </p>
          )}
        </CardContent>
      </Card>

      <FieldGroup className="gap-5">
        <Field>
          <FieldLabel htmlFor="update-mode">
            {t("updates.panel.modeLabel")}
          </FieldLabel>
          <Select
            items={(
              [
                "install_now",
                "download_only",
                "maintenance_window",
              ] as const
            ).map((value) => ({
              value,
              label: modeLabel(value, t),
            }))}
            value={mode}
            onValueChange={(value) =>
              value && onModeChange(value as UpdateDeploymentMode)
            }
          >
            <SelectTrigger id="update-mode">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(
                [
                  "install_now",
                  "download_only",
                  "maintenance_window",
                ] as const
              ).map((value) => (
                <SelectItem key={value} value={value}>
                  {modeLabel(value, t)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FieldDescription>
            {t(`updates.console.modeHints.${mode}`)}
          </FieldDescription>
        </Field>

        {mode === "maintenance_window" && (
          <Field>
            <FieldLabel htmlFor="update-window">
              {t("updates.panel.windowLabel")}
            </FieldLabel>
            <DateTimeInput
              id="update-window"
              value={windowStart}
              onChange={onWindowStartChange}
            />
            <FieldDescription>
              {t("updates.console.windowHint")}
            </FieldDescription>
            {invalidWindow && (
              <FieldError>{t("updates.console.futureWindow")}</FieldError>
            )}
          </Field>
        )}

        <Collapsible>
          <CollapsibleTrigger
            render={
              <Button
                variant="ghost"
                size="sm"
                className="justify-start px-0"
              />
            }
          >
            {t("updates.console.rolloutSafeguards")}
            {canary && (
              <Badge variant="secondary">
                {t("updates.console.canarySummary", {
                  count: canarySize,
                })}
              </Badge>
            )}
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-3">
            <div className="rounded-lg border bg-muted/20 p-3">
              <Field orientation="horizontal">
                <Switch
                  id="update-canary"
                  checked={canary}
                  onCheckedChange={onCanaryChange}
                />
                <FieldContent>
                  <FieldLabel htmlFor="update-canary">
                    {t("updates.console.canaryRollout")}
                  </FieldLabel>
                  <FieldDescription>
                    {t("updates.console.canaryHint")}
                  </FieldDescription>
                </FieldContent>
              </Field>
              {canary && (
                <Field className="mt-3">
                  <FieldLabel htmlFor="update-canary-count">
                    {t("updates.panel.canaryLabel")}
                  </FieldLabel>
                  <Input
                    id="update-canary-count"
                    type="number"
                    min={1}
                    max={Math.min(50, (result?.eligibleCount ?? 0) - 1)}
                    value={canarySize}
                    onChange={(e) =>
                      onCanarySizeChange(Number(e.target.value))
                    }
                  />
                  {invalidCanary && (
                    <FieldError>
                      {t("updates.console.invalidCanary")}
                    </FieldError>
                  )}
                </Field>
              )}
            </div>
          </CollapsibleContent>
        </Collapsible>
      </FieldGroup>

      <p className="text-sm text-muted-foreground">
        {t(`updates.panel.${noteKey}`)}
      </p>
    </>
  );
}

export function DeployUpdateSheet({
  releases,
  screens,
  groups,
  initialFamily,
  preselected,
  onClose,
  onCreated,
}: {
  releases: PlayerRelease[];
  screens: Screen[];
  groups: ScreenGroup[];
  initialFamily: UpdateFamilyTab;
  preselected?: string;
  onClose: () => void;
  onCreated: (id: string, family: UpdateFamilyTab) => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const { t: screenT } = useTranslation("screens");
  const locale = useFormatLocale();
  const auth = useAuth();
  const csrf = auth.status?.csrfToken ?? "";
  const client = useQueryClient();
  const initialRelease = releases.find((item) => item.id === preselected);
  const initialReleaseFamily = initialRelease
    ? releaseUpdateTab(initialRelease)
    : initialFamily;
  const initialGroups = groupReleases(
    releases.filter(
      (item) => releaseUpdateTab(item) === initialReleaseFamily,
    ),
  );
  const initialGroup =
    (initialRelease
      ? initialGroups.find((items) =>
          items.some((item) => item.id === initialRelease.id),
        )
      : undefined) ?? (initialGroups.length === 1 ? initialGroups[0] : undefined);
  const initialFamilyScreens = screens.filter(
    (screen) => screenUpdateTab(screen) === initialReleaseFamily,
  );
  const initialMatchingBuilds = (initialGroup ?? []).filter(
    (item) =>
      !item.architecture ||
      initialFamilyScreens.some(
        (screen) => screen.playerArchitecture === item.architecture,
      ),
  );
  const automaticInitialRelease =
    initialRelease ??
    (initialGroup?.length === 1
      ? initialGroup[0]
      : initialMatchingBuilds.length === 1
        ? initialMatchingBuilds[0]
        : undefined);

  const [stage, setStage] = useState(1);
  const [family, setFamily] =
    useState<UpdateFamilyTab>(initialReleaseFamily);
  const [releaseGroupId, setReleaseGroupId] = useState(
    initialGroup ? releaseGroupKey(initialGroup) : "",
  );
  const [releaseId, setReleaseId] = useState(
    automaticInitialRelease?.id ?? "",
  );
  const [selected, setSelected] = useState<TargetChoice[]>([]);
  const [search, setSearch] = useState("");
  const [mode, setMode] = useState<UpdateDeploymentMode>("install_now");
  const [windowStart, setWindowStart] = useState("");
  const [canary, setCanary] = useState(false);
  const [canarySize, setCanarySize] = useState(1);
  const targetAnchor = useComboboxAnchor();

  const familyReleases = releases.filter(
    (item) => releaseUpdateTab(item) === family,
  );
  const releaseGroups = groupReleases(familyReleases);
  const releaseGroup = releaseGroups.find(
    (items) => releaseGroupKey(items) === releaseGroupId,
  );
  const release = releases.find((item) => item.id === releaseId);
  const readiness = release ? releaseReadiness(release, t) : undefined;
  const familyScreens = useMemo(
    () => screens.filter((screen) => screenUpdateTab(screen) === family),
    [screens, family],
  );
  const familyScreenIds = useMemo(
    () => new Set(familyScreens.map((screen) => screen.id)),
    [familyScreens],
  );
  const familyGroups = useMemo(
    () =>
      groups.filter((group) =>
        group.screens.some((screen) => familyScreenIds.has(screen.id)),
      ),
    [groups, familyScreenIds],
  );
  const choices = useMemo(
    () => [
      ...familyScreens.map((screen) => ({
        value: screen.id,
        label: screen.name,
        type: "screen" as const,
      })),
      ...familyGroups.map((group) => ({
        value: group.id,
        label: group.name,
        type: "group" as const,
      })),
    ],
    [familyScreens, familyGroups],
  );

  const selectedBuildScreenCount = release
    ? familyScreens.filter(
        (screen) =>
          !release.architecture ||
          screen.playerArchitecture === release.architecture,
      ).length
    : 0;

  const selection = {
    releaseId,
    screenIds: selected.filter((i) => i.type === "screen").map((i) => i.value),
    groupIds: selected.filter((i) => i.type === "group").map((i) => i.value),
  };
  // One server evaluation for the complete candidate list gives disabled
  // screen options their authoritative reason. A second resolves the selection,
  // including group membership and duplicates, for review.
  const candidates = useQuery({
    queryKey: [
      "update-candidates",
      releaseId,
      familyScreens.map((screen) => screen.id),
    ],
    queryFn: () =>
      api.previewUpdateDeployment(
        {
          releaseId,
          screenIds: familyScreens.map((screen) => screen.id),
          groupIds: [],
        },
        csrf,
      ),
    enabled: !!release && familyScreens.length > 0,
    staleTime: 0,
    refetchInterval: 10_000,
  });
  const preview = useQuery({
    queryKey: ["update-preview", selection],
    queryFn: () => api.previewUpdateDeployment(selection, csrf),
    enabled: !!release && selected.length > 0,
    staleTime: 0,
    refetchInterval: 5_000,
  });
  const prepare = useMutation({
    mutationFn: (selectedRelease: PlayerRelease) =>
      api.cachePlayerRelease(selectedRelease.id, csrf),
    onSuccess: () =>
      client.invalidateQueries({ queryKey: ["player-releases"] }),
  });
  const result = preview.data;
  const candidateById = new Map(
    candidates.data?.screens.map((s) => [s.screenId, s]),
  );
  const blocked =
    result?.screens.filter((s) => s.outcome === "incompatible") ?? [];
  const invalidCanary =
    canary &&
    (!Number.isInteger(canarySize) ||
      canarySize < 1 ||
      canarySize > 50 ||
      canarySize >= (result?.eligibleCount ?? 0) ||
      (result?.alreadyCurrentCount ?? 0) > 0);
  const invalidWindow =
    mode === "maintenance_window" &&
    (!windowStart ||
      !Number.isFinite(Date.parse(windowStart)) ||
      Date.parse(windowStart) <= Date.now());
  const ready =
    !!release &&
    deployable(release) &&
    !!result?.targetCount &&
    !result.blockedCount &&
    !preview.isFetching &&
    !preview.isError &&
    !invalidCanary &&
    !invalidWindow &&
    (result?.eligibleCount ?? 0) > 0;
  const deploy = useMutation({
    mutationFn: () =>
      api.createUpdateDeployment(
        {
          ...selection,
          name: release
            ? `${artifactIdentity(release, t)} ${release.versionName}`
            : "",
          mode,
          canarySize: canary ? canarySize : 0,
          maintenanceWindowStart:
            mode === "maintenance_window"
              ? new Date(windowStart).toISOString()
              : undefined,
        },
        csrf,
      ),
    onSuccess: (created) => {
      toast.add({
        title: t("updates.panel.deployCreatedOther", {
          count: created.targetCount,
        }),
        type: "success",
      });
      onCreated(created.id, family);
    },
  });
  const stageKey =
    stage === 1 ? "release" : stage === 2 ? "targets" : "rollout";
  const selectedBuildPreparing =
    prepare.isPending || release?.cacheStatus === "downloading";
  const canPrepareSelected =
    !!release &&
    !deployable(release) &&
    !selectedBuildPreparing &&
    !!readiness?.cacheable;
  const busy = deploy.isPending || prepare.isPending;

  function changeFamily(nextFamily: UpdateFamilyTab) {
    if (nextFamily === family) return;
    setFamily(nextFamily);
    setReleaseGroupId("");
    setReleaseId("");
    setSelected([]);
  }

  function changeVersion(key: string) {
    const next = releaseGroups.find(
      (items) => releaseGroupKey(items) === key,
    );
    const matching = (next ?? []).filter(
      (item) =>
        !item.architecture ||
        familyScreens.some(
          (screen) => screen.playerArchitecture === item.architecture,
        ),
    );
    const automatic =
      next?.length === 1
        ? next[0]
        : matching.length === 1
          ? matching[0]
          : undefined;
    setReleaseGroupId(key);
    setReleaseId(automatic?.id ?? "");
    setSelected([]);
  }

  function changeBuild(id: string) {
    if (id === releaseId) return;
    setReleaseId(id);
    setSelected([]);
  }

  const footer = (
    <div className="flex w-full flex-wrap items-center justify-between gap-2">
      <Button
        variant="ghost"
        disabled={busy}
        onClick={() => (stage === 1 ? onClose() : setStage(stage - 1))}
      >
        {stage === 1
          ? selectedBuildPreparing
            ? t("common:actions.close")
            : t("common:actions.cancel")
          : t("common:actions.back")}
      </Button>
      <Button
        disabled={
          busy ||
          (stage === 1
            ? !release ||
              selectedBuildScreenCount === 0 ||
              selectedBuildPreparing ||
              (!deployable(release) && !canPrepareSelected)
            : stage === 2
              ? !result?.targetCount ||
                !!result.blockedCount ||
                preview.isFetching ||
                preview.isError
              : !ready)
        }
        onClick={() => {
          if (stage === 3) {
            deploy.mutate();
            return;
          }
          if (stage === 2) {
            setStage(3);
            return;
          }
          if (!release) return;
          if (deployable(release)) {
            setStage(2);
            return;
          }
          if (canPrepareSelected) prepare.mutate(release);
        }}
      >
        {(deploy.isPending || prepare.isPending) && <Spinner />}
        {stage === 3
          ? t("updates.panel.deployAction")
          : stage === 1 && selectedBuildPreparing
            ? t("updates.console.preparingBuild")
            : stage === 1 && release && !deployable(release)
              ? prepare.isPending
                ? t("updates.console.startingPreparation")
                : t("updates.console.prepareBuildAction")
              : t("updates.console.continue")}
      </Button>
    </div>
  );
  return (
    <UpdateSurface
      open
      onOpenChange={(open) => !open && !busy && onClose()}
      title={t("updates.panel.deployAction")}
      description={t("updates.console.step", {
        stage,
        title: t(`updates.console.steps.${stageKey}`),
      })}
      footer={footer}
      presentation="dialog"
    >
      <DeploymentStepRail stage={stage} />
      <h2 className="text-lg font-semibold">
        {t(`updates.console.steps.${stageKey}`)}
      </h2>
      <p className="text-sm text-muted-foreground">
        {t(`updates.console.stepHints.${stageKey}`)}
      </p>
      {stage === 1 && (
        <UpdateSelectionStep
          family={family}
          releaseGroups={releaseGroups}
          releaseGroupId={releaseGroupId}
          releaseGroup={releaseGroup}
          releaseId={releaseId}
          release={release}
          familyScreens={familyScreens}
          selectedBuildScreenCount={selectedBuildScreenCount}
          selectedBuildPreparing={selectedBuildPreparing}
          prepareError={prepare.error}
          onFamilyChange={changeFamily}
          onVersionChange={changeVersion}
          onBuildChange={changeBuild}
        />
      )}
      {stage === 2 && (
        <>
          <p className="text-sm font-medium">
            {release?.versionName} · {release && artifactIdentity(release, t)}
          </p>
          <Field>
            <FieldLabel htmlFor="update-target-search">
              {t("updates.panel.targetsLabel")}
            </FieldLabel>
            <Combobox
              multiple
              items={choices}
              value={selected}
              onValueChange={setSelected}
              itemToStringLabel={(i: TargetChoice) => i.label}
              isItemEqualToValue={(a: TargetChoice, b: TargetChoice) =>
                a.value === b.value && a.type === b.type
              }
              inputValue={search}
              onInputValueChange={setSearch}
            >
              <ComboboxChips ref={targetAnchor}>
                <ComboboxValue>
                  {(value: TargetChoice[]) =>
                    value.map((item) => (
                      <ComboboxChip
                        key={`${item.type}-${item.value}`}
                        removeLabel={t("updates.console.removeTarget", {
                          name: item.label,
                        })}
                      >
                        {item.label}
                      </ComboboxChip>
                    ))
                  }
                </ComboboxValue>
                <ComboboxChipsInput
                  id="update-target-search"
                  placeholder={
                    selected.length
                      ? undefined
                      : t("updates.panel.searchPlaceholder")
                  }
                />
              </ComboboxChips>
              <ComboboxContent anchor={targetAnchor}>
                <ComboboxEmpty>
                  {t("updates.console.noTargetMatch")}
                </ComboboxEmpty>
                <ComboboxList>
                  {(["screen", "group"] as const).map((type) => (
                    <ComboboxGroup key={type}>
                      <ComboboxLabel>
                        {type === "screen"
                          ? t("updates.console.screens")
                          : t("updates.panel.groupsHeading")}
                      </ComboboxLabel>
                      {choices
                        .filter(
                          (i) =>
                            i.type === type &&
                            i.label
                              .toLowerCase()
                              .includes(search.toLowerCase()),
                        )
                        .map((choice) => {
                          const s = screens.find((s) => s.id === choice.value);
                          const g = groups.find((g) => g.id === choice.value);
                          const candidate = candidateById.get(choice.value);
                          const disabled =
                            choice.type === "screen" &&
                            (!candidate ||
                              candidate.outcome === "incompatible" ||
                              !!candidates.error);
                          return (
                            <ComboboxItem
                              key={`${type}-${choice.value}`}
                              value={choice}
                              disabled={disabled}
                              className="items-start data-disabled:opacity-100"
                            >
                              <div className="grid min-w-0 gap-0.5">
                                <span className="font-medium">
                                  {choice.label}
                                </span>
                                {s && (
                                  <span className="text-xs text-muted-foreground">
                                    {s.playerVersion} ·{" "}
                                    {screenT(`status.${s.status}`)}
                                    {s.playerArchitecture &&
                                      ` · ${s.playerArchitecture}`}
                                  </span>
                                )}
                                {g && (
                                  <span className="text-xs text-muted-foreground">
                                    {t("updates.console.groupMembers", {
                                      count: g.membershipCount,
                                      eligible: g.screens.filter((s) => {
                                        const c = candidateById.get(s.id);
                                        return (
                                          c && c.outcome !== "incompatible"
                                        );
                                      }).length,
                                    })}
                                  </span>
                                )}
                                {candidate?.reason && (
                                  <span className="text-xs text-destructive">
                                    {candidate.reason}
                                  </span>
                                )}
                                {disabled && !candidate && (
                                  <span className="text-xs text-muted-foreground">
                                    {t("updates.console.checkingCompatibility")}
                                  </span>
                                )}
                              </div>
                            </ComboboxItem>
                          );
                        })}
                    </ComboboxGroup>
                  ))}
                </ComboboxList>
              </ComboboxContent>
            </Combobox>
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={
                candidates.isFetching || !!candidates.error || !candidates.data
              }
              onClick={() =>
                setSelected(
                  choices.filter(
                    (c) =>
                      c.type === "screen" &&
                      candidateById.get(c.value)?.outcome !== "incompatible" &&
                      candidateById.get(c.value)?.outcome !==
                        "already_current" &&
                      candidateById.has(c.value),
                  ),
                )
              }
            >
              {t("updates.console.selectEligible")}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setSelected([])}>
              {t("updates.panel.clearSelection")}
            </Button>
          </div>
          <p role="status" className="text-sm font-medium">
            {preview.isFetching
              ? t("updates.console.checkingCompatibility")
              : t("updates.console.selectedCount", {
                  count: result?.targetCount ?? 0,
                })}
          </p>
        </>
      )}
      {stage === 3 && (
        <RolloutStep
          release={release}
          family={family}
          mode={mode}
          onModeChange={setMode}
          windowStart={windowStart}
          onWindowStartChange={setWindowStart}
          invalidWindow={invalidWindow}
          canary={canary}
          onCanaryChange={setCanary}
          canarySize={canarySize}
          onCanarySizeChange={setCanarySize}
          invalidCanary={invalidCanary}
          result={result}
        />
      )}
      {(preview.error || candidates.error) && stage > 1 && (
        <Alert variant="destructive">
          <AlertDescription>
            {apiErrorMessage(preview.error ?? candidates.error)}
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void preview.refetch();
                void candidates.refetch();
              }}
            >
              {t("common:actions.retry")}
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {stage > 1 && blocked.length > 0 && (
        <Alert variant="destructive">
          <AlertTitle>{t("updates.console.blockedTitle")}</AlertTitle>
          <AlertDescription>
            <ul>
              {blocked.map((s) => (
                <li key={s.screenId}>
                  <strong>{s.screenName}</strong>: {s.reason}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}
      {stage > 1 && !!result?.offlineCount && (
        <Alert>
          <AlertDescription>
            {t("updates.console.offlineWarning", {
              count: result.offlineCount,
            })}
          </AlertDescription>
        </Alert>
      )}
      {stage > 1 && !!result?.alreadyCurrentCount && (
        <Alert>
          <AlertDescription>
            {t("updates.console.currentWarning", {
              count: result.alreadyCurrentCount,
            })}
          </AlertDescription>
        </Alert>
      )}
      {deploy.error && (
        <Alert variant="destructive">
          <AlertDescription>{apiErrorMessage(deploy.error)}</AlertDescription>
        </Alert>
      )}
    </UpdateSurface>
  );
}
