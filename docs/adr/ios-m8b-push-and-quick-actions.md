# ADR: push notifications, App Intents, and screen quick actions for iOS Milestone 8B

Status: proposed. This note records the constraints and the options. It does not choose one. Milestone 8B makes the decision.

## Context

Milestone 8A adds system share, semantic haptics, deep links, and native media intake. It does not add push notifications, notification actions, App Intents, Shortcuts, or screen quick actions.

Milestone 8B may add them. Two facts limit the design, and one fact helps it.

- **One APNs identity.** An official Tilecast iOS app has one Apple bundle identifier and one Apple Push Notification service (APNs) identity. Only the holder of the APNs authentication key (a `.p8` key of the Apple developer team) can send a push notification to that app. A device token is valid for one app and one environment (sandbox or production).
- **Self-hosting.** A self-hosted Tilecast Server cannot receive the private APNs provider key of the official app. If it did, every server operator could send a push notification to every person who uses the app, and Tilecast could not take the key back from one operator.
- **What exists.** The server has stable screen commands (identify, synchronization, and Player restart). It records incidents in Activity, and it sends email and webhooks for them (see [Notifications](../notifications.md)). Milestone 3 gave native code a bearer-authenticated API client. Milestone 8A gave the app one deep-link resolver, `StudioHost.open(_:)`, and a set of `system/*` bridge messages.

The product must stay self-hostable without a proprietary cloud dependency. Tilecast has one organization for each installation.

## Options

### A. An optional Tilecast-operated push relay

The Tilecast project runs a relay service. It holds the APNs key of the official app. A server registers with the relay, and the relay sends the push notification to APNs.

- **Privacy.** The relay sees a device token, an opaque installation identifier, and a timestamp. It must not see the content of an incident. A design that meets this sends a payload with no content and a category. A Notification Service Extension then fetches the details from the person's own server with the native credential. The relay stores no message.
- **Self-hosting.** The server works without the relay. Push is an optional feature that the operator turns on. An operator who does not want a project-run service leaves it off.
- **Operational dependency.** The project takes on uptime, key custody, abuse handling, rate limits, cost, and a privacy policy that a school or a government office can accept. When the relay is down, no push notification arrives. Email and webhooks continue.
- **Device tokens.** The app sends the token to its own server with the native credential. The server sends it to the relay with a per-installation secret that it got at registration. Sign-out and revocation of the grant delete the token at the server, and the server tells the relay to forget it.
- **Open source.** The relay code can be AGPL-3.0-only and self-hostable by an organization that ships its own app. The official instance is still a proprietary-cloud dependency for the people who use it, and the project must say so in the documentation.

### B. Bring your own APNs credentials, for custom-signed deployments

An organization builds and signs its own copy of the app with its own bundle identifier, and it uses its own Apple developer account. It puts its own APNs key in the server configuration. The server sends to APNs directly.

- **Privacy.** No third party sees any data. Apple sees the device token and the payload size, as it does for every push notification.
- **Self-hosting.** This fits the deployment model exactly. It has no Tilecast-operated service.
- **Operational dependency.** The organization needs an Apple developer account, a signing pipeline, and a way to distribute the app, for example a custom app in Apple Business Manager or School Manager, or an MDM. It cannot use the App Store build. This is heavy for a small church or a small nonprofit.
- **Device tokens.** The server stores the token for each native grant and deletes it at sign-out, at revocation, and when APNs reports it as invalid.
- **Secret handling.** The `.p8` key is a secret at rest in the server. It joins the TOTP secret as a credential that the server can use, so it needs the same care: no logs, no export, an environment variable or a file that the operator owns instead of the database, and a backup note. See [Multi-factor authentication](../multi-factor-authentication.md).
- **Open source.** The server code for APNs is generic. The project ships no key.

### C. No remote push: local notifications only

The app does not receive a push notification. It schedules local notifications with `UNUserNotificationCenter` for events that it can compute, and it refreshes opportunistically with a background task.

- **Privacy.** Nothing leaves the device or the server.
- **Self-hosting.** There is no new dependency.
- **Operational dependency.** None.
- **Limit.** iOS does not guarantee when a background refresh runs. The app cannot report a screen incident within a minute. It can remind a person of a time that it already knows, for example the start of a campaign that Studio scheduled.
- **Device tokens.** None.
- **Open source.** No effect.

### Comparison

| Question                        | A. Relay                 | B. Own APNs key              | C. Local only |
| ------------------------------- | ------------------------ | ---------------------------- | ------------- |
| Works with the App Store app    | Yes                      | No                           | Yes           |
| Works without a project service | No, for the official app | Yes                          | Yes           |
| Prompt delivery of an incident  | Yes                      | Yes                          | No            |
| Setup for a small organization  | A switch                 | An Apple account and a build | None          |
| Third party sees a device token | The relay operator       | Apple only                   | Nobody        |
| New secret to protect           | Per-installation secret  | The `.p8` key                | None          |

The options are not exclusive. A design can offer A for the App Store app and B for custom builds, with C as the fallback when neither is set.

## Constraints for any choice

Whatever Milestone 8B chooses, it must keep these rules from Milestone 8A and the architecture rules:

- A push payload has no secret and no incident content that the relay or a third party must not see. The app fetches details with the native credential.
- A tap on a notification builds a `DeepLink` and calls `StudioHost.open(_:)`. There is no second routing path. The resolver already refuses an unknown installation and waits for the verified Studio.
- A notification action calls the server through the generated client and the bearer transport. It does not use the Studio cookie.
- The feature uses capability negotiation and a server capability, never a version comparison. Studio still works when push is off.
- Sign-out, revocation of the grant, removal of the server, and a changed installation delete the device token at the server and at the relay when one exists.
- The Server, the relay, and the app stay usable without any proprietary cloud service.

## Quick actions and App Intents

The server has stable screen commands, and Milestone 3 makes them reachable from native code. That makes screen quick actions technically feasible. Milestone 8A does not add a native Fleet or a native Screen page, because the architecture rules keep resource management in Studio.

Milestone 8B decides which actions gain from a system surface. These are the candidates:

- **Notification actions.** An action on an incident, for example acknowledge. It needs the notification design above.
- **App Intents and Shortcuts.** A "Screen" entity with "Identify" and "Restart Player" intents. They work from Siri, Spotlight, and the Action button.
- **Spotlight entities.** Screens that a person can open from Spotlight through a deep link.
- **A small quick-action surface.** A Home Screen quick action or a widget that runs one command.

For each candidate, Milestone 8B must show a benefit that a Studio page does not give, and it must keep full Screen management in Studio. It must also decide how a destructive command (a Player restart) asks for confirmation from a Shortcut.

## Open questions for Milestone 8B

1. Does the project want to operate a relay? If it does, who holds the key, who pays, and what does the privacy policy say?
2. Is option B enough for the organizations that want push, given the cost of a custom build?
3. Does a webhook that a person points at a relay of their own already cover the need? The current notification design has no per-service integrations.
4. Which incidents deserve a push notification, and how does the person choose? The incident model must keep its rule: one message when an incident opens, and one when it recovers.
5. Which screen commands are safe for a Shortcut, and what confirmation do they need?

## Decision

Not made. Milestone 8B makes it, with the questions above answered, and updates this record.
