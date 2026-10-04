# Notifications

Tilecast records a problem in Activity. Notifications tell a person about it
when nobody has Studio open.

Tilecast sends by email and by webhook. It has no per-service integrations. To
reach a chat service, point a webhook at a relay you control.

## What Tilecast sends

Notifications follow the incident model. An incident opens one time. It absorbs
repeats. It recovers when the evidence says the condition ended.

A screen that drops out ten times sends two messages: one when the incident
opens and one when it recovers. It does not send ten messages.

Tilecast sends these categories:

| Category         | Condition                                                                                                            |
| ---------------- | -------------------------------------------------------------------------------------------------------------------- |
| Screen problems  | A screen stops reporting, playback fails, storage is full, a Player enters safe mode, or an update fails             |
| Content problems | A Data Source serves stale data, or a playlist has nothing available to play. See [Content health](#content-health). |
| Backups          | A scheduled backup completes or fails                                                                                |
| Player updates   | An update deployment completes or fails                                                                              |

A recovery message is always sent at `info` severity. It goes to the people who
received the message that opened the condition. Nobody is woken to be told that
a screen came back.

## Set up email

Email needs an SMTP relay. Set it in the server environment, not in Studio. A
password saved through Studio would be stored in the database, in every backup,
and in the configuration export.

| Variable                             | Default    | Purpose                                                    |
| ------------------------------------ | ---------- | ---------------------------------------------------------- |
| `TILECAST_SMTP_HOST`                 | empty      | Relay host name. Email is off while this is empty.         |
| `TILECAST_SMTP_PORT`                 | `587`      | Relay port                                                 |
| `TILECAST_SMTP_USERNAME`             | empty      | Leave empty for a relay that needs no sign-in              |
| `TILECAST_SMTP_PASSWORD`             | empty      | Password for the user name above                           |
| `TILECAST_SMTP_TLS`                  | `starttls` | `starttls`, `implicit`, or `none`                          |
| `TILECAST_SMTP_ALLOW_INSECURE`       | `false`    | Accepts a relay certificate no public authority signed     |
| `TILECAST_SMTP_ALLOW_PLAINTEXT_AUTH` | `false`    | Sends the user name and password without encryption at all |

Tilecast refuses to continue without encryption when `TILECAST_SMTP_TLS` is
`starttls` and the relay does not offer STARTTLS. Set `none` to accept an
unencrypted relay on the same host.

The last two are separate on purpose. A district that runs its own certificate
authority needs the first, and needs it often. The second puts a mail password on
the wire in readable text, which is a different decision with a different
consequence, so turning on the first does not turn on the second. If a relay
needs a sign-in and offers no encryption, either set
`TILECAST_SMTP_ALLOW_PLAINTEXT_AUTH=true` deliberately, or leave
`TILECAST_SMTP_USERNAME` empty and let the relay accept mail from this host
without a sign-in.

Restart the server after you change these values.

Then open **Settings**, **Notifications** and:

1. Turn on **Send notifications**.
2. Set a **From address** the relay accepts.
3. Choose a **Minimum severity**.

Each person then opens **My Account**, **Preferences**, **Notifications** and sets an
address and what to receive. Nobody is subscribed until they choose it. An
account with no address is never emailed.

Use **Send a test to myself** to check the relay. The test ignores quiet hours
and subscriptions, and it shows the relay error when one occurs.

## Timing

**Immediate** sends each condition as it happens. **Digest** collects
conditions and sends one message at the daily digest time.

Quiet hours hold a message until quiet hours end. Several held messages for one
address arrive as one message.

A `critical` condition is always sent immediately. It ignores quiet hours and
the digest.

## Webhooks

An Owner or Administrator adds a webhook under **Settings**, **Notifications**.

Tilecast posts JSON with `POST`. HTTPS is required unless the receiver is on
the local network. Tilecast does not follow redirects.

Each request carries these headers:

| Header                 | Value          |
| ---------------------- | -------------- |
| `X-Tilecast-Signature` | `sha256=<hex>` |
| `X-Tilecast-Timestamp` | Unix seconds   |

Compute the signature as `HMAC-SHA256(secret, timestamp + "." + body)`. Compare
it with a constant-time comparison. Reject a request when the timestamp is not
recent. The timestamp is inside the signed value, so a captured request cannot
be replayed with a new header.

The body has this shape:

```json
{
  "event": "incident:8f3c...:opened",
  "category": "incident",
  "severity": "error",
  "title": "Screen stopped reporting - Cafeteria",
  "message": "The Player stopped reporting within the expected heartbeat window.",
  "occurredAt": "2026-03-04T12:00:00Z",
  "data": {
    "incidentId": "8f3c...",
    "incidentType": "connectivity",
    "transition": "opened",
    "screenId": "...",
    "screenName": "Cafeteria",
    "studioPath": "/activity/incidents"
  }
}
```

Fields can be added later. Fields are not removed and are not reused for a
different purpose.

### The signing secret

Tilecast shows the signing secret one time, when you add the webhook. It is not
returned by any other endpoint. Copy it then.

The secret is stored so that Tilecast can sign each request. It is the second
recoverable secret in the schema, after TOTP. It is never written to a log, to
audit metadata, or to the settings export. It grants nothing in Tilecast. It
only lets a receiver prove that a request came from this installation.

To replace a secret, add a new webhook and remove the old one.

## Retries and the delivery log

A failed delivery is retried with a growing delay, up to six attempts. A
permanent failure is not retried. A rejected address, a URL that no longer
parses, and a `4xx` from a receiver are permanent.

**Settings**, **Notifications** shows the recent delivery log. It records what
Tilecast tried to send and what happened. A row marked failed means the message
did not arrive.

Delivery rows are removed after the retention period. Pending rows are kept.

## Content health

**Activity**, **Content Health** reports content that is degrading quietly. A
board that shows last week's lunch menu is online, playing, and compliant. Only
the content is wrong, and nothing else in Tilecast reports it.

Two of these are conditions, so they open an incident and reach notifications:

- **A Data Source is not refreshing.** Screens keep showing the cached copy.
  The condition starts after `Stale Data Source after` hours without a
  successful refresh. Set it to suit the feed: a weather feed tolerates far
  less than a semester calendar. Only a Data Source that a Widget uses opens
  this incident. The report also lists stale sources without a Widget consumer.
- **A playlist has nothing to play.** The playlist is assigned to a screen, and
  everything in it has expired, is not available yet, or was removed. A tag
  playlist is evaluated through its tags.

Two are reported but never open an incident, because neither is a fault:

- **Media expiring soon**, within `Warn about expiring media` days.
- **Screens with nothing assigned**, which show the no-content message.

The incident sweep uses the release definition catalog for Widget source references.
It follows nested repeating groups and managed App source ownership.
It ignores IDs in ordinary text fields and references from deleted Widgets.
It does not inspect Data Source content payloads.

Both conditions recover on their own. A Data Source recovers when it refreshes.
A playlist recovers when it has content again, or when no screen is assigned to
it any more.

## Known limitations

- Tilecast does not send SMS, push notifications, or per-service chat messages.
- Tilecast does not confirm that a message was read. It records that the relay
  or the receiver accepted it.
- History is not sent. Conditions recorded before notifications were turned on
  are never mailed, and neither is a transition older than 24 hours. Both stay
  in Activity.
- Notifications report a condition that Tilecast can measure. A Player that
  cannot detect a fault reports nothing, and no message is sent. See
  [Activity](activity.md#known-limitations).
- Content health reports what the server can see. It does not confirm that the
  content is correct, only that it is present and recent.
- One installation serves one organization. Notification settings are
  organization-wide.
