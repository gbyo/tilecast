---
title: Reference
description: Find API details, product limits, and technical reference pages.
---

Use this section when you need exact API details, limits, or implementation-facing reference material rather than a step-by-step guide.

## API and integrations

- [HTTP API overview](./api/) covers API paths, response formats, authentication, and the OpenAPI definition.
- [API endpoints](./api/endpoints/) lists every route's parameters and responses, generated from the OpenAPI definition.
- [Content definition reference](./content-definitions/) lists the Widget, App, and Data Source definitions generated from Tilecast's source files.
- [Command-line interface](../integrations/cli/) and [MCP](../integrations/mcp/) explain the `tilecast` CLI, its command groups, and the MCP tools and risk levels. `tilecast <command> --help` lists every flag.
- [Personal access tokens](../integrations/personal-access-tokens/) and [integration tokens](../integrations/tokens/) explain the two kinds of API token, their permissions, and their lifecycle.
- [Manual Table integration](../integrations/manual-table/) and [fleet health](../integrations/fleet-health/) document supported integration requests.

## Product operations

- [Screen status](../operations/screen-status/) explains Fleet connection labels.
- [Activity reports](../operations/activity/) explains playback history, incidents, and health information.
- [Install built-in plugins](../operations/plugins/) lists the current optional plugins and their requirements.
- [Player capability matrix](../players/capabilities/) compares Android, Linux, Tilecast Edge, and Windows feature by feature. The [Edge capability matrix](../edge/capabilities/) compares Edge with the stable Linux Player.
- [Manage Tilecast](../manage/) links to account, backup, security, networking, and Player-policy guides.

## Repository reference

These documents live with the source because they are mainly useful to maintainers and integrators:

- [Player protocol](https://github.com/gbyo/tilecast/blob/main/docs/player-protocol.md) and [device credential security](https://github.com/gbyo/tilecast/blob/main/docs/device-credential-security.md)
- [LAN discovery](https://github.com/gbyo/tilecast/blob/main/docs/mdns-discovery.md)
- [Activity metric definitions](https://github.com/gbyo/tilecast/blob/main/docs/activity.md) and [event contract](https://github.com/gbyo/tilecast/blob/main/docs/activity-event-contract.md)
- [Settings registry and Player policy contract](https://github.com/gbyo/tilecast/blob/main/docs/settings.md)
- [Programmable control plane](https://github.com/gbyo/tilecast/blob/main/docs/programmable-control-plane.md), the contract for the CLI, MCP, and plugin automation
- [Widgets V2](https://github.com/gbyo/tilecast/blob/main/docs/widgets-v2.md), the Widget component and renderer contract
- [OpenAPI YAML](https://github.com/gbyo/tilecast/blob/main/docs/openapi.yaml)
