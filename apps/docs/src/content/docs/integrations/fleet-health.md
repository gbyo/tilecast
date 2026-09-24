---
title: Read fleet health from another system
description: Scrape Tilecast health counts as Prometheus metrics or read them as JSON.
---

Use the **Read fleet health** capability to connect Tilecast to monitoring you already run. The endpoints return installation-wide counts, not a screen list or playback history.

Create a token with **Read fleet health** in **Settings** > **Integration tokens**, then send it in the `Authorization` header. See [Create an integration token](../tokens/).

## JSON summary

Request `GET /api/v1/integration/activity/fleet`:

```sh
curl --fail-with-body "$TILECAST_URL/api/v1/integration/activity/fleet" \
  -H "Authorization: Bearer $TILECAST_INTEGRATION_TOKEN"
```

The response wraps `data` with:

| Field                                            | Meaning                                                  |
| ------------------------------------------------ | -------------------------------------------------------- |
| `generatedAt`                                    | Time Tilecast generated this summary.                    |
| `screens.total`                                  | Screens with an active Player credential.                |
| `screens.recent`, `stale`, `offline`, `disabled` | Counts by last reported contact or administrative state. |
| `incidents.open`, `acknowledged`, `bySeverity`   | Unresolved incident counts.                              |
| `content.staleDataSources`, `emptyPlaylists`     | Active content health conditions.                        |

`recent` means a Player reported within the last two minutes; `stale` means the last report was more than two and no more than fifteen minutes ago. This endpoint does not report a live **Online** count because the server's active Player connections are not available to this database summary. Use **Screens** > **Fleet** for per-screen connection status, or [Activity](../../operations/activity/) for reports and history.

## Prometheus metrics

Request `GET /api/v1/integration/metrics` with the same token. Tilecast returns Prometheus text exposition with these metric families:

| Metric                          | Labels                                                | Meaning                                   |
| ------------------------------- | ----------------------------------------------------- | ----------------------------------------- |
| `tilecast_screens`              | `state` = `recent`, `stale`, `offline`, or `disabled` | Screen counts by reporting state.         |
| `tilecast_screens_total`        | none                                                  | Screens with an active Player credential. |
| `tilecast_incidents_unresolved` | `severity`                                            | Open and acknowledged incidents.          |
| `tilecast_content_problems`     | `kind` = `stale_data_source` or `empty_playlist`      | Active content health conditions.         |

The token needs the **Read fleet health** capability. A missing, expired, revoked, or incorrect token returns `401 invalid_token`; a token without that capability returns `403 insufficient_scope`.
