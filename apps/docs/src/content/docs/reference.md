---
title: Reference
description: Where to find exact details about the Tilecast API, protocols, settings, and security design.
---

Reference pages give exact details for looking something up, rather than steps to follow. The detailed reference material is currently kept with the source code in the repository's `docs/` directory.

## API

Tilecast Server's HTTP API is versioned under `/api/v1`. Successful responses wrap their result in a `data` object, and errors return an `error` object with a machine-readable `code` and a readable `message`:

```json
{
  "error": {
    "code": "invalid_token",
    "message": "The integration token is missing, revoked, expired, or wrong."
  }
}
```

- [API overview](https://github.com/gbyo/tilecast/blob/main/docs/api.md)
- [OpenAPI description](https://github.com/gbyo/tilecast/blob/main/docs/openapi.yaml)

## Player protocol and security

- [Player protocol](https://github.com/gbyo/tilecast/blob/main/docs/player-protocol.md): discovery, pairing, enrollment, and the Player connection
- [Device credential security](https://github.com/gbyo/tilecast/blob/main/docs/device-credential-security.md): how Player credentials are issued, stored, and revoked
- [LAN discovery](https://github.com/gbyo/tilecast/blob/main/docs/mdns-discovery.md): the `_tilecast._tcp` service and its limits

## Settings and content

- [Settings and player policies](https://github.com/gbyo/tilecast/blob/main/docs/settings.md)
- [Widgets, Data Sources, and Layouts](https://github.com/gbyo/tilecast/blob/main/docs/widgets-and-layouts.md)
- [Installable built-in plugins](https://github.com/gbyo/tilecast/blob/main/docs/plugins.md)
- [Activity metric definitions](https://github.com/gbyo/tilecast/blob/main/docs/activity.md)
