import { useEffect, useMemo, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft,
  CloudSun,
  Plus,
  Siren,
  TriangleAlert,
  X,
} from "lucide-react";
import { useForm } from "react-hook-form";
import { Link } from "react-router";
import { z } from "zod";
import { api, ApiError } from "../api/client";
import { useFormatLocale } from "../i18n";
import type { NWSAlertRule, NWSAlertRuleInput, Playlist } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { useConfirm } from "../components/ConfirmDialog";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button, buttonVariants } from "../components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "../components/ui/card";
import { Checkbox } from "../components/ui/checkbox";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../components/ui/empty";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSeparator,
  FieldSet,
} from "../components/ui/field";
import { Input } from "../components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "../components/ui/item";
import {
  NativeSelect,
  NativeSelectOption,
} from "../components/ui/native-select";
import { Spinner } from "../components/ui/spinner";
import { Switch } from "../components/ui/switch";
import { PluginActionsMenu } from "../plugins/PluginActionsMenu";

const emptyRule: NWSAlertRuleInput = {
  name: "",
  enabled: true,
  eventNames: ["Tornado Warning"],
  minimumSeverity: "Severe",
  minimumUrgency: "Expected",
  responseMode: "takeover",
  presentationMode: "builtin",
  playlistId: undefined,
  tickerDisplayMode: "push",
  tickerHeightPx: 96,
  tickerSpeed: "medium",
  maximumDurationMinutes: 360,
  screenIds: [],
  groupIds: [],
};

function makeRuleSchema(t: TFunction<"alerts">) {
  return z
    .object({
      name: z
        .string()
        .trim()
        .min(1, t("emergency.rules.validation.nameRequired"))
        .max(180),
      enabled: z.boolean(),
      eventNames: z.array(z.string()),
      minimumSeverity: z.enum(["Minor", "Moderate", "Severe", "Extreme"]),
      minimumUrgency: z.enum(["Unknown", "Future", "Expected", "Immediate"]),
      responseMode: z.enum(["takeover", "ticker"]),
      presentationMode: z.enum(["builtin", "playlist"]),
      playlistId: z.string().optional(),
      tickerDisplayMode: z.enum(["overlay", "push"]),
      tickerHeightPx: z.number().min(40).max(320),
      tickerSpeed: z.enum(["slow", "medium", "fast"]),
      maximumDurationMinutes: z.number(),
      screenIds: z.array(z.string()),
      groupIds: z.array(z.string()),
    })
    .superRefine((value, context) => {
      if (value.presentationMode === "playlist" && !value.playlistId) {
        context.addIssue({
          code: "custom",
          path: ["playlistId"],
          message: t("emergency.rules.validation.playlistRequired"),
        });
      }
      if (value.screenIds.length + value.groupIds.length === 0) {
        context.addIssue({
          code: "custom",
          path: ["screenIds"],
          message: t("emergency.rules.validation.targetsRequired"),
        });
      }
    });
}

const nwsAreas = [
  ["AL", "Alabama"],
  ["AK", "Alaska"],
  ["AZ", "Arizona"],
  ["AR", "Arkansas"],
  ["CA", "California"],
  ["CO", "Colorado"],
  ["CT", "Connecticut"],
  ["DE", "Delaware"],
  ["DC", "District of Columbia"],
  ["FL", "Florida"],
  ["GA", "Georgia"],
  ["HI", "Hawaii"],
  ["ID", "Idaho"],
  ["IL", "Illinois"],
  ["IN", "Indiana"],
  ["IA", "Iowa"],
  ["KS", "Kansas"],
  ["KY", "Kentucky"],
  ["LA", "Louisiana"],
  ["ME", "Maine"],
  ["MD", "Maryland"],
  ["MA", "Massachusetts"],
  ["MI", "Michigan"],
  ["MN", "Minnesota"],
  ["MS", "Mississippi"],
  ["MO", "Missouri"],
  ["MT", "Montana"],
  ["NE", "Nebraska"],
  ["NV", "Nevada"],
  ["NH", "New Hampshire"],
  ["NJ", "New Jersey"],
  ["NM", "New Mexico"],
  ["NY", "New York"],
  ["NC", "North Carolina"],
  ["ND", "North Dakota"],
  ["OH", "Ohio"],
  ["OK", "Oklahoma"],
  ["OR", "Oregon"],
  ["PA", "Pennsylvania"],
  ["RI", "Rhode Island"],
  ["SC", "South Carolina"],
  ["SD", "South Dakota"],
  ["TN", "Tennessee"],
  ["TX", "Texas"],
  ["UT", "Utah"],
  ["VT", "Vermont"],
  ["VA", "Virginia"],
  ["WA", "Washington"],
  ["WV", "West Virginia"],
  ["WI", "Wisconsin"],
  ["WY", "Wyoming"],
  ["AS", "American Samoa"],
  ["GU", "Guam"],
  ["MP", "Northern Mariana Islands"],
  ["PR", "Puerto Rico"],
  ["VI", "U.S. Virgin Islands"],
] as const;

