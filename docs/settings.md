# Settings and player policies

Tilecast separates deployment configuration, organization settings, group policies, screen overrides, and user preferences. Deployment values remain environment-controlled and secret values or sensitive paths are never returned by the API.

The typed registry in `apps/server/internal/settings/registry.go` is closed: every key has a stable name, scope, type, default, validation, application timing, and documentation metadata. Unknown keys and keys used at the wrong scope are rejected. Runtime values remain bounded by deployment hard limits.

## Policy precedence

Effective player values resolve in this order:

1. Screen override.
2. Matching sync-group policy.
3. Organization player default.
4. Built-in Tilecast default.

Because each screen belongs to at most one sync group, group-policy conflict precedence is no longer exposed in Studio. Studio’s effective-policy view shows every value and source plus organization, sync group, screen, and final configuration revisions.

## Player configuration

`GET /api/v1/player/config` is device-authenticated and independent of content manifests. Schema v1 has a monotonic per-screen revision and stable ETag. It contains effective branding, playback, cache, synchronization, website, reliability, power, Android Managed Kiosk, Linux kiosk, and accessibility policy only—never inheritance metadata, credentials, unrelated groups, or deployment paths.

### Regional formatting

The organization settings `organization.locale`, `organization.timezone`, `organization.date_format`, `organization.time_format`, and `organization.first_day_of_week` describe the installation's regional behavior for signage and organization-owned data. The locale is a validated, canonical BCP-47 tag, not a list of shipped Studio translation languages. The timezone is an IANA identifier. `first_day_of_week=locale` derives its value from CLDR week data; explicit weekday choices remain available. New installations default to Sunday. On upgrade, an installation with no stored weekday receives an explicit Monday value to preserve the prior Player's `current_week` boundary; an administrator's already-stored choice is retained. Administrators can choose `locale` to adopt CLDR week data.

The effective player-config v1 document adds an optional `playback.regionalFormat` object with locale, timezone, date and time preferences, and a resolved weekday. This is additive inside the schema's extensible playback section. Older v1 Players ignore it and remain usable; new Players receiving a response from an older Server use their documented legacy formatting fallback. Regional settings writes keep the existing configuration and manifest revision invalidation path.

New Clock, Date, and World Clock widgets use the organization format and timezone when their corresponding choice is blank or `locale`. Explicit widget time/date choices and explicit IANA timezones still win, and existing saved choices are preserved. The new Player's fallback for an older Server matches its previous behavior (Linux's legacy `en-US`/UTC defaults or Android's device locale/timezone); this fallback is not used when the organization profile is present.

Regional formatting is separate from `preference.language`: that user setting controls the current person's Studio interface, while this profile controls signage and organization-level week/date semantics. A widget's explicit format overrides the organization setting. A currency code is semantic field metadata (ISO 4217), never inferred from locale. See [localization](localization.md#regional-formatting) for the boundary between formatting and translating interface strings.

Location address components are optional, region-neutral fields. Studio labels locality, administrative area, and postal code without validating a US ZIP shape or forcing a `city, state ZIP` display. Database and API names such as `state` remain stable for compatibility. See [Structured Sources](structured-sources.md#regional-addresses) for the display policy and the W3C guidance it follows.

Reliability, power, and accessibility keys are policy-scoped and follow the same screen/group/organization/built-in inheritance. Both players implement watchdog and recovery behavior, while platform-specific controls are grouped separately in Studio. `reliability.playback_stall_seconds` controls motion-required media and `reliability.webview_stall_seconds` controls the first meaningful website render; both Android and Linux apply those authoritative values. Android Managed Kiosk settings remain capability-gated: for example, `reliability.mode=managed_kiosk` remains effectively `standard` until Android confirms active lock task. Linux kiosk settings control the Electron fullscreen window and desktop display-sleep blocker; boot startup and process restart remain the responsibility of the installed systemd service. Active-hour local times and IANA timezone identifiers are validated; package allowlists accept only bounded Android application IDs. See [reliability and power](reliability-and-power.md).

The power-assist fields `power.startup_grace_seconds`, `power.shutdown_prepare_seconds`, `power.keep_screen_on`, and `power.sleep_outside_active_hours` are Android-only. Linux reports its host display-control capability and uses `linux_kiosk.prevent_display_sleep`, systemd, and its branded off-hours presentation instead; it does not silently reinterpret those Android power-assist values as operating-system sleep commands.

Players preserve the current and previous valid configuration in Room, validate before activation, reconcile periodically, and react to lightweight `config.changed` notifications. Item-specific playlist settings continue to win over player defaults. Invalid configuration preserves the previous valid revision and reports a safe error.

### Playback defaults and item delegation

The supported playback defaults are `defaultVolume`, `defaultFitMode`, `defaultImageDurationSeconds`, `defaultTransition`, `defaultAudioEnabled`, and `resumeAfterRestart`. A playlist item with `usePlayerDefaults: true` delegates those fields to the effective Player configuration; an item with the flag omitted or false keeps its authored values. This delegation is applied by Android and Linux for fullscreen items and playlist zones, including image duration, fit, transition, audio, and volume. Website settings are separate: authoring fields may inherit organization website defaults, while the effective Player policy supplies timeout and cookie policy at runtime.

`clearOnRestart` is a startup-only website action. Each Player evaluates it once per application process and clears the website partitions only during that startup reconciliation; a later configuration revision never clears cookies or site storage during active playback. Linux reports display-control capability explicitly; display-control schedules are not assignable to Android screens until Android has a matching capability.

Raw HDMI-CEC is not a supported Android player setting. Android Power Assist uses the platform's bounded sleep/wake behavior, while Linux Display Control is capability-reported and separately managed. The former `power.cec_assist_enabled` write-only setting is no longer exposed or included in effective PlayerConfig.

The registry intentionally does not expose scheduling keys that have no runtime effect. Scheduling defaults are the typed schedule fields and the production resolver's built-in precedence, not hidden write-only policy values.

## Sign-in security

`security.mfa_required_scope` is an organization-scoped enum: `none`, `administrators`, or `all`. It controls who must enroll a second factor, not how anyone signs in — enrollment itself is always available to every account from **My Account → Sign-in security**. A malformed or unknown stored value is read as `none`, so a bad value cannot lock an installation out.

Enforcement is a session flag, not a login refusal. A covered account with no factor is admitted with its session marked as owing one; that session reaches only the enrollment endpoints until a factor exists, and the flag clears in place. See [multi-factor authentication](multi-factor-authentication.md).

## Import, export, and maintenance

Owner exports contain schema version, timestamp, Tilecast version, organization settings, and group policy metadata. They exclude passwords, sessions, device credentials, connection strings, signing keys, website state, media files, and user preferences. Import requires validation, preview, confirmation, revision checking, and audit.

Retention values are typed and bounded, and cover raw Player events, proof-of-play sessions, screen-state intervals, audit logs, detailed diagnostic metadata, and telemetry rollups. Telemetry rollups are the only telemetry dataset that accumulates — the snapshot is one row per screen updated in place and raw samples are never stored — so they are the only one with a retention bound. See [Activity retention](activity.md#retention) for defaults and hard limits.

Maintenance routes are fixed actions; they cannot execute shell commands, SQL supplied by users, restart services, or install software.
