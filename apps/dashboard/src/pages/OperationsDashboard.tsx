import { useQuery } from "@tanstack/react-query";
import { Content } from "@react-spectrum/s2/Content";
import { Heading } from "@react-spectrum/s2/Heading";
import { IllustratedMessage } from "@react-spectrum/s2/IllustratedMessage";
import { Link } from "@react-spectrum/s2/Link";
import { LinkButton } from "@react-spectrum/s2/LinkButton";
import { LabeledValue } from "@react-spectrum/s2/LabeledValue";
import { Meter } from "@react-spectrum/s2/Meter";
import { StatusLight } from "@react-spectrum/s2/StatusLight";
import { Text } from "@react-spectrum/s2/Text";
import {
  Cell,
  Column,
  Row,
  TableBody,
  TableHeader,
  TableView,
} from "@react-spectrum/s2/TableView";
import { style } from "@react-spectrum/s2/style" with { type: "macro" };
import type { Schedule, Screen, ScreenStatus } from "../api/types";
import { api } from "../api/client";
import { FleetUptimePanel } from "../components/FleetUptimePanel";

const pageStyles = style({
  display: "grid",
  gap: 24,
  width: "full",
  maxWidth: 1440,
  marginX: "auto",
});

const pageHeaderStyles = style({
  display: "flex",
  flexWrap: "wrap",
  alignItems: "end",
  justifyContent: "space-between",
  gap: 16,
});

const overviewGridStyles = style({
  display: "grid",
  gridTemplateColumns: {
    default: "minmax(0, 1fr)",
    lg: "minmax(0, 1.15fr) minmax(20rem, 0.85fr)",
  },
  gap: 16,
  alignItems: "start",
});

const columnStyles = style({ display: "grid", gap: 16, minWidth: 0 });

const regionStyles = style({
  display: "grid",
  gap: 16,
  minWidth: 0,
  padding: 20,
  borderWidth: 1,
  borderColor: "gray-200",
  borderRadius: "lg",
  backgroundColor: "base",
});

const attentionRegionStyles = style({
  display: "grid",
  gap: 16,
  minWidth: 0,
  padding: 20,
  borderWidth: 1,
  borderColor: "negative",
  borderRadius: "lg",
  backgroundColor: "base",
});

const regionHeaderStyles = style({
  display: "flex",
  flexWrap: "wrap",
  alignItems: "start",
  justifyContent: "space-between",
  gap: 12,
});

const metricGridStyles = style({
  display: "grid",
  gridTemplateColumns: { default: "repeat(2, minmax(0, 1fr))", sm: "repeat(4, minmax(0, 1fr))" },
  gap: 16,
});

const statusListStyles = style({ display: "grid", gap: 12 });

const statusRowStyles = style({
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) auto",
  alignItems: "center",
  gap: 16,
  paddingBlock: 8,
  borderBottomWidth: 1,
  borderColor: "gray-200",
});

const statusRowCopyStyles = style({ display: "grid", gap: 4, minWidth: 0 });

const metricStatusStyles = style({ display: "flex", alignItems: "center", gap: 8 });

const tableStyles = style({
  width: "full",
  minWidth: 880,
  height: 440,
});

const tableWrapStyles = style({ width: "full", overflowX: "auto" });

const scheduleDetailsStyles = style({ display: "grid", gap: 8 });

const statusLabels: Record<ScreenStatus, string> = {
  online: "Online",
  recent: "Recently online",
  stale: "Stale",
  offline: "Offline",
  disabled: "Disabled",
  revoked: "Pairing revoked",
};

const statusVariants: Record<ScreenStatus, "positive" | "notice" | "negative" | "neutral"> = {
  online: "positive",
  recent: "notice",
  stale: "notice",
  offline: "negative",
  disabled: "neutral",
  revoked: "negative",
};

