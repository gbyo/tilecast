# ADR: Takeover priority classes

Status: proposed. This record changes the Takeover contract. The
implementation must update `docs/api.md`, `docs/openapi/core.yaml`,
`docs/plugins.md`, the Emergency Alerts plugin documentation, and the public
Takeover pages in the same change.

## Context

A Takeover replaces normal playback on its target screens. Operators start
Takeovers from Studio. Emergency Alerts starts Takeovers from National Weather
Service alerts. Plugins start Takeovers through `Host.Takeovers`, and
packages start them through `takeovers.manage@1`.

### Behavior on `main`

`apps/server/internal/takeovers/service.go`, `ActivateInTx`:

1. The Server takes one advisory lock for all activations.
2. The Server selects every active Takeover that has a non-terminal state on
   any target screen of the new Takeover.
3. The Server sets each of those Takeovers to `cancelled` with the reason
   "Replaced by another Takeover". It writes the audit action
   `takeover.replaced`.
4. The Server sets the state of the replaced Takeovers to `restored` on
   **every** screen, also on screens that the new Takeover does not target.
   Those screens return to normal playback.

The service has no priority. The newest activation wins on every screen of
every Takeover that it touches.

Emergency Alerts (`plugins/emergency-alerts/server/activation.go`) keeps one
`alert_activations` row for each alert and rule. While the row is not
cleared, each poll updates the row and calls `RefreshInTx` on the stored
Takeover. The poll does not activate a new Takeover. When a cancelled
Takeover ends, `CancelInTx` returns `ErrTakeoverInactive`, and the plugin
treats that as expected.

### Effect

An operator starts a routine Takeover on one lobby screen while a severe
weather Takeover is active on 50 screens. The severe weather Takeover is
cancelled on all 50 screens. The alert stays active in the feed, but no
screen shows it again until the alert ends and a new alert arrives.

Any plugin or package that can start a Takeover has the same effect. Future
plugins, such as scoreboard sponsor slides and school lockdown integrations,
make the problem more likely.

### Player side

The Player manifest carries one `takeover` object, and the legacy `emergency`
object, for each screen. `crates/player-core/src/schedule.rs` selects the
Takeover before schedules and direct assignment. The Player never sees two
Takeovers. Priority can therefore be decided on the Server alone.

## Decision

### 1. Classes

Each Takeover has one class. The classes are ordered from strongest to
weakest:

| Class         | Use                                                                                                 | Who can start it                                                     |
| ------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `life_safety` | Lockdown, shelter, evacuation, and fire instructions from a life-safety integration.                | Nobody yet. See section 4.                                           |
| `emergency`   | Severe weather and other public warnings.                                                           | Emergency Alerts, a bundled plugin that declares it, or an operator. |
| `operator`    | A Takeover that an operator starts in Studio. This is the default.                                  | An operator with `screen.assign`.                                    |
| `automation`  | A Takeover that a rule, a plugin, or a package starts for routine reasons, such as a sponsor slide. | A plugin or package, up to its declared maximum class.               |

### 2. Precedence on each screen

- An activation never cancels another Takeover.
- For each screen, the Server computes the effective Takeover: the active
  Takeover with the strongest class, then the latest activation time, then
  the highest ID.
- A Takeover that is active but not effective on a screen is suspended on
  that screen. It stays effective on its other screens.
- Suspension is derived from the rule. It is not a stored screen state.
  Players write `takeover_screen_states.state` for the Takeover that they
  show, so a stored `suspended` value could be overwritten by a late Player
  report.
- When the effective Takeover ends on a screen, the next active Takeover
  becomes effective there. Cancellation and expiry already revise the
  manifest of each screen that they touch.
- Expiry, cancellation, and refresh change only the Takeover that they name.

The Player manifest still carries one `takeover` object: the effective one.
Players do not change.

### 3. Replacing a stronger class

An operator can start a Takeover with a weaker class on a screen where a
stronger class is effective. The new Takeover is then suspended on that
screen.

- Before activation, Studio warns when an active Takeover of a stronger
  class exists.
- The activation response reports `suspendedCount`, the number of target
  screens where the new Takeover waits.

