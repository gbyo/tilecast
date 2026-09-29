# Tilecast Player for Android TV

Native Kotlin and Jetpack Compose player for Fire TV, Google TV, and Android TV. Milestone 2 implements server discovery, manual connection, secure pairing, device presence, and the unassigned-screen state. Content playback is intentionally not included.

See [`docs/android-development.md`](../../docs/android-development.md) for build and emulator instructions.

## Shared runtime host (in progress)

The player is migrating its trusted display layer onto the shared
`@tilecast/player-runtime` (`docs/player-runtime.md`). The `runtime/` package
holds the Android `TilecastRuntimeHostV1` foundation: the packaged-runtime
manifest verifier, the app-owned `https://appassets.androidplatform.net` origin,
the typed bridge protocol, ordered state replay, host-authorized `tcmedia:`
media lookup, and renderer-generation crash recovery. The legacy Compose
presentation stack still owns the screen until the playback cutover lands.
