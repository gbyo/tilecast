# Player Client

Portable native Player HTTP and WebSocket transport, server URL policy,
installation identity verification, pairing, configuration, commands,
Activity/telemetry, preview, Watch Live, and update metadata contracts.

`ServerClient` uses public endpoints. Only `AuthenticatedServer`, created after
installation verification, can send a device credential. Authenticated downloads
also require a validated `PlayerDownloadPath`. Redirect, timeout, response-bound,
lease, and range behavior is preserved.

Hosts supply the user agent and device metadata. The client has no product
version source or operating-system metadata reader. `DeviceCredential` validates
and redacts its value; it does not implement serialization. Explicit storage
access is reserved for a trusted host backend.

`CredentialStore` and `PairingStore` define load, save, and remove operations.
The client never calls them or chooses a persistence path. Edge owns its
owner-only files, atomic writes, private pairing session, and Electron import.
Pairing session serialization is the existing private storage encoding and must
never be used as a renderer payload.

CAS origin integration remains thin Edge glue until Core is introduced.
No shared client code depends on CAS, state, Edge, renderer IPC, or Linux APIs.
See [`docs/player-core.md`](../../docs/player-core.md).
