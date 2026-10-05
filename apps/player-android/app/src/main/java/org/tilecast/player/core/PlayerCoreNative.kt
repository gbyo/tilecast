package org.tilecast.player.core

import android.content.Context

/**
 * Narrow JNI entry points into the Android Player Core host. This object must
 * keep its package, class, and method names: the Rust side exports them as
 * static `Java_org_tilecast_player_core_PlayerCoreNative_*` symbols, and the
 * ProGuard rules keep them through minification.
 *
 * Primitives and short strings only. [nativeStatus] and [nativeBeginPairing]
 * always return a JSON envelope so callers parse one shape; [nativeOpen]
 * returns `0` on failure and the remaining calls return small integer codes
 * documented in `apps/player-android/native/src/ffi.rs`.
 */
internal object PlayerCoreNative {
    init {
        System.loadLibrary("tilecast_player_core")
    }

    external fun nativeVersion(): String?
    external fun nativeOpen(filesDir: String, userAgent: String, handler: CoreBridgeHandler): Long
    external fun nativeStatus(handle: Long): String?
    external fun nativeStartCore(handle: Long): Int
    external fun nativeBeginPairing(handle: Long, url: String): String?
    external fun nativeResetPairing(handle: Long): Int
    external fun nativeResetServer(handle: Long): Int
    external fun nativeClose(handle: Long): Int
    external fun nativeInitTls(context: Context): Int
    /**
     * Runs the CAS storage checklist against a scratch directory below
     * [filesDir] and returns its JSON report. Instrumented qualification
     * tests only; production never calls this.
     */
    external fun nativeQualifyCas(filesDir: String): String?
    external fun nativeSyncConfig(handle: Long): String?
    external fun nativeSyncManifest(handle: Long): String?
    external fun nativeImportLegacy(handle: Long): String?
    external fun nativeActivatePresentation(handle: Long, json: String): String?
    external fun nativeRendererReport(handle: Long, json: String): Int
    external fun nativeRendererRecovery(handle: Long, json: String): String?
    external fun nativeReportObservations(handle: Long, json: String): Int
    external fun nativeConfigJson(handle: Long): String?
    external fun nativeFetchIdentity(handle: Long, url: String): String?
    external fun nativeBackgroundLiveness(handle: Long): String?
}
