package org.tilecast.player.reliability

import android.content.Context
import android.os.Build
import java.time.Instant

/**
 * Unattended-readiness facts for one paired screen. There is no local
 * wizard and nothing here blocks playback: the Player applies fullscreen,
 * keep-awake, and launch-after-boot by itself, and reports the optional
 * Android permissions it does not hold. Studio's Reliability view shows
 * the result, and the maintenance menu opens the matching settings.
 */
data class CommissioningStatus(
    val accessibilitySupported: Boolean = true,
    val accessibilityEnabled: Boolean = false,
    val installPermissionGranted: Boolean = false,
    val bootLaunchVerified: Boolean = false,
    val immersiveVerified: Boolean = false,
    val keepAwakeVerified: Boolean = false,
    /** When this Player first played as this screen; null before pairing. */
    val completedAt: Instant? = null,
    val checkedAt: Instant? = null,
) {
    /** The self-test verdict Studio shows: every optional safeguard is in place, or not. */
    val selfTestResult: String?
        get() {
            if (completedAt == null) return null
            val ready =
                (!accessibilitySupported || accessibilityEnabled) &&
                    installPermissionGranted &&
                    bootLaunchVerified &&
                    immersiveVerified &&
                    keepAwakeVerified
            return if (ready) "passed" else "completed_with_warnings"
        }

    val readiness: String
        get() = when (selfTestResult) {
            null -> "needs_setup"
            "passed" -> "ready"
            else -> "partially_ready"
        }

    companion object {
        /** Readiness has no steps; the heartbeat names the automatic flow. */
        const val STEP = "automatic"
    }
}

class CommissioningController(
    private val context: Context,
    private val reliability: ReliabilityController,
) {
    private val preferences = context.getSharedPreferences("tilecast-commissioning", Context.MODE_PRIVATE)

    fun status(screenId: String?): CommissioningStatus {
        if (screenId == null) return CommissioningStatus()
        val key = "completed-at-$screenId"
        val completedAt =
            preferences.getLong(key, 0).takeIf { it > 0 }
                ?: System.currentTimeMillis().also { preferences.edit().putLong(key, it).apply() }
        val window = context.getSharedPreferences("tilecast-reliability", Context.MODE_PRIVATE)
        return CommissioningStatus(
            accessibilitySupported = !Build.MANUFACTURER.equals("Amazon", ignoreCase = true),
            accessibilityEnabled = reliability.accessibilityEnabled(),
            installPermissionGranted = Build.VERSION.SDK_INT < 26 || context.packageManager.canRequestPackageInstalls(),
            bootLaunchVerified = BootRecovery.status(context).launchVerified,
            immersiveVerified = window.getBoolean("immersive", false),
            keepAwakeVerified = window.getBoolean("keep-screen-on", false),
            completedAt = Instant.ofEpochMilli(completedAt),
            checkedAt = Instant.now(),
        )
    }
}
