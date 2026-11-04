package org.tilecast.player.reliability

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.SystemClock
import org.tilecast.player.MainActivity
import java.time.Instant

data class BootRecoveryStatus(
    val attemptCount: Int,
    val lastAttemptAt: Instant?,
    val result: String,
    val launchVerified: Boolean,
)

object BootRecovery {
    private const val ACTION_RETRY = "org.tilecast.player.BOOT_RECOVERY_RETRY"
    private val delays = longArrayOf(15_000, 60_000, 180_000)

    private fun preferences(context: Context) =
        (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            context.createDeviceProtectedStorageContext()
        } else {
            context
        }).getSharedPreferences("tilecast-boot-recovery", Context.MODE_PRIVATE)

    fun receive(context: Context, action: String?) {
        val preferences = preferences(context)
        if (action == Intent.ACTION_BOOT_COMPLETED || action == Intent.ACTION_LOCKED_BOOT_COMPLETED) {
            if (!preferences.getBoolean("launch-after-boot", true)) {
                preferences.edit().putBoolean("pending", false).putString("result", "launch_after_boot_disabled").commit()
                return
            }
            preferences.edit().putInt("attempt-count", 0).putBoolean("launch-verified", false).putString("result", "boot_received").putBoolean("pending", true).commit()
        } else if (action != ACTION_RETRY || !preferences.getBoolean("pending", false)) {
            return
        }
        if (preferences.getBoolean("launch-verified", false)) return
        val attempt = preferences.getInt("attempt-count", 0) + 1
        val launched =
            runCatching {
                context.startActivity(Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP))
                true
            }.getOrDefault(false)
        preferences.edit().putInt("attempt-count", attempt).putLong("last-attempt-at", System.currentTimeMillis()).putString("result", if (launched) "launch_requested" else "foreground_launch_blocked").commit()
        if (attempt <= delays.size) schedule(context, attempt, delays[attempt - 1]) else preferences.edit().putBoolean("pending", false).putString("result", "retry_limit_reached").commit()
    }

    /**
     * Mirrors the effective launch-after-boot policy into device-protected
     * storage, which the boot receiver can read before the user unlocks.
     */
    fun setLaunchAfterBoot(context: Context, enabled: Boolean) {
        preferences(context).edit().putBoolean("launch-after-boot", enabled).apply()
    }

    private fun schedule(context: Context, attempt: Int, delay: Long) {
        val alarm = context.getSystemService(AlarmManager::class.java)
        val retryIntent =
            Intent()
                .setClass(context, BootReceiver::class.java)
                .setPackage(context.packageName)
                .setAction(ACTION_RETRY)
        val pending =
            PendingIntent.getBroadcast(
                context,
                2100 + attempt,
                retryIntent,
                PendingIntent.FLAG_IMMUTABLE,
            )
        alarm.setWindow(AlarmManager.ELAPSED_REALTIME_WAKEUP, SystemClock.elapsedRealtime() + delay, 5_000, pending)
    }

    fun markForegroundHealthy(context: Context) {
        preferences(context).edit().putBoolean("launch-verified", true).putBoolean("pending", false).putString("result", "healthy_foreground").putLong("verified-at", System.currentTimeMillis()).commit()
    }

    fun status(context: Context): BootRecoveryStatus {
        val preferences = preferences(context)
        return BootRecoveryStatus(
            preferences.getInt("attempt-count", 0),
            preferences.getLong("last-attempt-at", 0).takeIf { it > 0 }?.let(Instant::ofEpochMilli),
            preferences.getString("result", "not_tested") ?: "not_tested",
            preferences.getBoolean("launch-verified", false),
        )
    }
}

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) = BootRecovery.receive(context, intent.action)
}
