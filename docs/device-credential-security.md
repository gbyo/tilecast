# Device credential security

Each screen receives a separate random credential. The credential has the format `tc_device_<public-id>.<secret>`.

The public ID selects a database record. The server compares the 256-bit secret with its SHA-256 hash in constant time.

The server returns the full credential one time. The server does not store or log the full credential.

Android encrypts the credential with an AES-GCM key from Android Keystore. Room contains only non-secret configuration.

Revocation adds a timestamp to the credential record and closes the active WebSocket. Future requests return `device_credential_revoked`.

The player then deletes its local credential.

The local maintenance PIN is independent of device authentication. Tilecast stores only a PBKDF2-SHA256 hash with a random salt.

Tilecast limits the verification rate. Repeated failures cause a temporary lock.

Accessibility Control is optional. A local user must enable it.

Accessibility Control cannot read window content, approve installers, change Wi-Fi, or accept unspecified Studio actions. It cannot make clicks or gestures.

Only Owners and Administrators can read detailed foreground package reports. Tilecast does not keep an unlimited event history.

The disable operation is reversible and keeps the credential. The revoke operation is permanent and requires new pairing.

Role rules and CSRF protection apply to both operations. Tilecast writes an audit event for each operation.
Website content does not change device authentication. Website pages do not receive the Tilecast device credential.

WebView requests do not contain Tilecast authorization headers. Tilecast does not support website credentials, imported cookies, OAuth tokens, or native JavaScript bridges.

The player configuration endpoint uses the same device boundary. It returns only the effective, non-secret values for that screen.

It does not return policy sources, environment values, connection strings, signing material, sessions, or information about other screens.

Update metadata and APK ranges require device authentication. An active deployment must also target the exact screen.

Commands contain only identifiers, the expected version and hash, the mode, and the expiration. They do not contain URLs, credentials, or paths.

Releases come only from `Gibsonmb71/tilecast`. The server verifies the Ed25519 statement, APK checksum, Android signature, and signing certificate.

## Tilecast Edge

On a Tilecast Edge Linux player, `tilecastd` is the only process that holds
the device credential. It stores the credential in
`/var/lib/tilecast-edge/identity/device-credential` with mode 0600. The
credential is never in the state database, never sent over IPC to the
renderer, never sent to peers, and never written to logs.

`tilecastd import-legacy` reads the Electron player's saved credential once.
It normalizes the saved server address, reads `/api/v1/system/identity`, and
requires the saved installation ID before it stores or sends the credential.
It never changes or deletes the legacy files.

The Edge node key is a separate credential. `tilecastd` generates it,
stores it in the same directory with mode 0600, and sends only a certificate
request. Revoking the device credential also revokes the Edge certificates of
the screen. See [`tilecast-edge-next.md`](tilecast-edge-next.md).