/**
 * The US Weather Alerts plugin: watch official NWS alerts and take screens
 * over while one is active.
 *
 * It lives under Plugins rather than in Settings because it is not a default
 * anything — it is a feature an installation opts into and configures, in the
 * same way a Countdown Bar is. Settings keeps the manual-takeover and command
 * policy that applies whether or not this plugin is used at all.
 */
const severityOptions = ["Minor", "Moderate", "Severe", "Extreme"] as const;
const urgencyOptions = ["Unknown", "Future", "Expected", "Immediate"] as const;

const severityKeys = {
  Minor: "emergency.rules.severity.minor",
  Moderate: "emergency.rules.severity.moderate",
  Severe: "emergency.rules.severity.severe",
  Extreme: "emergency.rules.severity.extreme",
} as const;

const urgencyKeys = {
  Unknown: "emergency.rules.urgency.unknown",
  Future: "emergency.rules.urgency.future",
  Expected: "emergency.rules.urgency.expected",
  Immediate: "emergency.rules.urgency.immediate",
} as const;

export function EmergencyAlertsPage() {
  const { t } = useTranslation(["alerts", "common"]);
  const locale = useFormatLocale();
  const auth = useAuth();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const ruleSchema = useMemo(() => makeRuleSchema(t), [t]);
  const editable = ["owner", "administrator"].includes(
    auth.status?.user?.role ?? "",
  );
  const queryClient = useQueryClient();
  const settings = useQuery({
    queryKey: ["nws-alert-settings"],
    queryFn: api.nwsAlertSettings,
    refetchInterval: 30_000,
  });
  const screens = useQuery({ queryKey: ["screens"], queryFn: api.screens });
  const groups = useQuery({
    queryKey: ["screen-groups", "nws-alerts"],
    queryFn: () => api.screenGroups(),
  });
  const playlists = useQuery({
    queryKey: ["playlists", "nws-alerts"],
    queryFn: () => api.playlists(),
  });
  const [enabled, setEnabled] = useState(false);
  const [areas, setAreas] = useState<string[]>([]);
  const [zones, setZones] = useState<string[]>([]);
  const [selectedArea, setSelectedArea] = useState("");
  const [selectedZone, setSelectedZone] = useState("");
  const zoneOptions = useQuery({
    queryKey: ["nws-zones", selectedArea],
    queryFn: () => api.nwsZones(selectedArea),
    enabled: selectedArea !== "",
    staleTime: 24 * 60 * 60_000,
  });
  const [pollInterval, setPollInterval] = useState(120);
  const [monitorInitialized, setMonitorInitialized] = useState(false);
  const [editing, setEditing] = useState<string>();
  const [eventNamesText, setEventNamesText] = useState(
    emptyRule.eventNames.join(", "),
  );
  const {
    register,
    handleSubmit,
    reset,
    setValue,
    watch,
    formState: { errors: ruleErrors },
  } = useForm<NWSAlertRuleInput>({
    resolver: zodResolver(ruleSchema),
    defaultValues: emptyRule,
  });
  const rule = watch();
  useEffect(() => {
    if (!settings.data || monitorInitialized) return;
    setEnabled(settings.data.monitor.enabled);
    setAreas(settings.data.monitor.areas);
    setZones(settings.data.monitor.zones);
    setSelectedArea(
      settings.data.monitor.areas[0] ??
        settings.data.monitor.zones[0]?.slice(0, 2) ??
        "",
    );
    setPollInterval(settings.data.monitor.pollIntervalSeconds);
    setMonitorInitialized(true);
  }, [settings.data, monitorInitialized]);
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["nws-alert-settings"] });
  const saveMonitor = useMutation({
    mutationFn: () =>
      api.updateNWSAlertMonitor(
        {
          enabled,
          areas,
          zones,
          pollIntervalSeconds: pollInterval,
        },
        auth.status?.csrfToken ?? "",
      ),
    onSuccess: refresh,
  });
  const poll = useMutation({
    mutationFn: () => api.pollNWSAlerts(auth.status?.csrfToken ?? ""),
    onSuccess: refresh,
  });
  const saveRule = useMutation({
    mutationFn: (input: NWSAlertRuleInput) =>
      editing
        ? api.updateNWSAlertRule(editing, input, auth.status?.csrfToken ?? "")
        : api.createNWSAlertRule(input, auth.status?.csrfToken ?? ""),
    onSuccess: () => {
      setEditing(undefined);
      reset(emptyRule);
      setEventNamesText(emptyRule.eventNames.join(", "));
      void refresh();
    },
  });
  const submitRule = handleSubmit((input) =>
    saveRule.mutate({ ...input, eventNames: labels(eventNamesText) }),
  );
  const removeRule = useMutation({
    mutationFn: (id: string) =>
      api.deleteNWSAlertRule(id, auth.status?.csrfToken ?? ""),
    onSuccess: refresh,
  });
  const monitor = settings.data?.monitor;
  return (
    <>
      {confirmDialog}
      <main className="grid gap-4">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div className="grid min-w-0 gap-1">
            <Link
              className="inline-flex items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground"
              to="/plugins"
            >
              <ArrowLeft size={15} aria-hidden="true" />{" "}
              {t("emergency.backToPlugins")}
            </Link>
            <h1 className="text-2xl font-semibold tracking-tight">
              {t("emergency.title")}
            </h1>
            <p className="text-sm text-muted-foreground">
              {t("emergency.description")}
            </p>
          </div>
          <PluginActionsMenu pluginId="emergency_alerts" />
        </header>
        {!editable && (
          <Alert>
            <AlertDescription>{t("emergency.readOnlyNotice")}</AlertDescription>
          </Alert>
        )}
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>{t("emergency.prepare.title")}</h2>
            </CardTitle>
            <CardDescription>
              {t("emergency.prepare.description")}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            <Link
              className={buttonVariants({ variant: "outline", size: "sm" })}
              to="/playlists"
            >
              {t("emergency.prepare.managePlaylists")}
            </Link>
            <Link
              className={buttonVariants({ variant: "outline", size: "sm" })}
              to="/screens"
            >
              {t("emergency.prepare.takeoverNow")}
            </Link>
            <Link
              className={buttonVariants({ variant: "outline", size: "sm" })}
              to="/settings/operations/takeover"
            >
              {t("emergency.prepare.takeoverDefaults")}
            </Link>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>
              <h2>{t("emergency.monitor.title")}</h2>
            </CardTitle>
            <CardDescription>
              {t("emergency.monitor.description")}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-5">
            <Alert>
              <TriangleAlert aria-hidden="true" />
              <AlertTitle>{t("emergency.monitor.safetyTitle")}</AlertTitle>
              <AlertDescription>
                {t("emergency.monitor.safetyBody")}
              </AlertDescription>
            </Alert>
            <FieldGroup>
              <Field orientation="horizontal">
                <Switch
                  id="nws-enabled"
                  checked={enabled}
                  disabled={!editable}
                  onCheckedChange={(next) => setEnabled(next)}
                />
                <FieldContent>
                  <FieldLabel htmlFor="nws-enabled">
                    {t("emergency.monitor.enabledLabel")}
                  </FieldLabel>
                  <FieldDescription>
                    {t("emergency.monitor.enabledHint")}
                  </FieldDescription>
                </FieldContent>
              </Field>
              <FieldSeparator />
              <FieldSet>
                <FieldLegend>
                  {t("emergency.monitor.coverageLegend")}
                </FieldLegend>
                <FieldDescription>
                  {t("emergency.monitor.coverageHint")}
                </FieldDescription>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field>
                    <FieldLabel htmlFor="nws-state">
                      {t("emergency.monitor.stateLabel")}
                    </FieldLabel>
                    <NativeSelect
                      id="nws-state"
                      className="w-full"
                      value={selectedArea}
                      disabled={!editable}
                      onChange={(event) => {
                        setSelectedArea(event.target.value);
                        setSelectedZone("");
                      }}
                    >
                      <NativeSelectOption value="">
                        {t("emergency.monitor.statePlaceholder")}
                      </NativeSelectOption>
                      {nwsAreas.map(([code, name]) => (
                        <NativeSelectOption key={code} value={code}>
                          {name}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="w-fit"
                      disabled={
                        !editable ||
                        !selectedArea ||
                        areas.includes(selectedArea)
                      }
                      onClick={() => setAreas(addUnique(areas, selectedArea))}
                    >
                      <Plus data-icon="inline-start" aria-hidden="true" />
                      {t("emergency.monitor.monitorState")}
                    </Button>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="nws-zone">
                      {t("emergency.monitor.zoneLabel")}
                    </FieldLabel>
                    <NativeSelect
                      id="nws-zone"
                      className="w-full"
                      value={selectedZone}
                      disabled={
                        !editable || !selectedArea || zoneOptions.isLoading
                      }
                      onChange={(event) => setSelectedZone(event.target.value)}
                    >
                      <NativeSelectOption value="">
                        {zoneOptions.isLoading
                          ? t("emergency.monitor.loadingLocations")
                          : t("emergency.monitor.locationPlaceholder")}
                      </NativeSelectOption>
                      {zoneOptions.data?.items.map((item) => (
                        <NativeSelectOption key={item.id} value={item.id}>
                          {t("emergency.monitor.zoneWithType", {
                            name: item.name,
                            type:
                              item.type === "county"
                                ? t("emergency.monitor.county")
                                : t("emergency.monitor.forecastZone"),
                          })}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="w-fit"
                      disabled={
                        !editable ||
                        !selectedZone ||
                        zones.includes(selectedZone)
                      }
                      onClick={() => {
                        setZones(addUnique(zones, selectedZone));
                        setSelectedZone("");
                      }}
                    >
                      <Plus data-icon="inline-start" aria-hidden="true" />
                      {t("emergency.monitor.addLocation")}
                    </Button>
                    {zoneOptions.isError && (
                      <FieldError>
                        {t("emergency.monitor.zonesError")}
                      </FieldError>
                    )}
                  </Field>
                </div>
                <div
                  className="flex flex-wrap items-center gap-1.5"
                  aria-label={t("emergency.monitor.monitoredLocations")}
                >
                  {areas.map((area) => (
                    <Badge key={area} variant="secondary" className="pr-0.5">
                      {t("emergency.monitor.entireState", {
                        name: areaName(area),
                      })}
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        className="size-4 rounded-full"
                        aria-label={t("emergency.monitor.removeState", {
                          name: areaName(area),
                        })}
                        disabled={!editable}
                        onClick={() =>
                          setAreas(areas.filter((item) => item !== area))
                        }
                      >
                        <X aria-hidden="true" />
                      </Button>
                    </Badge>
                  ))}
                  {zones.map((zone) => (
                    <Badge key={zone} variant="secondary" className="pr-0.5">
                      {zoneLabel(zone, zoneOptions.data?.items ?? [], t)}
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        className="size-4 rounded-full"
                        aria-label={t("emergency.monitor.removeZone", {
                          name: zone,
                        })}
                        disabled={!editable}
                        onClick={() =>
                          setZones(zones.filter((item) => item !== zone))
                        }
                      >
                        <X aria-hidden="true" />
                      </Button>
                    </Badge>
                  ))}
                  {areas.length + zones.length === 0 && (
                    <span className="text-sm text-muted-foreground">
                      {t("emergency.monitor.noLocations")}
                    </span>
                  )}
                </div>
              </FieldSet>
              <FieldSeparator />
              <Field>
                <FieldLabel htmlFor="nws-interval">
                  {t("emergency.monitor.pollLabel")}
                </FieldLabel>
                <NativeSelect
                  id="nws-interval"
                  value={pollInterval}
                  disabled={!editable}
                  onChange={(event) =>
                    setPollInterval(Number(event.target.value))
                  }
                >
                  <NativeSelectOption value={60}>
                    {t("emergency.monitor.intervals.oneMinute")}
                  </NativeSelectOption>
                  <NativeSelectOption value={120}>
                    {t("emergency.monitor.intervals.twoMinutes")}
                  </NativeSelectOption>
                  <NativeSelectOption value={300}>
                    {t("emergency.monitor.intervals.fiveMinutes")}
                  </NativeSelectOption>
                  <NativeSelectOption value={900}>
                    {t("emergency.monitor.intervals.fifteenMinutes")}
                  </NativeSelectOption>
                </NativeSelect>
                <FieldDescription>
                  {t("emergency.monitor.pollHint")}
                </FieldDescription>
              </Field>
            </FieldGroup>
            {errorText(saveMonitor.error ?? poll.error) && (
              <Alert variant="destructive">
                <AlertDescription>
                  {errorText(saveMonitor.error ?? poll.error)}
                </AlertDescription>
              </Alert>
            )}
            {monitor && (
              <dl className="grid grid-cols-2 gap-3 rounded-xl bg-muted/50 p-4 text-sm sm:grid-cols-4">
                {[
                  {
                    term: t("emergency.monitor.lastSuccess"),
                    value: dateText(
                      monitor.lastSuccessAt,
                      locale,
                      t("emergency.monitor.never"),
                    ),
                  },
                  {
                    term: t("emergency.monitor.lastAttempt"),
                    value: dateText(
                      monitor.lastPolledAt,
                      locale,
                      t("emergency.monitor.never"),
                    ),
                  },
                  {
                    term: t("emergency.monitor.matchedRules"),
                    value: String(monitor.lastMatchedCount),
                  },
                  {
                    term: t("emergency.monitor.health"),
                    value:
                      monitor.lastErrorCode || t("emergency.monitor.healthy"),
                  },
                ].map(({ term, value }) => (
                  <div key={term} className="grid gap-0.5">
                    <dt className="text-xs text-muted-foreground">{term}</dt>
                    <dd className="font-medium">{value}</dd>
                  </div>
                ))}
              </dl>
            )}
          </CardContent>
          <CardFooter className="flex-wrap gap-2">
            <Button
              type="button"
              disabled={!editable || saveMonitor.isPending}
              onClick={() => saveMonitor.mutate()}
            >
              {saveMonitor.isPending && (
                <Spinner data-icon="inline-start" aria-hidden="true" />
              )}
              {t("emergency.monitor.saveMonitor")}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={!editable || poll.isPending}
              onClick={() => poll.mutate()}
            >
              {poll.isPending
                ? t("emergency.monitor.checking")
                : t("emergency.monitor.checkNow")}
            </Button>
          </CardFooter>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>
              <h2>{t("emergency.rules.title")}</h2>
            </CardTitle>
            <CardDescription>
              {t("emergency.rules.description")}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-5">
            {(settings.data?.rules.length ?? 0) > 0 && (
              <ItemGroup className="gap-2">
                {(settings.data?.rules ?? []).map((item) => (
                  <Item key={item.id} variant="outline" size="sm">
                    <ItemContent>
                      <ItemTitle>
                        {item.name}
                        <Badge variant={item.enabled ? "default" : "secondary"}>
                          {item.enabled
                            ? t("emergency.rules.enabledBadge")
                            : t("emergency.rules.disabledBadge")}
                        </Badge>
                      </ItemTitle>
                      <ItemDescription>
                        {item.eventNames.join(", ") ||
                          t("emergency.rules.allEventTypes")}{" "}
                        · {item.minimumSeverity}+ ·{" "}
                        {emergencyDisplayLabel(item, t)}
                      </ItemDescription>
                    </ItemContent>
                    {editable && (
                      <ItemActions>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setEditing(item.id);
                            const input = toInput(item);
                            reset(input);
                            setEventNamesText(input.eventNames.join(", "));
                          }}
                        >
                          {t("common:actions.edit")}
                        </Button>
                        <Button
                          type="button"
                          variant="destructive"
                          size="sm"
                          onClick={() => {
                            void confirm({
                              title: t("emergency.rules.deleteTitle", {
                                name: item.name,
                              }),
                              action: t("common:actions.delete"),
                              destructive: true,
                            }).then((ok) => {
                              if (ok) removeRule.mutate(item.id);
                            });
                          }}
                        >
                          {t("common:actions.delete")}
                        </Button>
                      </ItemActions>
                    )}
                  </Item>
                ))}
              </ItemGroup>
            )}
            {editable && (
              <form
                className="grid gap-5 rounded-xl border border-border p-4"
                onSubmit={(event) => void submitRule(event)}
              >
                <h3 className="text-base font-medium">
                  {editing
                    ? t("emergency.rules.formTitleEdit")
                    : t("emergency.rules.formTitleAdd")}
                </h3>
                <FieldGroup>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field data-invalid={Boolean(ruleErrors.name)}>
                      <FieldLabel htmlFor="nws-rule-name">
                        {t("emergency.rules.nameLabel")}
                      </FieldLabel>
                      <Input
                        id="nws-rule-name"
                        maxLength={180}
                        aria-invalid={Boolean(ruleErrors.name)}
                        {...register("name")}
                      />
                      <FieldError errors={[ruleErrors.name]} />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="nws-rule-events">
                        {t("emergency.rules.eventsLabel")}
                      </FieldLabel>
                      <Input
                        id="nws-rule-events"
                        value={eventNamesText}
                        // i18n-ignore: NWS event names are English by definition
                        placeholder="Tornado Warning, Flash Flood Warning"
                        onChange={(event) =>
                          setEventNamesText(event.target.value)
                        }
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="nws-rule-severity">
                        {t("emergency.rules.severityLabel")}
                      </FieldLabel>
                      <NativeSelect
                        id="nws-rule-severity"
                        className="w-full"
                        {...register("minimumSeverity")}
                      >
                        {severityOptions.map((value) => (
                          <NativeSelectOption key={value} value={value}>
                            {t(severityKeys[value])}
                          </NativeSelectOption>
                        ))}
                      </NativeSelect>
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="nws-rule-urgency">
                        {t("emergency.rules.urgencyLabel")}
                      </FieldLabel>
                      <NativeSelect
                        id="nws-rule-urgency"
                        className="w-full"
                        {...register("minimumUrgency")}
                      >
                        {urgencyOptions.map((value) => (
                          <NativeSelectOption key={value} value={value}>
                            {t(urgencyKeys[value])}
                          </NativeSelectOption>
                        ))}
                      </NativeSelect>
                    </Field>
                  </div>
                  <Field>
                    <FieldLabel htmlFor="nws-rule-display">
                      {t("emergency.rules.displayLabel")}
                    </FieldLabel>
                    <NativeSelect
                      id="nws-rule-display"
                      className="w-full"
                      value={displayChoice(rule)}
                      onChange={(event) => {
                        const choice = event.target.value;
                        const update = {
                          shouldDirty: true,
                          shouldValidate: true,
                        } as const;
                        setValue(
                          "responseMode",
                          choice === "ticker" ? "ticker" : "takeover",
                          update,
                        );
                        setValue(
                          "presentationMode",
                          choice === "playlist" ? "playlist" : "builtin",
                          update,
                        );
                        setValue("playlistId", undefined, update);
                      }}
                    >
                      <NativeSelectOption value="builtin">
                        {t("emergency.rules.displayOptions.builtin")}
                      </NativeSelectOption>
                      <NativeSelectOption value="ticker">
                        {t("emergency.rules.displayOptions.ticker")}
                      </NativeSelectOption>
                      <NativeSelectOption value="playlist">
                        {t("emergency.rules.displayOptions.playlist")}
                      </NativeSelectOption>
                    </NativeSelect>
                    <FieldDescription>
                      {t("emergency.rules.displayHint")}
                    </FieldDescription>
                  </Field>
                  {rule.responseMode === "ticker" && (
                    <div className="grid gap-4 sm:grid-cols-3">
                      <Field>
                        <FieldLabel htmlFor="nws-ticker-placement">
                          {t("emergency.rules.tickerPlacement")}
                        </FieldLabel>
                        <NativeSelect
                          id="nws-ticker-placement"
                          className="w-full"
                          {...register("tickerDisplayMode")}
                        >
                          <NativeSelectOption value="push">
                            {t("emergency.rules.placementOptions.push")}
                          </NativeSelectOption>
                          <NativeSelectOption value="overlay">
                            {t("emergency.rules.placementOptions.overlay")}
                          </NativeSelectOption>
                        </NativeSelect>
                      </Field>
                      <Field>
                        <FieldLabel htmlFor="nws-ticker-height">
                          {t("emergency.rules.tickerHeight")}
                        </FieldLabel>
                        <NativeSelect
                          id="nws-ticker-height"
                          className="w-full"
                          {...register("tickerHeightPx", {
                            valueAsNumber: true,
                          })}
                        >
                          <NativeSelectOption value={64}>
                            {t("emergency.rules.heightOptions.compact")}
                          </NativeSelectOption>
                          <NativeSelectOption value={96}>
                            {t("emergency.rules.heightOptions.standard")}
                          </NativeSelectOption>
                          <NativeSelectOption value={140}>
                            {t("emergency.rules.heightOptions.large")}
                          </NativeSelectOption>
                          <NativeSelectOption value={200}>
                            {t("emergency.rules.heightOptions.extraLarge")}
                          </NativeSelectOption>
                        </NativeSelect>
                      </Field>
                      <Field>
                        <FieldLabel htmlFor="nws-ticker-speed">
                          {t("emergency.rules.tickerSpeed")}
                        </FieldLabel>
                        <NativeSelect
                          id="nws-ticker-speed"
                          className="w-full"
                          {...register("tickerSpeed")}
                        >
                          <NativeSelectOption value="slow">
                            {t("emergency.rules.speedOptions.slow")}
                          </NativeSelectOption>
                          <NativeSelectOption value="medium">
                            {t("emergency.rules.speedOptions.medium")}
                          </NativeSelectOption>
                          <NativeSelectOption value="fast">
                            {t("emergency.rules.speedOptions.fast")}
                          </NativeSelectOption>
                        </NativeSelect>
                      </Field>
                    </div>
                  )}
                  {rule.presentationMode === "playlist" && (
                    <Field data-invalid={Boolean(ruleErrors.playlistId)}>
                      <FieldLabel htmlFor="nws-rule-playlist">
                        {t("emergency.rules.playlistLabel")}
                      </FieldLabel>
                      <NativeSelect
                        id="nws-rule-playlist"
                        className="w-full"
                        aria-invalid={Boolean(ruleErrors.playlistId)}
                        {...register("playlistId")}
                      >
                        <NativeSelectOption value="">
                          {t("emergency.rules.playlistPlaceholder")}
                        </NativeSelectOption>
                        {playlists.data?.items.map((item) => (
                          <NativeSelectOption
                            key={item.id}
                            value={item.id}
                            disabled={item.itemCount === 0}
                          >
                            {emergencyPlaylistLabel(item, t)}
                          </NativeSelectOption>
                        ))}
                      </NativeSelect>
                      <FieldDescription>
                        {t("emergency.rules.playlistHint")}{" "}
                        <Link to="/playlists">
                          {t("emergency.rules.playlistHintLink")}
                        </Link>
                      </FieldDescription>
                      <FieldError errors={[ruleErrors.playlistId]} />
                    </Field>
                  )}
                  <Field>
                    <FieldLabel htmlFor="nws-rule-duration">
                      {t("emergency.rules.durationLabel")}
                    </FieldLabel>
                    <NativeSelect
                      id="nws-rule-duration"
                      {...register("maximumDurationMinutes", {
                        valueAsNumber: true,
                      })}
                    >
                      <NativeSelectOption value={60}>
                        {t("emergency.rules.durationOptions.oneHour")}
                      </NativeSelectOption>
                      <NativeSelectOption value={360}>
                        {t("emergency.rules.durationOptions.sixHours")}
                      </NativeSelectOption>
                      <NativeSelectOption value={720}>
                        {t("emergency.rules.durationOptions.twelveHours")}
                      </NativeSelectOption>
                      <NativeSelectOption value={1440}>
                        {t("emergency.rules.durationOptions.day")}
                      </NativeSelectOption>
                    </NativeSelect>
                  </Field>
                  <FieldSeparator />
                  <TargetChecklist
                    legend={t("emergency.rules.targetScreens")}
                    items={screens.data?.items ?? []}
                    selected={rule.screenIds}
                    onToggle={(id) =>
                      setValue("screenIds", toggle(rule.screenIds, id), {
                        shouldDirty: true,
                        shouldValidate: true,
                      })
                    }
                    error={ruleErrors.screenIds?.message}
                    emptyLabel={t("emergency.rules.targetsEmpty")}
                  />
                  <TargetChecklist
                    legend={t("emergency.rules.targetGroups")}
                    items={groups.data?.items ?? []}
                    selected={rule.groupIds}
                    onToggle={(id) =>
                      setValue("groupIds", toggle(rule.groupIds, id), {
                        shouldDirty: true,
                        shouldValidate: true,
                      })
                    }
                    emptyLabel={t("emergency.rules.targetsEmpty")}
                  />
                  <FieldSeparator />
                  <Field orientation="horizontal">
                    <Switch
                      id="nws-rule-enabled"
                      checked={rule.enabled}
                      onCheckedChange={(next) =>
                        setValue("enabled", next, { shouldDirty: true })
                      }
                    />
                    <FieldLabel htmlFor="nws-rule-enabled">
                      {t("emergency.rules.enableRule")}
                    </FieldLabel>
                  </Field>
                </FieldGroup>
                {errorText(saveRule.error) && (
                  <Alert variant="destructive">
                    <AlertDescription>
                      {errorText(saveRule.error)}
                    </AlertDescription>
                  </Alert>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button type="submit" disabled={saveRule.isPending}>
                    {saveRule.isPending && (
                      <Spinner data-icon="inline-start" aria-hidden="true" />
                    )}
                    {editing
                      ? t("emergency.rules.saveRule")
                      : t("emergency.rules.addRuleButton")}
                  </Button>
                  {editing && (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => {
                        setEditing(undefined);
                        reset(emptyRule);
                        setEventNamesText(emptyRule.eventNames.join(", "));
                      }}
                    >
                      {t("common:actions.cancel")}
                    </Button>
                  )}
                </div>
              </form>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>
              <h2>{t("emergency.active.title")}</h2>
            </CardTitle>
            <CardDescription>
              {t("emergency.active.description")}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {(settings.data?.activeAlerts.length ?? 0) === 0 ? (
              <Empty className="py-6">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <CloudSun aria-hidden="true" />
                  </EmptyMedia>
                  <EmptyTitle>{t("emergency.active.emptyTitle")}</EmptyTitle>
                  <EmptyDescription>
                    {t("emergency.active.emptyBody")}
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <ItemGroup className="gap-2">
                {settings.data?.activeAlerts.map((item) => (
                  <Item
                    key={`${item.alertId}:${item.ruleId}`}
                    variant="outline"
                    size="sm"
                  >
                    <ItemMedia variant="icon">
                      <Siren aria-hidden="true" />
                    </ItemMedia>
                    <ItemContent>
                      <ItemTitle>{item.event}</ItemTitle>
                      <ItemDescription>
                        {item.headline || item.areaDescription}
                      </ItemDescription>
                    </ItemContent>
                    <ItemActions>
                      <Badge variant="destructive">{item.severity}</Badge>
                    </ItemActions>
                  </Item>
                ))}
              </ItemGroup>
            )}
          </CardContent>
        </Card>
      </main>
    </>
  );
}

/** A labelled checkbox list for one kind of alert target. */
function TargetChecklist({
  legend,
  items,
  selected,
  onToggle,
  error,
  emptyLabel,
}: {
  legend: string;
  items: Array<{ id: string; name: string }>;
  selected: string[];
  onToggle: (id: string) => void;
  error?: string;
  emptyLabel: string;
}) {
  return (
    <FieldSet data-invalid={Boolean(error)}>
      <FieldLegend variant="label">{legend}</FieldLegend>
      {items.length === 0 ? (
        <FieldDescription>{emptyLabel}</FieldDescription>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((item) => (
            <Field key={item.id} orientation="horizontal">
              <Checkbox
                id={`nws-target-${item.id}`}
                checked={selected.includes(item.id)}
                onCheckedChange={() => onToggle(item.id)}
              />
              <FieldLabel
                htmlFor={`nws-target-${item.id}`}
                className="font-normal"
              >
                {item.name}
              </FieldLabel>
            </Field>
          ))}
        </div>
      )}
      {error && <FieldError>{error}</FieldError>}
    </FieldSet>
  );
}

const addUnique = (items: string[], value: string) =>
  value && !items.includes(value) ? [...items, value] : items;
const areaName = (code: string) =>
  nwsAreas.find(([area]) => area === code)?.[1] ?? code;
const zoneLabel = (
  id: string,
  items: Array<{ id: string; name: string; type: string }>,
  t: TFunction<"alerts">,
) => {
  const zone = items.find((item) => item.id === id);
  return zone
    ? t("emergency.monitor.zoneWithType", {
        name: zone.name,
        type:
          zone.type === "county"
            ? t("emergency.monitor.county")
            : t("emergency.monitor.forecastZone"),
      })
    : id;
};
const labels = (value: string) =>
  value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
const toggle = (items: string[], value: string) =>
  items.includes(value)
    ? items.filter((item) => item !== value)
    : [...items, value];
const dateText = (value: string | undefined, locale: string, never: string) =>
  value ? new Date(value).toLocaleString(locale) : never;
const errorText = (error: unknown) =>
  error instanceof ApiError
    ? error.message
    : error instanceof Error
      ? error.message
      : "";
export const emergencyPlaylistLabel = (
  playlist: Pick<Playlist, "name" | "itemCount">,
  t: TFunction<"alerts">,
) =>
  playlist.itemCount === 0
    ? t("emergency.playlist.empty", { name: playlist.name })
    : t("emergency.playlist.count", {
        name: playlist.name,
        count: playlist.itemCount,
      });
/**
 * One select covers both of the rule's display decisions, because to an operator
 * they are one decision: what an alert does to the screen. `responseMode` and
 * `presentationMode` stay separate in the API — a ticker is not a kind of
 * presentation — and this collapses them for the form and expands them back.
 */
const displayChoice = (
  rule: Pick<NWSAlertRule, "responseMode" | "presentationMode">,
) => (rule.responseMode === "ticker" ? "ticker" : rule.presentationMode);

export const emergencyDisplayLabel = (
  rule: Pick<
    NWSAlertRule,
    "responseMode" | "presentationMode" | "playlistName"
  >,
  t: TFunction<"alerts">,
) => {
  if (rule.responseMode === "ticker")
    return t("emergency.displaySummary.ticker");
  if (rule.presentationMode === "builtin")
    return t("emergency.displaySummary.builtin");
  return rule.playlistName || t("emergency.displaySummary.noPlaylist");
};

const toInput = (rule: NWSAlertRule): NWSAlertRuleInput => ({
  name: rule.name,
  enabled: rule.enabled,
  eventNames: rule.eventNames,
  minimumSeverity: rule.minimumSeverity,
  minimumUrgency: rule.minimumUrgency,
  responseMode: rule.responseMode,
  presentationMode: rule.presentationMode,
  playlistId: rule.playlistId,
  tickerDisplayMode: rule.tickerDisplayMode,
  tickerHeightPx: rule.tickerHeightPx,
  tickerSpeed: rule.tickerSpeed,
  maximumDurationMinutes: rule.maximumDurationMinutes,
  screenIds: rule.screenIds,
  groupIds: rule.groupIds,
});