To show a weaker Takeover over a stronger one, the operator must cancel the
stronger Takeover. Cancelling an `emergency` or `life_safety` Takeover needs
a reason. The audit event records the reason.

An operator can start an `emergency` Takeover. Studio asks for a
confirmation, and the audit event records the class.

### 4. Plugins and packages

- `plugin.TakeoverRequest` gains `Class`. For a plugin, an empty class is
  `automation`.
- A plugin raises its maximum class with the optional Server interface
  `plugin.TakeoverClassCeiling`. A manifest member is not used, because
  Plugin API v1 manifests are frozen. Without the interface, the maximum is
  `automation`. The host refuses a request above the maximum with
  `ErrInvalid`.
- No plugin and no Studio operator can request `life_safety` yet.
  `plugin.CheckDeclarations` refuses it as a maximum, and the host refuses it
  in a request. The first life-safety integration adds the Owner setting
  that enables it.
- `takeovers.manage@1` for packages sends only `automation`.
- Emergency Alerts declares `emergency` and sends it on each activation.

### 5. Emergency Alerts after this change

Because an activation never cancels another Takeover, an NWS Takeover is no
longer lost. The special case for `ErrTakeoverInactive` in `activation.go`
stays for Takeovers that an operator cancels.

When an operator cancels an NWS Takeover while the alert is still active,
the alert stays cancelled on purpose. The plugin must not start it again for
the same alert and rule. The rule page shows the cancellation and its reason.

### 6. Storage and migration

- A core migration adds `takeovers.class text NOT NULL DEFAULT 'operator'`
  with a check for the four classes.
- An Emergency Alerts migration sets `class = 'emergency'` for each Takeover
  that an `alert_activations` row references. Core migrations do not read
  plugin tables.
- The activation audit event records `class` and `suspendedScreenCount` in
  its metadata.
- The action `takeover.replaced` is no longer written. Old audit rows keep
  it.

One package, `internal/takeovers/precedence`, holds the rule as SQL
fragments. Manifest generation, the screen list, the activation path, and
the Takeover API use it.

### 7. Activity

A suspended Takeover is not shown, so it adds no proof-of-play time. The
existing rule that excludes Takeover time from playback compliance applies
to the effective Takeover only.

### 8. Studio

- The Takeover list shows the class of each Takeover and the number of
  screens where it is suspended. Playing, preparing, and failed counts
  include only screens where it is effective.
- A Takeover detail shows, for each screen, whether the Takeover is
  suspended, and the Takeover that suspends it.
- The activation dialog offers `operator` and `emergency`. An `emergency`
  activation needs a confirmation.

## Tests

- An `operator` Takeover on one screen does not change an `emergency`
  Takeover on its other screens.
- An `operator` Takeover on a screen with an effective `emergency` Takeover
  is suspended there. It becomes effective when the `emergency` Takeover
  ends.
- Two Takeovers of the same class: the later one is effective on the shared
  screens. The earlier one stays effective on its other screens and becomes
  effective again on the shared screens when the later one ends.
- A stronger Takeover outranks an earlier weaker one, and the weaker one is
  shown again when the stronger one expires.
- A plugin request above its maximum class fails. A `life_safety` maximum
  fails the declaration check.
- Emergency Alerts: an operator Takeover during an active alert does not
  cancel the alert Takeover.
- Manifest generation and the activation path agree on the effective
  Takeover for each screen. One table-driven test drives both.

## Consequences

- An emergency or life-safety message cannot be lost because another
  Takeover starts.
- Operators can no longer replace an emergency message by accident. They
  must cancel it with a reason.
- The behavior of two `operator` Takeovers changes. Before, the newer one
  cancelled the older one everywhere. Now the older one continues on the
  screens that the newer one does not target. Studio must explain this, and
  the release notes must name it.
- The Player contract does not change.

## Rejected alternatives

- **A numeric priority for each Takeover.** Free numbers drift. Plugins would
  compete with higher numbers. Four named classes are reviewable.
- **Keep newest-wins and let Emergency Alerts start its Takeover again on
  each poll.** The alert would still disappear until the next poll, and an
  operator Takeover would still cancel it on unrelated screens.
- **Send all active Takeovers to the Player and let the Player decide.** It
  changes the Player protocol on four hosts for a decision that the Server
  can make alone.
