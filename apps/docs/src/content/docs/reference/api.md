---
title: HTTP API overview
description: Understand Tilecast API paths, authentication boundaries, and response formats.
---

Tilecast's application API is served by Tilecast Server. Most application routes are under `/api/v1`. Use the health routes and platform provisioning URLs for their specific purpose; they are not general application API routes.

## Response format

Successful JSON responses wrap their result in `data`:

```json title="Successful response"
{ "data": {} }
```

Errors use an `error` object with a machine-readable `code` and a human-readable `message`:

```json title="Error response"
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

| Client                    | Authentication                                                             | Purpose                                                           |
| ------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Studio browser            | Server session cookie; unsafe requests also send the session's CSRF token. | User actions in Tilecast Studio.                                  |
| CLI, MCP, scripts, and CI | `Authorization: Bearer tcp_...` (personal access token) or a CLI sign-in   | User actions as the token's account, limited by its scopes.       |
| Tilecast Player           | `Authorization: Bearer tc_device_<public-id>.<secret>`                     | Authenticated Player communication after pairing and enrollment.  |
| External integration      | `Authorization: Bearer tci_<public-id>.<secret>`                           | The specific capability granted when the Owner created the token. |

A [personal access token](../../integrations/personal-access-tokens/) reaches the same management routes as Studio. Tilecast Server checks the account's current role and screen access on every request, and the token's `read`, `write`, and `admin` scopes limit it further. Bearer requests don't send a CSRF token. The [`tilecast` CLI](../../integrations/cli/) and [MCP server](../../integrations/mcp/) use this same API.

Integration tokens are intentionally limited. The supported capabilities are **Write Manual Table rows** and **Read fleet health**. They do not provide general Studio access. See [Create an integration token](../../integrations/tokens/) for token lifecycle and [supported integration requests](../../integrations/) for examples.

## Health and readiness

- `GET /healthz` checks that the server process responds.
- `GET /readyz` returns ready only when the database and media storage/processing tools are available. It returns `503` when those dependencies are unavailable or a restore is in progress.

Use these endpoints for service health checks. They do not authenticate as a Studio user or Player.

## Inspect expected playback

`GET /api/v1/screens/{id}/playback-plan` explains which presentation the server
selects for a Screen. Use a management credential with the `read` scope and
access to that Screen. Omit the `at` query parameter to use server time, or
provide one RFC 3339 instant with a time zone.

For example, `?at=2026-10-02T16:15:00Z` asks about that exact instant. Current
and future requests evaluate the configuration that exists when you inspect
it. Past requests read recorded expectations. A gap in those records stays
visible as `historical_expectation_unavailable`; today's assignments do not
fill it.

Current evidence includes the selected source, alternatives, schedule
precedence, the next reevaluation boundary, manifest synchronization, and
reported Widget presentation support. A reevaluation boundary does not promise
that the content changes. Synchronization and capability reports describe the
latest known state, including when you ask about the future.

Selected content also includes its current name and known revision. Layout
revisions refer to the published version. Historical responses keep recorded
identities and revisions; they do not borrow today's names.

This response describes expected selection. It does not prove what appeared
on the physical display, report media readiness, or reproduce device decoder
behavior. There is no Studio control for this endpoint yet. See the
[Playback Plan engineering contract](https://github.com/gbyo/tilecast/blob/main/docs/playback-plan.md)
for evidence boundaries and error codes.

## OpenAPI description

The [endpoint reference](./endpoints/) in this section is generated from Tilecast's OpenAPI description and lists each route's parameters and responses. The source is the repository's [OpenAPI YAML](https://github.com/gbyo/tilecast/blob/main/docs/openapi.yaml). Human-written integration workflows are on [Integrations](../../integrations/); Player setup and pairing are on [Players](../../players/).