export function OperationsDashboard() {
  const screens = useQuery({
    queryKey: ["screens"],
    queryFn: api.screens,
    refetchInterval: 10_000,
  });
  const schedules = useQuery({
    queryKey: ["schedules"],
    queryFn: () => api.schedules(),
  });

  const allScreens = screens.data?.items ?? [];
  const online = allScreens.filter((screen) => screen.status === "online");
  const needsAttention = allScreens.filter((screen) => screen.status !== "online");
  const onAir = online.filter((screen) => Boolean(screen.nowPlayingName));
  const enabledSchedules = (schedules.data?.items ?? []).filter(
    (schedule) => schedule.enabled,
  );
  const nextChange = nextScheduleChange(enabledSchedules);
  return (
    <main className={pageStyles}>
      <header className={pageHeaderStyles}>
        <div>
          <Heading level={1}>Overview</Heading>
          <Text>Player health, what is on air, and the next scheduled change.</Text>
        </div>
        <LinkButton href="/screens/pair" variant="primary">
          Pair screen
        </LinkButton>
      </header>

      <section className={regionStyles} aria-labelledby="fleet-health-heading">
        <div className={regionHeaderStyles}>
          <div>
            <Heading id="fleet-health-heading" level={2}>
              Fleet health
            </Heading>
            <Text>Live connection status across your Tilecast players.</Text>
          </div>
          <Link href="/screens">Manage screens</Link>
        </div>
        {screens.isLoading ? (
          <Text>Loading player status…</Text>
        ) : screens.isError ? (
          <StatusLight variant="negative">
            Player status could not be loaded. Refresh or check the server connection.
          </StatusLight>
        ) : (
          <>
            <div className={metricGridStyles}>
              <div className={metricStatusStyles}>
                <StatusLight variant={needsAttention.length === 0 ? "positive" : "notice"}>
                  {needsAttention.length === 0 ? "All reporting" : "Attention needed"}
                </StatusLight>
              </div>
              <LabeledValue label="Online" value={online.length} />
              <LabeledValue label="Need attention" value={needsAttention.length} />
              <LabeledValue label="Enabled schedules" value={enabledSchedules.length} />
            </div>
            {allScreens.length > 0 && (
              <Meter
                aria-label="Players currently online"
                label="Players online"
                value={online.length}
                maxValue={allScreens.length}
                variant={online.length === allScreens.length ? "positive" : "notice"}
              />
            )}
          </>
        )}
      </section>

      <div className={overviewGridStyles}>
        <section className={regionStyles} aria-labelledby="on-air-heading">
          <div className={regionHeaderStyles}>
            <div>
              <Heading id="on-air-heading" level={2}>
                On air now
              </Heading>
              <Text>Current presentations reported by online players.</Text>
            </div>
            <Link href="/screens">All screens</Link>
          </div>
          {screens.isLoading ? (
            <Text>Loading current playback…</Text>
          ) : screens.isError ? (
            <StatusLight variant="negative">Current playback is unavailable.</StatusLight>
          ) : onAir.length === 0 ? (
            <IllustratedMessage>
              <Heading>No active playback reported</Heading>
              <Content>
                Online players appear here after they report a playlist or presentation.
              </Content>
            </IllustratedMessage>
          ) : (
            <div className={statusListStyles}>
              {onAir.slice(0, 6).map((screen) => (
                <ScreenSummary key={screen.id} screen={screen} />
              ))}
            </div>
          )}
        </section>

        <div className={columnStyles}>
          <section className={regionStyles} aria-labelledby="coming-up-heading">
            <div className={regionHeaderStyles}>
              <div>
                <Heading id="coming-up-heading" level={2}>
                  Coming up
                </Heading>
                <Text>Next enabled playback transition.</Text>
              </div>
              <Link href="/schedules">Schedules</Link>
            </div>
            {schedules.isLoading ? (
              <Text>Loading schedules…</Text>
            ) : schedules.isError ? (
              <StatusLight variant="negative">Schedules could not be loaded.</StatusLight>
            ) : nextChange ? (
              <div className={scheduleDetailsStyles}>
                <Link href={`/schedules/${nextChange.schedule.id}`}>
                  {nextChange.schedule.name}
                </Link>
                <Text>{formatScheduleTime(nextChange.at)}</Text>
                <Text>
                  {nextChange.schedule.playlistName} · {targetLabel(nextChange.schedule)}
                </Text>
              </div>
            ) : (
              <Text>No upcoming schedule change. Current assignments continue playing.</Text>
            )}
          </section>
          <FleetUptimePanel />
        </div>
      </div>

      <section className={attentionRegionStyles} aria-labelledby="needs-attention-heading">
        <div className={regionHeaderStyles}>
          <div>
            <Heading id="needs-attention-heading" level={2}>
              Needs attention
            </Heading>
            <Text>Players that are not currently reporting an online connection.</Text>
          </div>
          <Link href="/screens">Review fleet</Link>
        </div>
        {screens.isLoading ? (
          <Text>Checking player state…</Text>
        ) : screens.isError ? (
          <StatusLight variant="negative">Player attention state is unavailable.</StatusLight>
        ) : needsAttention.length === 0 ? (
          <StatusLight variant="positive">All paired players are online.</StatusLight>
        ) : (
          <div className={statusListStyles}>
            {needsAttention.slice(0, 8).map((screen) => (
              <ScreenSummary key={screen.id} screen={screen} />
            ))}
          </div>
        )}
      </section>

      <section className={regionStyles} aria-labelledby="player-fleet-heading">
        <div className={regionHeaderStyles}>
          <div>
            <Heading id="player-fleet-heading" level={2}>
              Player fleet
            </Heading>
            <Text>Connection state, playback, location, player version, and last contact.</Text>
          </div>
          <LinkButton href="/screens" variant="secondary">
            Open screens
          </LinkButton>
        </div>
        <div className={tableWrapStyles}>
          <TableView
            aria-label="Player fleet"
            styles={tableStyles}
            density="compact"
            loadingState={screens.isLoading ? "loading" : undefined}
          >
            <TableHeader>
              <Column id="screen" isRowHeader>
                Screen
              </Column>
              <Column id="status">Status</Column>
              <Column id="playing">Now playing</Column>
              <Column id="location">Location</Column>
              <Column id="player">Player</Column>
              <Column id="last-seen">Last seen</Column>
            </TableHeader>
            <TableBody
              items={allScreens}
              renderEmptyState={() => (
                <IllustratedMessage>
                  <Heading>No screens paired</Heading>
                  <Content>Pair a Tilecast Player to start monitoring your fleet.</Content>
                </IllustratedMessage>
              )}
            >
              {(screen) => (
                <Row id={screen.id} href={`/screens/${screen.id}`}>
                  <Cell>{screen.name}</Cell>
                  <Cell>
                    <StatusLight variant={statusVariants[screen.status]}>
                      {statusLabels[screen.status]}
                    </StatusLight>
                  </Cell>
                  <Cell>{screen.nowPlayingName || "Nothing assigned"}</Cell>
                  <Cell>{screen.location || "Not set"}</Cell>
                  <Cell>
                    {screen.platform} · {screen.playerVersion || "Version unknown"}
                    {screen.updateState ? ` · ${humanize(screen.updateState)}` : ""}
                  </Cell>
                  <Cell>{formatRelative(screen.lastContactAt)}</Cell>
                </Row>
              )}
            </TableBody>
          </TableView>
        </div>
      </section>
    </main>
  );
}

