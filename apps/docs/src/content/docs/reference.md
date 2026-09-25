---
title: Reference
description: Find API contracts, product limits, and deeper technical references.
---

Use these pages when you need exact request conventions or a technical contract rather than a procedure.

## API and integrations

- [HTTP API overview](./api/) covers API paths, response envelopes, authentication boundaries, and the OpenAPI definition.
- [Content definition reference](./content-definitions/) is generated from the release-owned content-definition JSON and stays source-linked rather than becoming a hand-maintained catalog.
- [Integration tokens](../integrations/tokens/) describes token capabilities and lifecycle.
- [Manual Table integration](../integrations/manual-table/) and [fleet health](../integrations/fleet-health/) document supported integration requests.

## Product operations

- [Screen status](../operations/screen-status/) explains Fleet connection labels and what they mean.
- [Activity reports](../operations/activity/) defines the practical meaning of playback, incidents, and health reports, with links to the detailed metric contract.
- [Install built-in plugins](../operations/plugins/) lists the current optional plugin capabilities and prerequisites.
- [Administration](../administration/) links to guides for accounts, backups, security, and Player policies.

## Deeper repository references

These technical documents live with the source because they describe implementation contracts used by maintainers and integrators:

- [Player protocol](https://github.com/gbyo/tilecast/blob/main/docs/player-protocol.md) and [device credential security](https://github.com/gbyo/tilecast/blob/main/docs/device-credential-security.md)
- [LAN discovery](https://github.com/gbyo/tilecast/blob/main/docs/mdns-discovery.md)
- [Activity metric definitions](https://github.com/gbyo/tilecast/blob/main/docs/activity.md) and [event contract](https://github.com/gbyo/tilecast/blob/main/docs/activity-event-contract.md)
- [Settings registry and player policy contract](https://github.com/gbyo/tilecast/blob/main/docs/settings.md)
- [OpenAPI YAML](https://github.com/gbyo/tilecast/blob/main/docs/openapi.yaml)
