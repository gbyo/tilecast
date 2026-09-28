export type NWSAlertMonitor = {
  enabled: boolean;
  areas: string[];
  zones: string[];
  pollIntervalSeconds: number;
  lastPolledAt?: string;
  lastSuccessAt?: string;
  lastErrorCode?: string;
  lastMatchedCount: number;
  updatedAt: string;
};

export type NWSAlertRule = {
  id: string;
  name: string;
  enabled: boolean;
  eventNames: string[];
  minimumSeverity: "Minor" | "Moderate" | "Severe" | "Extreme";
  minimumUrgency: "Unknown" | "Future" | "Expected" | "Immediate";
  /**
   * How a matching alert reaches the screen: `takeover` replaces what is playing
   * and restores it afterwards, `ticker` leaves playback running and shows the
   * alert as a bar along the bottom.
   */
  responseMode: "takeover" | "ticker";
  presentationMode: "builtin" | "playlist";
  playlistId?: string;
  playlistName?: string;
  tickerDisplayMode: "overlay" | "push";
  tickerHeightPx: number;
  tickerSpeed: "slow" | "medium" | "fast";
  maximumDurationMinutes: number;
  screenIds: string[];
  groupIds: string[];
  createdAt: string;
  updatedAt: string;
};

export type NWSZone = {
  id: string;
  name: string;
  state: string;
  type: "county" | "forecast";
};

export type NWSAlertRuleInput = Omit<
  NWSAlertRule,
  "id" | "playlistName" | "createdAt" | "updatedAt"
>;

export type NWSAlertActivation = {
  alertId: string;
  ruleId: string;
  ruleName: string;
  event: string;
  headline: string;
  severity: string;
  urgency: string;
  areaDescription: string;
  expiresAt?: string;
  takeoverId?: string;
  firstSeenAt: string;
  lastSeenAt: string;
};

export type NWSAlertSettings = {
  monitor: NWSAlertMonitor;
  rules: NWSAlertRule[];
  activeAlerts: NWSAlertActivation[];
};

export type Playlist = { id: string; name: string; itemCount: number };
export type TargetItem = { id: string; name: string };
