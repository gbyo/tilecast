import { useEffect, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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

const ruleSchema = z
  .object({
    name: z.string().trim().min(1, "Enter a rule name.").max(180),
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
        message: "Select a pre-made emergency playlist.",
      });
    }
    if (value.screenIds.length + value.groupIds.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["screenIds"],
        message: "Select at least one screen or group.",
      });
    }
  });

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
 * The Emergency Alerts plugin: watch official NWS alerts and take screens over
 * while one is active.
 *
 * It lives under Plugins rather than in Settings because it is not a default
 * anything — it is a feature an installation opts into and configures, in the
 * same way a Countdown Bar is. Settings keeps the manual-takeover and command
 * policy that applies whether or not this plugin is used at all.
 */
export function EmergencyAlertsPage() {
  const auth = useAuth();
  const { confirm, dialog: confirmDialog } = useConfirm();
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
              <ArrowLeft size={15} aria-hidden="true" /> Plugins
            </Link>
            <h1 className="text-2xl font-semibold tracking-tight">
              Emergency Alerts
            </h1>
            <p className="text-sm text-muted-foreground">
              Watch official NWS weather alerts and take matching screens over
              automatically, then restore normal playback when the alert clears.
            </p>
          </div>
          <PluginActionsMenu pluginId="emergency_alerts" />
        </header>
        {!editable && (
          <Alert>
            <AlertDescription>
              Owner or Administrator access is required to make changes.
            </AlertDescription>
          </Alert>
        )}
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>Prepare automatic emergency content</h2>
            </CardTitle>
            <CardDescription>
              Tilecast can generate a fullscreen alert directly from live NWS
              data. A custom playlist remains optional for organizations with
              their own response content. This plugin configures automatic
              responses; a manual Takeover is the separate “show this now”
              action on Screens, and its defaults live in Settings.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            <Link
              className={buttonVariants({ variant: "outline", size: "sm" })}
              to="/playlists"
            >
              Optional: manage custom playlists
            </Link>
            <Link
              className={buttonVariants({ variant: "outline", size: "sm" })}
              to="/screens"
            >
              Start a Takeover now
            </Link>
            <Link
              className={buttonVariants({ variant: "outline", size: "sm" })}
              to="/settings/operations/takeover"
            >
              Takeover and command defaults
            </Link>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>
              <h2>Automated weather alerts</h2>
            </CardTitle>
            <CardDescription>
              Monitor official active alerts for US states, territories,
              counties, and forecast zones. Matching rules display live alert
              details or an optional custom playlist, then restore normal
              playback when the alert clears.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-5">
            <Alert>
              <TriangleAlert aria-hidden="true" />
              <AlertTitle>
                Alert delivery is best-effort, not a life-safety system.
              </AlertTitle>
              <AlertDescription>
                Keep local emergency procedures and Wireless Emergency Alerts in
                place. Studio shows poll health so upstream or network failures
                are visible.
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
                    Automated NWS monitoring
                  </FieldLabel>
                  <FieldDescription>
                    Disabled by default. A configured rule is required to act.
                  </FieldDescription>
                </FieldContent>
              </Field>
              <FieldSeparator />
              <FieldSet>
                <FieldLegend>Alert coverage</FieldLegend>
                <FieldDescription>
                  Choose a state or territory by name, then monitor the whole
                  state or add specific counties and NWS forecast zones.
                </FieldDescription>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field>
                    <FieldLabel htmlFor="nws-state">
                      State or territory
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
                        Select a state
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
                      Monitor entire state
                    </Button>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="nws-zone">
                      County or forecast zone
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
                          ? "Loading locations…"
                          : "Select a location"}
                      </NativeSelectOption>
                      {zoneOptions.data?.items.map((item) => (
                        <NativeSelectOption key={item.id} value={item.id}>
                          {item.name} (
                          {item.type === "county" ? "County" : "Forecast zone"})
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
                      Add location
                    </Button>
                    {zoneOptions.isError && (
                      <FieldError>
                        Counties and forecast zones could not be loaded from
                        NWS.
                      </FieldError>
                    )}
                  </Field>
                </div>
                <div
                  className="flex flex-wrap items-center gap-1.5"
                  aria-label="Monitored locations"
                >
                  {areas.map((area) => (
                    <Badge key={area} variant="secondary" className="pr-0.5">
                      Entire {areaName(area)}
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        className="size-4 rounded-full"
                        aria-label={`Remove entire ${areaName(area)}`}
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
                      {zoneLabel(zone, zoneOptions.data?.items ?? [])}
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        className="size-4 rounded-full"
                        aria-label={`Remove ${zone}`}
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
                      No locations selected.
                    </span>
                  )}
                </div>
              </FieldSet>
              <FieldSeparator />
              <Field>
                <FieldLabel htmlFor="nws-interval">Poll interval</FieldLabel>
                <NativeSelect
                  id="nws-interval"
                  value={pollInterval}
                  disabled={!editable}
                  onChange={(event) =>
                    setPollInterval(Number(event.target.value))
                  }
                >
                  <NativeSelectOption value={60}>1 minute</NativeSelectOption>
                  <NativeSelectOption value={120}>2 minutes</NativeSelectOption>
                  <NativeSelectOption value={300}>5 minutes</NativeSelectOption>
                  <NativeSelectOption value={900}>
                    15 minutes
                  </NativeSelectOption>
                </NativeSelect>
                <FieldDescription>
                  A one- to two-minute interval is recommended for most sites.
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
                  ["Last success", dateText(monitor.lastSuccessAt)],
                  ["Last attempt", dateText(monitor.lastPolledAt)],
                  ["Matched rules", String(monitor.lastMatchedCount)],
                  ["Health", monitor.lastErrorCode || "Healthy"],
                ].map(([term, value]) => (
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
              Save NWS monitor
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={!editable || poll.isPending}
              onClick={() => poll.mutate()}
            >
              {poll.isPending ? "Checking…" : "Check now"}
            </Button>
          </CardFooter>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>
              <h2>Weather event rules</h2>
            </CardTitle>
            <CardDescription>
              Event names match NWS wording exactly. Leave the field empty to
              match every event at or above the selected severity and urgency.
              Tilecast&apos;s live fullscreen alert is the default; a ticker bar
              is the alternative for alerts that should inform without
              interrupting what is playing.
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
                          {item.enabled ? "Enabled" : "Disabled"}
                        </Badge>
                      </ItemTitle>
                      <ItemDescription>
                        {item.eventNames.join(", ") || "All event types"} ·{" "}
                        {item.minimumSeverity}+ · {emergencyDisplayLabel(item)}
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
                          Edit
                        </Button>
                        <Button
                          type="button"
                          variant="destructive"
                          size="sm"
                          onClick={() => {
                            void confirm({
                              title: `Delete “${item.name}”?`,
                              action: "Delete",
                              destructive: true,
                            }).then((ok) => {
                              if (ok) removeRule.mutate(item.id);
                            });
                          }}
                        >
                          Delete
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
                  {editing ? "Edit rule" : "Add rule"}
                </h3>
                <FieldGroup>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field data-invalid={Boolean(ruleErrors.name)}>
                      <FieldLabel htmlFor="nws-rule-name">Rule name</FieldLabel>
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
                        NWS event names
                      </FieldLabel>
                      <Input
                        id="nws-rule-events"
                        value={eventNamesText}
                        placeholder="Tornado Warning, Flash Flood Warning"
                        onChange={(event) =>
                          setEventNamesText(event.target.value)
                        }
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="nws-rule-severity">
                        Minimum severity
                      </FieldLabel>
                      <NativeSelect
                        id="nws-rule-severity"
                        className="w-full"
                        {...register("minimumSeverity")}
                      >
                        {["Minor", "Moderate", "Severe", "Extreme"].map(
                          (value) => (
                            <NativeSelectOption key={value}>
                              {value}
                            </NativeSelectOption>
                          ),
                        )}
                      </NativeSelect>
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="nws-rule-urgency">
                        Minimum urgency
                      </FieldLabel>
                      <NativeSelect
                        id="nws-rule-urgency"
                        className="w-full"
                        {...register("minimumUrgency")}
                      >
                        {["Unknown", "Future", "Expected", "Immediate"].map(
                          (value) => (
                            <NativeSelectOption key={value}>
                              {value}
                            </NativeSelectOption>
                          ),
                        )}
                      </NativeSelect>
                    </Field>
                  </div>
                  <Field>
                    <FieldLabel htmlFor="nws-rule-display">
                      Emergency display
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
                        Tilecast live NWS alert — fullscreen
                      </NativeSelectOption>
                      <NativeSelectOption value="ticker">
                        Tilecast live NWS alert — ticker bar
                      </NativeSelectOption>
                      <NativeSelectOption value="playlist">
                        Use a custom playlist — fullscreen
                      </NativeSelectOption>
                    </NativeSelect>
                    <FieldDescription>
                      The built-in display automatically shows the exact NWS
                      event, headline, severity, affected area, instructions,
                      sender, and expiration. A ticker bar shows the same alert
                      text along the bottom and leaves whatever is playing on
                      screen.
                    </FieldDescription>
                  </Field>
                  {rule.responseMode === "ticker" && (
                    <div className="grid gap-4 sm:grid-cols-3">
                      <Field>
                        <FieldLabel htmlFor="nws-ticker-placement">
                          Ticker placement
                        </FieldLabel>
                        <NativeSelect
                          id="nws-ticker-placement"
                          className="w-full"
                          {...register("tickerDisplayMode")}
                        >
                          <NativeSelectOption value="push">
                            Push content up — nothing is covered
                          </NativeSelectOption>
                          <NativeSelectOption value="overlay">
                            Overlay — the bar covers the bottom edge
                          </NativeSelectOption>
                        </NativeSelect>
                      </Field>
                      <Field>
                        <FieldLabel htmlFor="nws-ticker-height">
                          Ticker height
                        </FieldLabel>
                        <NativeSelect
                          id="nws-ticker-height"
                          className="w-full"
                          {...register("tickerHeightPx", {
                            valueAsNumber: true,
                          })}
                        >
                          <NativeSelectOption value={64}>
                            Compact — 64px
                          </NativeSelectOption>
                          <NativeSelectOption value={96}>
                            Standard — 96px
                          </NativeSelectOption>
                          <NativeSelectOption value={140}>
                            Large — 140px
                          </NativeSelectOption>
                          <NativeSelectOption value={200}>
                            Extra large — 200px
                          </NativeSelectOption>
                        </NativeSelect>
                      </Field>
                      <Field>
                        <FieldLabel htmlFor="nws-ticker-speed">
                          Ticker speed
                        </FieldLabel>
                        <NativeSelect
                          id="nws-ticker-speed"
                          className="w-full"
                          {...register("tickerSpeed")}
                        >
                          <NativeSelectOption value="slow">
                            Slow
                          </NativeSelectOption>
                          <NativeSelectOption value="medium">
                            Medium
                          </NativeSelectOption>
                          <NativeSelectOption value="fast">
                            Fast
                          </NativeSelectOption>
                        </NativeSelect>
                      </Field>
                    </div>
                  )}
                  {rule.presentationMode === "playlist" && (
                    <Field data-invalid={Boolean(ruleErrors.playlistId)}>
                      <FieldLabel htmlFor="nws-rule-playlist">
                        Custom emergency playlist
                      </FieldLabel>
                      <NativeSelect
                        id="nws-rule-playlist"
                        className="w-full"
                        aria-invalid={Boolean(ruleErrors.playlistId)}
                        {...register("playlistId")}
                      >
                        <NativeSelectOption value="">
                          Select a playlist
                        </NativeSelectOption>
                        {playlists.data?.items.map((item) => (
                          <NativeSelectOption
                            key={item.id}
                            value={item.id}
                            disabled={item.itemCount === 0}
                          >
                            {emergencyPlaylistLabel(item)}
                          </NativeSelectOption>
                        ))}
                      </NativeSelect>
                      <FieldDescription>
                        Only non-empty playlists can be activated.{" "}
                        <Link to="/playlists">Create or edit playlists</Link>
                      </FieldDescription>
                      <FieldError errors={[ruleErrors.playlistId]} />
                    </Field>
                  )}
                  <Field>
                    <FieldLabel htmlFor="nws-rule-duration">
                      Maximum duration
                    </FieldLabel>
                    <NativeSelect
                      id="nws-rule-duration"
                      {...register("maximumDurationMinutes", {
                        valueAsNumber: true,
                      })}
                    >
                      <NativeSelectOption value={60}>1 hour</NativeSelectOption>
                      <NativeSelectOption value={360}>
                        6 hours
                      </NativeSelectOption>
                      <NativeSelectOption value={720}>
                        12 hours
                      </NativeSelectOption>
                      <NativeSelectOption value={1440}>
                        24 hours
                      </NativeSelectOption>
                    </NativeSelect>
                  </Field>
                  <FieldSeparator />
                  <TargetChecklist
                    legend="Target screens"
                    items={screens.data?.items ?? []}
                    selected={rule.screenIds}
                    onToggle={(id) =>
                      setValue("screenIds", toggle(rule.screenIds, id), {
                        shouldDirty: true,
                        shouldValidate: true,
                      })
                    }
                    error={ruleErrors.screenIds?.message}
                  />
                  <TargetChecklist
                    legend="Target groups"
                    items={groups.data?.items ?? []}
                    selected={rule.groupIds}
                    onToggle={(id) =>
                      setValue("groupIds", toggle(rule.groupIds, id), {
                        shouldDirty: true,
                        shouldValidate: true,
                      })
                    }
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
                      Enable this rule
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
                    {editing ? "Save rule" : "Add rule"}
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
                      Cancel
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
              <h2>Active weather emergencies</h2>
            </CardTitle>
            <CardDescription>
              Alerts currently matched to a rule and displaying content.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {(settings.data?.activeAlerts.length ?? 0) === 0 ? (
              <Empty className="py-6">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <CloudSun aria-hidden="true" />
                  </EmptyMedia>
                  <EmptyTitle>No active alerts</EmptyTitle>
                  <EmptyDescription>
                    No NWS alerts are currently active.
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
}: {
  legend: string;
  items: Array<{ id: string; name: string }>;
  selected: string[];
  onToggle: (id: string) => void;
  error?: string;
}) {
  return (
    <FieldSet data-invalid={Boolean(error)}>
      <FieldLegend variant="label">{legend}</FieldLegend>
      {items.length === 0 ? (
        <FieldDescription>None available.</FieldDescription>
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
) => {
  const zone = items.find((item) => item.id === id);
  return zone
    ? `${zone.name} (${zone.type === "county" ? "County" : "Forecast zone"})`
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
const dateText = (value?: string) =>
  value ? new Date(value).toLocaleString() : "Never";
const errorText = (error: unknown) =>
  error instanceof ApiError
    ? error.message
    : error instanceof Error
      ? error.message
      : "";
export const emergencyPlaylistLabel = (
  playlist: Pick<Playlist, "name" | "itemCount">,
) =>
  playlist.itemCount === 0
    ? `${playlist.name} — empty, add content first`
    : `${playlist.name} — ${playlist.itemCount} item${playlist.itemCount === 1 ? "" : "s"}`;
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
) => {
  if (rule.responseMode === "ticker") return "Tilecast live NWS ticker bar";
  if (rule.presentationMode === "builtin") return "Tilecast live NWS alert";
  return rule.playlistName || "No playlist";
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