function ScreenSummary({ screen }: { screen: Screen }) {
  return (
    <div className={statusRowStyles}>
      <div className={statusRowCopyStyles}>
        <Link href={`/screens/${screen.id}`}>
          {screen.name}
        </Link>
        <Text>
          {screen.nowPlayingName || screen.location || "No location set"}
        </Text>
      </div>
      <StatusLight variant={statusVariants[screen.status]}>
        {statusLabels[screen.status]}
      </StatusLight>
    </div>
  );
}

function formatRelative(value?: string) {
  if (!value) return "Never";
  const seconds = Math.max(
    0,
    Math.round((Date.now() - new Date(value).getTime()) / 1000),
  );
  if (seconds < 60) return "Just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function nextScheduleChange(schedules: Schedule[]) {
  const now = new Date();
  const candidates: { schedule: Schedule; at: Date }[] = [];
  for (const schedule of schedules) {
    if (schedule.type === "one_time" && schedule.oneTimeStart) {
      const at = new Date(schedule.oneTimeStart);
      if (at > now) candidates.push({ schedule, at });
      continue;
    }
    if (!schedule.dailyStart || schedule.daysOfWeek.length === 0) continue;
    const [hour = 0, minute = 0] = schedule.dailyStart.split(":").map(Number);
    for (let offset = 0; offset < 8; offset += 1) {
      const at = new Date(now);
      at.setDate(now.getDate() + offset);
      at.setHours(hour, minute, 0, 0);
      if (at > now && schedule.daysOfWeek.includes(at.getDay())) {
        candidates.push({ schedule, at });
        break;
      }
    }
  }
  return candidates.sort((a, b) => a.at.getTime() - b.at.getTime())[0];
}

function targetLabel(schedule: Schedule) {
  if (schedule.targets.length === 0) return "no targets";
  if (schedule.targets.length === 1)
    return schedule.targets[0]?.name ?? "1 target";
  return `${schedule.targets.length} targets`;
}

function formatScheduleTime(value: Date) {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(value);
}

function humanize(value: string) {
  return value
    .replaceAll("_", " ")
    .replace(/^./, (letter) => letter.toUpperCase());
}
