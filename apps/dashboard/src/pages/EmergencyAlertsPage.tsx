import { useEffect, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { useForm } from "react-hook-form";
import { Link } from "react-router";
import { z } from "zod";
import { api, ApiError } from "../api/client";
import type { NWSAlertRule, NWSAlertRuleInput, Playlist } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { Notice, PageHeader } from "../components/legacy-ui";

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
    <main className="page plugins-page">
      <PageHeader
        eyebrow={
          <Link className="back-link" to="/plugins">
            <ArrowLeft size={15} /> Plugins
          </Link>
        }
        title="Emergency Alerts"
        description="Watch official NWS weather alerts and take matching screens over automatically, then restore normal playback when the alert clears."
      />
      {!editable && (
        <Notice>
          Owner or Administrator access is required to make changes.
        </Notice>
      )}
      <div className="settings-sections takeover-settings">
        <section className="settings-subsection">
          <header>
            <h3>Prepare automatic emergency content</h3>
            <p>
              Tilecast can generate a fullscreen alert directly from live NWS
              data. A custom playlist remains optional for organizations with
              their own response content. This plugin configures automatic
              responses; a manual Takeover is the separate “show this now”
              action on Screens, and its defaults live in Settings.
            </p>
          </header>
          <div className="takeover-settings__actions">
            <Link className="button button--quiet" to="/playlists">
              Optional: manage custom playlists
            </Link>
            <Link className="button button--quiet" to="/screens">
              Start a Takeover now
            </Link>
            <Link
              className="button button--quiet"
              to="/settings/operations/takeover"
            >
              Takeover and command defaults
            </Link>
          </div>
        </section>

        <section className="settings-subsection">
          <header>
            <h3>Automated weather alerts</h3>
            <p>
              Monitor official active alerts for US states, territories,
              counties, and forecast zones. Matching rules display live alert
              details or an optional custom playlist, then restore normal
              playback when the alert clears.
            </p>
          </header>
          <div className="notice notice--info">
            <strong>
              Alert delivery is best-effort, not a life-safety system.
            </strong>
            <p>
              Keep local emergency procedures and Wireless Emergency Alerts in
              place. Studio shows poll health so upstream or network failures
              are visible.
            </p>
          </div>
          <div className="setting-row">
            <div className="setting-copy">
              <label htmlFor="nws-enabled">Automated NWS monitoring</label>
              <p>Disabled by default. A configured rule is required to act.</p>
            </div>
            <div className="setting-control">
              <input
                id="nws-enabled"
                type="checkbox"
                checked={enabled}
                disabled={!editable}
                onChange={(event) => setEnabled(event.target.checked)}
              />
            </div>
          </div>
          <div className="setting-row setting-row--location-picker">
            <div className="setting-copy">
              <label htmlFor="nws-state">Alert coverage</label>
              <p>
                Choose a state or territory by name, then monitor the whole
                state or add specific counties and NWS forecast zones.
              </p>
            </div>
            <div className="setting-control nws-location-picker">
              <label>
                State or territory
                <select
                  id="nws-state"
                  value={selectedArea}
                  disabled={!editable}
                  onChange={(event) => {
                    setSelectedArea(event.target.value);
                    setSelectedZone("");
                  }}
                >
                  <option value="">Select a state</option>
                  {nwsAreas.map(([code, name]) => (
                    <option key={code} value={code}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="button button--quiet"
                disabled={
                  !editable || !selectedArea || areas.includes(selectedArea)
                }
                onClick={() => setAreas(addUnique(areas, selectedArea))}
              >
                Monitor entire state
              </button>
              <label>
                County or forecast zone
                <select
                  value={selectedZone}
                  disabled={!editable || !selectedArea || zoneOptions.isLoading}
                  onChange={(event) => setSelectedZone(event.target.value)}
                >
                  <option value="">
                    {zoneOptions.isLoading
                      ? "Loading locations…"
                      : "Select a location"}
                  </option>
                  {zoneOptions.data?.items.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name} (
                      {item.type === "county" ? "County" : "Forecast zone"})
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="button button--quiet"
                disabled={
                  !editable || !selectedZone || zones.includes(selectedZone)
                }
                onClick={() => {
                  setZones(addUnique(zones, selectedZone));
                  setSelectedZone("");
                }}
              >
                Add location
              </button>
              {zoneOptions.isError && (
                <small className="form-error" role="alert">
                  Counties and forecast zones could not be loaded from NWS.
                </small>
              )}
              <div className="nws-location-picker__selected">
                {areas.map((area) => (
                  <span key={area}>
                    Entire {areaName(area)}
                    <button
                      type="button"
                      aria-label={`Remove entire ${areaName(area)}`}
                      disabled={!editable}
                      onClick={() =>
                        setAreas(areas.filter((item) => item !== area))
                      }
                    >
                      ×
                    </button>
                  </span>
                ))}
                {zones.map((zone) => (
                  <span key={zone}>
                    {zoneLabel(zone, zoneOptions.data?.items ?? [])}
                    <button
                      type="button"
                      aria-label={`Remove ${zone}`}
                      disabled={!editable}
                      onClick={() =>
                        setZones(zones.filter((item) => item !== zone))
                      }
                    >
                      ×
                    </button>
                  </span>
                ))}
                {areas.length + zones.length === 0 && (
                  <small>No locations selected.</small>
                )}
              </div>
            </div>
          </div>
          <div className="setting-row">
            <div className="setting-copy">
              <label htmlFor="nws-interval">Poll interval</label>
              <p>
                A one- to two-minute interval is recommended for most sites.
              </p>
            </div>
            <div className="setting-control">
              <select
                id="nws-interval"
                value={pollInterval}
                disabled={!editable}
                onChange={(event) =>
                  setPollInterval(Number(event.target.value))
                }
              >
                <option value={60}>1 minute</option>
                <option value={120}>2 minutes</option>
                <option value={300}>5 minutes</option>
                <option value={900}>15 minutes</option>
              </select>
            </div>
          </div>
          <div className="takeover-settings__actions">
            <button
              type="button"
              className="button button--primary"
              disabled={!editable || saveMonitor.isPending}
              onClick={() => saveMonitor.mutate()}
            >
              {saveMonitor.isPending ? "Saving…" : "Save NWS monitor"}
            </button>
            <button
              type="button"
              className="button button--quiet"
              disabled={!editable || poll.isPending}
              onClick={() => poll.mutate()}
            >
              {poll.isPending ? "Checking…" : "Check now"}
            </button>
          </div>
          {errorText(saveMonitor.error ?? poll.error) && (
            <p className="form-error" role="alert">
              {errorText(saveMonitor.error ?? poll.error)}
            </p>
          )}
          {monitor && (
            <dl className="takeover-settings__health">
              <div>
                <dt>Last success</dt>
                <dd>{dateText(monitor.lastSuccessAt)}</dd>
              </div>
              <div>
                <dt>Last attempt</dt>
                <dd>{dateText(monitor.lastPolledAt)}</dd>
              </div>
              <div>
                <dt>Matched rules</dt>
                <dd>{monitor.lastMatchedCount}</dd>
              </div>
              <div>
                <dt>Health</dt>
                <dd>{monitor.lastErrorCode || "Healthy"}</dd>
              </div>
            </dl>
          )}
        </section>

        <section className="settings-subsection">
          <header>
            <h3>Weather event rules</h3>
            <p>
              Event names match NWS wording exactly. Leave the field empty to
              match every event at or above the selected severity and urgency.
              Tilecast's live fullscreen alert is the default; a ticker bar is
              the alternative for alerts that should inform without interrupting
              what is playing.
            </p>
          </header>
          <div className="takeover-rule-list">
            {(settings.data?.rules ?? []).map((item) => (
              <article key={item.id}>
                <div>
                  <strong>{item.name}</strong>
                  <p>
                    {item.eventNames.join(", ") || "All event types"} ·{" "}
                    {item.minimumSeverity}+ · {emergencyDisplayLabel(item)}
                  </p>
                </div>
                <div>
                  <span>{item.enabled ? "Enabled" : "Disabled"}</span>
                  {editable && (
                    <>
                      <button
                        className="button button--quiet"
                        type="button"
                        onClick={() => {
                          setEditing(item.id);
                          const input = toInput(item);
                          reset(input);
                          setEventNamesText(input.eventNames.join(", "));
                        }}
                      >
                        Edit
                      </button>
                      <button
                        className="button button--quiet"
                        type="button"
                        onClick={() => {
                          if (confirm(`Delete “${item.name}”?`))
                            removeRule.mutate(item.id);
                        }}
                      >
                        Delete
                      </button>
                    </>
                  )}
                </div>
              </article>
            ))}
          </div>
          {editable && (
            <form
              className="takeover-rule-editor"
              onSubmit={(event) => void submitRule(event)}
            >
              <h4>{editing ? "Edit rule" : "Add rule"}</h4>
              <label>
                Rule name
                <input maxLength={180} {...register("name")} />
              </label>
              {ruleErrors.name && (
                <p className="form-error" role="alert">
                  {ruleErrors.name.message}
                </p>
              )}
              <label>
                NWS event names
                <input
                  value={eventNamesText}
                  placeholder="Tornado Warning, Flash Flood Warning"
                  onChange={(event) => setEventNamesText(event.target.value)}
                />
              </label>
              <div className="takeover-rule-editor__columns">
                <label>
                  Minimum severity
                  <select {...register("minimumSeverity")}>
                    {["Minor", "Moderate", "Severe", "Extreme"].map((value) => (
                      <option key={value}>{value}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Minimum urgency
                  <select {...register("minimumUrgency")}>
                    {["Unknown", "Future", "Expected", "Immediate"].map(
                      (value) => (
                        <option key={value}>{value}</option>
                      ),
                    )}
                  </select>
                </label>
                <label>
                  Emergency display
                  <select
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
                    <option value="builtin">
                      Tilecast live NWS alert — fullscreen
                    </option>
                    <option value="ticker">
                      Tilecast live NWS alert — ticker bar
                    </option>
                    <option value="playlist">
                      Use a custom playlist — fullscreen
                    </option>
                  </select>
                  <small>
                    The built-in display automatically shows the exact NWS
                    event, headline, severity, affected area, instructions,
                    sender, and expiration. A ticker bar shows the same alert
                    text along the bottom and leaves whatever is playing on
                    screen.
                  </small>
                </label>
                {rule.responseMode === "ticker" && (
                  <>
                    <label>
                      Ticker placement
                      <select {...register("tickerDisplayMode")}>
                        <option value="push">
                          Push content up — nothing is covered
                        </option>
                        <option value="overlay">
                          Overlay — the bar covers the bottom edge
                        </option>
                      </select>
                    </label>
                    <label>
                      Ticker height
                      <select
                        {...register("tickerHeightPx", {
                          valueAsNumber: true,
                        })}
                      >
                        <option value={64}>Compact — 64px</option>
                        <option value={96}>Standard — 96px</option>
                        <option value={140}>Large — 140px</option>
                        <option value={200}>Extra large — 200px</option>
                      </select>
                    </label>
                    <label>
                      Ticker speed
                      <select {...register("tickerSpeed")}>
                        <option value="slow">Slow</option>
                        <option value="medium">Medium</option>
                        <option value="fast">Fast</option>
                      </select>
                    </label>
                  </>
                )}
                {rule.presentationMode === "playlist" && (
                  <label>
                    Custom emergency playlist
                    <select {...register("playlistId")}>
                      <option value="">Select a playlist</option>
                      {playlists.data?.items.map((item) => (
                        <option
                          key={item.id}
                          value={item.id}
                          disabled={item.itemCount === 0}
                        >
                          {emergencyPlaylistLabel(item)}
                        </option>
                      ))}
                    </select>
                    <small>
                      Only non-empty playlists can be activated.{" "}
                      <Link to="/playlists">Create or edit playlists</Link>
                    </small>
                    {ruleErrors.playlistId && (
                      <span className="form-error" role="alert">
                        {ruleErrors.playlistId.message}
                      </span>
                    )}
                  </label>
                )}
                <label>
                  Maximum duration
                  <select
                    {...register("maximumDurationMinutes", {
                      valueAsNumber: true,
                    })}
                  >
                    <option value={60}>1 hour</option>
                    <option value={360}>6 hours</option>
                    <option value={720}>12 hours</option>
                    <option value={1440}>24 hours</option>
                  </select>
                </label>
              </div>
              <fieldset>
                <legend>Target screens</legend>
                <div className="takeover-rule-editor__targets">
                  {screens.data?.items.map((item) => (
                    <label key={item.id}>
                      <input
                        type="checkbox"
                        checked={rule.screenIds.includes(item.id)}
                        onChange={() =>
                          setValue(
                            "screenIds",
                            toggle(rule.screenIds, item.id),
                            {
                              shouldDirty: true,
                              shouldValidate: true,
                            },
                          )
                        }
                      />
                      {item.name}
                    </label>
                  ))}
                </div>
              </fieldset>
              {ruleErrors.screenIds && (
                <p className="form-error" role="alert">
                  {ruleErrors.screenIds.message}
                </p>
              )}
              <fieldset>
                <legend>Target groups</legend>
                <div className="takeover-rule-editor__targets">
                  {groups.data?.items.map((item) => (
                    <label key={item.id}>
                      <input
                        type="checkbox"
                        checked={rule.groupIds.includes(item.id)}
                        onChange={() =>
                          setValue("groupIds", toggle(rule.groupIds, item.id), {
                            shouldDirty: true,
                            shouldValidate: true,
                          })
                        }
                      />
                      {item.name}
                    </label>
                  ))}
                </div>
              </fieldset>
              <label className="checkbox-control">
                <input type="checkbox" {...register("enabled")} />
                Enable this rule
              </label>
              <div className="takeover-settings__actions">
                <button
                  className="button button--primary"
                  type="submit"
                  disabled={saveRule.isPending}
                >
                  {saveRule.isPending
                    ? "Saving…"
                    : editing
                      ? "Save rule"
                      : "Add rule"}
                </button>
                {editing && (
                  <button
                    className="button button--quiet"
                    type="button"
                    onClick={() => {
                      setEditing(undefined);
                      reset(emptyRule);
                      setEventNamesText(emptyRule.eventNames.join(", "));
                    }}
                  >
                    Cancel
                  </button>
                )}
              </div>
              {errorText(saveRule.error) && (
                <p className="form-error" role="alert">
                  {errorText(saveRule.error)}
                </p>
              )}
            </form>
          )}
        </section>

        <section className="settings-subsection">
          <header>
            <h3>Active weather emergencies</h3>
            <p>Alerts currently matched to a rule and displaying content.</p>
          </header>
          {(settings.data?.activeAlerts.length ?? 0) === 0 ? (
            <p className="empty-state">No NWS alerts are currently active.</p>
          ) : (
            <div className="takeover-rule-list">
              {settings.data?.activeAlerts.map((item) => (
                <article key={`${item.alertId}:${item.ruleId}`}>
                  <div>
                    <strong>{item.event}</strong>
                    <p>{item.headline || item.areaDescription}</p>
                  </div>
                  <span>{item.severity}</span>
                </article>
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
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
