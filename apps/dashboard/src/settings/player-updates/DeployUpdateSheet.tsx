import { useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
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
import { releaseUpdateTab } from "../../playerPlatform";
import { DateTimeInput } from "../../components/date-picker";
import { Alert, AlertTitle, AlertDescription } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
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
import { RadioGroup, RadioGroupItem } from "../../components/ui/radio-group";
import { Switch } from "../../components/ui/switch";
import { Spinner } from "../../components/ui/spinner";
import { toast } from "../../components/ui/toast";
import { UpdateSurface } from "./UpdateSurface";
import { artifactIdentity, deployable, modeLabel } from "./model";

type TargetChoice = { value: string; label: string; type: "screen" | "group" };
export function DeployUpdateSheet({
  releases,
  screens,
  groups,
  preselected,
  onClose,
  onCreated,
}: {
  releases: PlayerRelease[];
  screens: Screen[];
  groups: ScreenGroup[];
  preselected?: string;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const { t: screenT } = useTranslation("screens");
  const locale = useFormatLocale();
  const auth = useAuth();
  const csrf = auth.status?.csrfToken ?? "";
  const [stage, setStage] = useState(1);
  const [releaseId, setReleaseId] = useState(preselected ?? "");
  const [selected, setSelected] = useState<TargetChoice[]>([]);
  const [search, setSearch] = useState("");
  const [mode, setMode] = useState<UpdateDeploymentMode>("install_now");
  const [windowStart, setWindowStart] = useState("");
  const [canary, setCanary] = useState(false);
  const [canarySize, setCanarySize] = useState(1);
  const targetAnchor = useComboboxAnchor();
  const release = releases.find((r) => r.id === releaseId);
  const choices = useMemo(
    () => [
      ...screens.map((s) => ({
        value: s.id,
        label: s.name,
        type: "screen" as const,
      })),
      ...groups.map((g) => ({
        value: g.id,
        label: g.name,
        type: "group" as const,
      })),
    ],
    [screens, groups],
  );
  const selection = {
    releaseId,
    screenIds: selected.filter((i) => i.type === "screen").map((i) => i.value),
    groupIds: selected.filter((i) => i.type === "group").map((i) => i.value),
  };
  // One server evaluation for the complete candidate list gives disabled
  // screen options their authoritative reason. A second resolves the selection,
  // including group membership and duplicates, for review.
  const candidates = useQuery({
    queryKey: ["update-candidates", releaseId, screens.map((s) => s.id)],
    queryFn: () =>
      api.previewUpdateDeployment(
        { releaseId, screenIds: screens.map((s) => s.id), groupIds: [] },
        csrf,
      ),
    enabled: !!release && screens.length > 0,
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
      onCreated(created.id);
    },
  });
  const stageKey =
    stage === 1 ? "release" : stage === 2 ? "targets" : "rollout";
  const footer = (
    <div className="flex w-full flex-wrap items-center justify-between gap-2">
      <Button
        variant="ghost"
        disabled={deploy.isPending}
        onClick={() => (stage === 1 ? onClose() : setStage(stage - 1))}
      >
        {stage === 1 ? t("common:actions.cancel") : t("common:actions.back")}
      </Button>
      <Button
        disabled={
          deploy.isPending ||
          (stage === 1
            ? !release || !deployable(release)
            : stage === 2
              ? !result?.targetCount ||
                !!result.blockedCount ||
                preview.isFetching ||
                preview.isError
              : !ready)
        }
        onClick={() => (stage === 3 ? deploy.mutate() : setStage(stage + 1))}
      >
        {deploy.isPending && <Spinner />}
        {stage === 3
          ? t("updates.panel.deployAction")
          : t("updates.console.continue")}
      </Button>
    </div>
  );
  return (
    <UpdateSurface
      open
      onOpenChange={(open) => !open && !deploy.isPending && onClose()}
      title={t("updates.panel.deployAction")}
      description={t("updates.console.step", {
        stage,
        title: t(`updates.console.steps.${stageKey}`),
      })}
      footer={footer}
      presentation="dialog"
    >
      <ol
        className="grid grid-cols-3 gap-2"
        aria-label={t("updates.panel.deployAction")}
      >
        {(["release", "targets", "rollout"] as const).map((key, index) => (
          <li
            key={key}
            className={`rounded-lg border px-3 py-3 ${
              stage === index + 1
                ? "border-primary bg-accent"
                : stage > index + 1
                  ? "border-primary/40"
                  : "border-border"
            }`}
            aria-current={stage === index + 1 ? "step" : undefined}
          >
            <span className="block text-xs font-medium text-muted-foreground">
              {index + 1}
            </span>
            <span className="text-sm font-semibold">
              {t(`updates.console.steps.${key}`)}
            </span>
          </li>
        ))}
      </ol>
      <h2 className="text-lg font-semibold">
        {t(`updates.console.steps.${stageKey}`)}
      </h2>
      <p className="text-sm text-muted-foreground">
        {t(`updates.console.stepHints.${stageKey}`)}
      </p>
      {stage === 1 && (
        <FieldSet>
          <FieldLegend variant="label" className="sr-only">
            {t("updates.panel.releaseLabel")}
          </FieldLegend>
          {!releases.some(deployable) && (
            <Alert>
              <AlertDescription>
                {t("updates.console.noReadyRelease")}
              </AlertDescription>
            </Alert>
          )}
          <RadioGroup
            value={releaseId}
            onValueChange={(value) => {
              if (value !== releaseId) {
                setReleaseId(String(value));
                setSelected([]);
              }
            }}
            aria-label={t("updates.panel.releaseLabel")}
          >
            {releases.map((r) => (
              <Card
                key={r.id}
                size="sm"
                className={
                  releaseId === r.id
                    ? "ring-2 ring-primary/50"
                    : "transition-colors hover:bg-accent/20"
                }
              >
                <CardContent>
                  <Field orientation="horizontal" className="gap-3">
                    <RadioGroupItem
                      id={`release-${r.id}`}
                      aria-label={`${r.versionName} · ${artifactIdentity(r, t)} · ${r.channel === "beta" ? t("updates.panel.channelBeta") : t("updates.panel.channelStable")}`}
                      value={r.id}
                      disabled={!deployable(r)}
                    />
                    <FieldContent>
                      <FieldLabel
                        htmlFor={`release-${r.id}`}
                        className="flex flex-wrap gap-2"
                      >
                        {r.versionName}
                        <Badge variant="outline">
                          {r.channel === "beta"
                            ? t("updates.panel.channelBeta")
                            : t("updates.panel.channelStable")}
                        </Badge>
                        <span className="basis-full text-sm font-medium">
                          {artifactIdentity(r, t)}
                        </span>
                      </FieldLabel>
                      <FieldDescription>
                        {formatBytes(r.apkSizeBytes, locale)} ·{" "}
                        {new Date(r.publishedAt).toLocaleDateString(locale)}
                        {!deployable(r) &&
                          ` · ${t("updates.console.prepareFirst")}`}
                      </FieldDescription>
                    </FieldContent>
                  </Field>
                </CardContent>
              </Card>
            ))}
          </RadioGroup>
        </FieldSet>
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
        <>
          <FieldGroup className="gap-5">
            <FieldSet>
              <FieldLegend variant="label">
                {t("updates.panel.modeLabel")}
              </FieldLegend>
              <RadioGroup
                value={mode}
                onValueChange={(value) =>
                  setMode(value as UpdateDeploymentMode)
                }
              >
                {(
                  [
                    "install_now",
                    "download_only",
                    "maintenance_window",
                  ] as const
                ).map((value) => (
                  <Field key={value} orientation="horizontal">
                    <RadioGroupItem id={value} value={value} />
                    <FieldContent>
                      <FieldLabel htmlFor={value}>
                        {modeLabel(value, t)}
                      </FieldLabel>
                      <FieldDescription>
                        {t(`updates.console.modeHints.${value}`)}
                      </FieldDescription>
                    </FieldContent>
                  </Field>
                ))}
              </RadioGroup>
            </FieldSet>
            {mode === "maintenance_window" && (
              <Field>
                <FieldLabel htmlFor="update-window">
                  {t("updates.panel.windowLabel")}
                </FieldLabel>
                <DateTimeInput
                  id="update-window"
                  value={windowStart}
                  onChange={setWindowStart}
                />
                <FieldDescription>
                  {t("updates.console.windowHint")}
                </FieldDescription>
                {invalidWindow && (
                  <FieldError>{t("updates.console.futureWindow")}</FieldError>
                )}
              </Field>
            )}
            <Field orientation="horizontal">
              <Switch
                id="update-canary"
                checked={canary}
                onCheckedChange={setCanary}
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
              <Field>
                <FieldLabel htmlFor="update-canary-count">
                  {t("updates.panel.canaryLabel")}
                </FieldLabel>
                <Input
                  id="update-canary-count"
                  type="number"
                  min={1}
                  max={Math.min(50, (result?.eligibleCount ?? 0) - 1)}
                  value={canarySize}
                  onChange={(e) => setCanarySize(Number(e.target.value))}
                />
                {invalidCanary && (
                  <FieldError>{t("updates.console.invalidCanary")}</FieldError>
                )}
              </Field>
            )}
          </FieldGroup>
          <Card
            size="sm"
            role="region"
            aria-label={t("updates.console.review")}
          >
            <CardHeader>
              <CardTitle>{t("updates.console.review")}</CardTitle>
            </CardHeader>
            <CardContent className="gap-1">
              <strong className="text-sm">{release?.versionName}</strong>
              <p className="text-sm">
                {release && artifactIdentity(release, t)}
              </p>
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
          <p className="text-sm text-muted-foreground">
            {releaseUpdateTab(release ?? { platform: "android" }) === "android"
              ? t("updates.panel.androidNote")
              : releaseUpdateTab(release ?? { platform: "android" }) === "edge"
                ? t("updates.panel.edgeNote")
                : releaseUpdateTab(release ?? { platform: "android" }) ===
                    "windows"
                  ? t("updates.panel.windowsNote")
                  : t("updates.panel.linuxNote")}
          </p>
        </>
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
