# Tilecast Player for Android TV

Native player for Fire TV, Google TV, and Android TV. Shared Player Core (Rust) owns pairing, content selection, offline scheduling, presence, and recovery. The shared Player Runtime in a trusted WebView plays the content. Kotlin and Jetpack Compose provide the OS integration and the Tilecast-owned setup, pairing, maintenance, and recovery screens.

See [`docs/android-development.md`](../../docs/android-development.md) for build and emulator instructions.

## Native Player Core host

The APK embeds the Rust crate `tilecast-player-android-native` from
`native/`. It owns one process-level Player Core host, a narrow JNI bridge,
Android storage locations, and Android platform TLS trust. Kotlin owns the
host lifetime through the application-scoped `PlayerCoreHost`.

An APK build needs the Rust toolchain from `rust-toolchain.toml`,
`cargo-ndk`, and the pinned NDK from `tilecastNdkVersion` in
`app/build.gradle.kts`. JVM unit tests do not need these tools. See
[`docs/android-development.md`](../../docs/android-development.md) for the
install commands, the host tests, and the 16 KB alignment gate.

## Architecture

```text
Player Core (Rust, process-level host: PlayerCoreHost)
    -> Android renderer adapter (WebViewCoreRenderer, owned by ProcessRenderer)
    -> trusted shared Player Runtime WebView
    -> image / video / Layout / Widget / website surfaces

Compose (MainActivity)
    -> setup, pairing, maintenance, commissioning, update, recovery,
       and the status surface over the WebView
```

Player Core decides what plays. The shared `@tilecast/player-runtime`
(`docs/player-runtime.md`) draws it inside one trusted WebView served from the
app-owned `https://appassets.androidplatform.net` origin. The `runtime/`
package holds the Android `TilecastRuntimeHostV1` host: the packaged-runtime
manifest verifier, the typed bridge protocol, ordered state replay,
host-authorized `tcmedia:` media lookup, and renderer-generation crash
recovery. Compose draws only Tilecast-owned native screens. The Player has no
Compose renderer for content and no Media3 dependency.

### Renderer ownership

- `ProcessRenderer` owns one `WebViewCoreRenderer` for the process. The
  Activity never creates, numbers, connects, or closes it. It attaches the view
  and its capture hooks, and detaches them in `onDestroy`.
- Renderer generations come from `RendererGenerations`, one counter for the
  process. A generation is never reused, so a late `disconnected` from an old
  renderer cannot disconnect a newer one.
- `RendererHandshake` registers each generation with Core. It waits for Core to
  open, retries a refused `connected` within bounds, keeps an early runtime
  `ready` until registration, and fails visibly with a reason code.
- `MainActivity` covers the WebView with a native status surface until the
  runtime is registered and ready. A renderer that cannot recover shows
  **Display unavailable** with a reason code, never an unexplained black screen.

Read [`docs/android-development.md`](../../docs/android-development.md) before
you change any of this. It defines the handshake, the log events (logcat tag
`TilecastRenderer`), and the hardware qualification procedure.

### Capabilities and typography

`renderer-profile.json` defines the renderer features and schemas. The
contracts generator writes the native packaged profile and the Kotlin ready
report from it, so preparation and the live renderer cannot disagree. Run
`npm run player-contracts:generate` after you change it.

Native text uses Geist through `ui/theme/Type.kt`. The `syncGeistFont` Gradle
task packages the vendored font. Do not set a font family in a composable.
