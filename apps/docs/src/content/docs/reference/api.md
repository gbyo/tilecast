---
title: HTTP API overview
description: Understand Tilecast API paths, authentication boundaries, and response formats.
---

Tilecast's application API is served by Tilecast Server. Most application routes are under `/api/v1`. Use the health routes and platform provisioning URLs for their specific purpose; they are not general application API routes.

## Response format

Successful JSON responses wrap their result in `data`:

```json
{ "data": {} }
```

Errors use an `error` object with a machine-readable `code` and a human-readable `message`:

```json
{
  "error": {
    "code": "machine_readable_code",
    "message": "Human-readable explanation."
  }
}
```

The HTTP status carries the success or failure result. Do not infer success from the presence of a response body alone.

## Use the right authentication

Tilecast has separate credentials for each kind of client. One credential cannot be used in another client's place.

| Client               | Authentication                                                             | Purpose                                                           |
| -------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Studio browser       | Server session cookie; unsafe requests also send the session's CSRF token. | User actions in Tilecast Studio.                                  |
| Tilecast Player      | `Authorization: Bearer tc_device_<public-id>.<secret>`                     | Authenticated Player communication after pairing and enrollment.  |
| External integration | `Authorization: Bearer tci_<public-id>.<secret>`                           | The specific capability granted when the Owner created the token. |

Integration tokens are intentionally limited. The supported capabilities are **Write Manual Table rows** and **Read fleet health**. They do not provide general Studio access. See [Create an integration token](../../integrations/tokens/) for token lifecycle and [supported integration requests](../../integrations/) for examples.

## Health and readiness

- `GET /healthz` checks that the server process responds.
- `GET /readyz` returns ready only when the database and media storage/processing tools are available. It returns `503` when those dependencies are unavailable or a restore is in progress.

Use these endpoints for service health checks. They do not authenticate as a Studio user or Player.

## OpenAPI description

For route schemas and request fields, use the repository's [OpenAPI YAML](https://github.com/gbyo/tilecast/blob/main/docs/openapi.yaml). Human-written integration workflows are on [Integrations](../../integrations/); Player setup and pairing are on [Players](../../players/).
