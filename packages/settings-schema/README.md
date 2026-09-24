# Tilecast settings schema

`player-config-v1.json` is the player-facing effective configuration contract. Administrative inheritance details never cross this boundary. Stable setting definitions are owned by the closed Go registry in `apps/server/internal/settings/registry.go`; Studio consumes definitions from the authenticated API and Android consumes only the effective contract.

The optional `playback.regionalFormat` object is an additive v1 extension. `playback` intentionally permits unknown properties, so existing v1 Players may ignore the object while continuing to validate and apply the rest of the configuration. New Players use it when present. A new Player receiving a configuration from an older Server, which omits the object, keeps its documented legacy rendering fallback; it must not infer the organization from the device or browser locale. Keep the root schema closed and do not bump `schemaVersion` solely to add this optional profile.

`regionalFormat` carries organization-owned `locale` (canonical BCP-47), `timezone` (IANA), `dateFormat`, `timeFormat`, and resolved `firstDayOfWeek`. It is distinct from `preference.language`, which selects the current person's Studio interface language. Explicit content metadata such as an ISO 4217 currency code continues to determine the meaning of a value; locale controls presentation only.
