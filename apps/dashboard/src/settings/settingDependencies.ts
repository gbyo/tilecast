export type DependencyMessageKey =
  | "dependencies.customText"
  | "dependencies.intervalReload"
  | "dependencies.activeHours"
  | "dependencies.managedKiosk"
  | "dependencies.accessibilityAssist";
export type Dependency = {
  key: string;
  equals?: unknown;
  messageKey: DependencyMessageKey;
};
export const settingDependencies: Record<string, Dependency | Dependency[]> = {
  "power.active_hours_timezone": activeHours(),
  "power.active_hours_days": activeHours(),
  "power.active_hours_start": activeHours(),
  "power.active_hours_end": activeHours(),
  "power.startup_grace_seconds": activeHours(),
  "power.shutdown_prepare_seconds": activeHours(),
  "power.keep_screen_on": activeHours(),
  "power.sleep_outside_active_hours": activeHours(),
  "power.outside_active_hours_display": activeHours(),
  "power.outside_active_hours_text": [
    activeHours(),
    {
      key: "power.outside_active_hours_display",
      equals: "custom_text",
      messageKey: "dependencies.customText",
    },
  ],
  "managed_kiosk.lock_task_enabled": kiosk(),
  "managed_kiosk.block_overlays": kiosk(),
  "managed_kiosk.allow_settings_during_admin": kiosk(),
  "managed_kiosk.admin_session_minutes": kiosk(),
  "accessibility.return_delay_seconds": accessibility(),
  "accessibility.allowed_packages": accessibility(),
  "accessibility.pause_during_updates": accessibility(),
  "accessibility.pause_during_admin_session": accessibility(),
  "accessibility.report_foreground_package": accessibility(),
  "accessibility.maximum_returns": accessibility(),
  "accessibility.return_window_minutes": accessibility(),
  "website.minimum_refresh_seconds": {
    key: "website.default_reload_policy",
    equals: "interval",
    messageKey: "dependencies.intervalReload",
  },
};
function activeHours(): Dependency {
  return {
    key: "power.active_hours_enabled",
    equals: true,
    messageKey: "dependencies.activeHours",
  };
}
function kiosk(): Dependency {
  return {
    key: "reliability.mode",
    equals: "managed_kiosk",
    messageKey: "dependencies.managedKiosk",
  };
}
function accessibility(): Dependency {
  return {
    key: "accessibility.control_assist_enabled",
    equals: true,
    messageKey: "dependencies.accessibilityAssist",
  };
}
export function dependencyState(
  key: string,
  values: Record<string, unknown>,
):
  | { disabled: true; messageKey: DependencyMessageKey }
  | { disabled: false; messageKey?: undefined } {
  const configured = settingDependencies[key];
  if (!configured) return { disabled: false };
  const dependencies = Array.isArray(configured) ? configured : [configured];
  const unmet = dependencies.find((dependency) => {
    const expected = dependency.equals ?? true;
    return values[dependency.key] !== expected;
  });
  return unmet
    ? { disabled: true, messageKey: unmet.messageKey }
    : { disabled: false };
}
