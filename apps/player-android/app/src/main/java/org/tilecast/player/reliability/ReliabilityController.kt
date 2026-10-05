package org.tilecast.player.reliability

import android.app.Activity
import android.app.AlarmManager
import android.app.PendingIntent
import android.app.admin.DevicePolicyManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Process
import android.provider.Settings
import android.util.Base64
import android.view.WindowManager
import org.tilecast.player.MainActivity
import org.tilecast.player.core.CorePlatformConfig
import java.time.Instant

data class ReliabilityStatus(
    val configuredMode: String = "standard",
    val effectiveMode: String = "standard",
    val foreground: Boolean = false,
    val immersive: Boolean = false,
    val keepScreenOn: Boolean = false,
    val kioskCapability: ManagedKioskCapability = ManagedKioskCapability.UNSUPPORTED,
    val accessibilityEnabled: Boolean = false,
    val activeHours: Boolean = true,
    val safeMode: Boolean = false,
    val maintenanceUntil: Instant? = null,
)

internal fun isFireTvDevice(
    manufacturer: String,
    brand: String,
    model: String,
    device: String,
): Boolean {
    if (manufacturer.equals("Amazon", ignoreCase = true) || brand.equals("Amazon", ignoreCase = true)) {
        return true
    }
    val identity = "$manufacturer $brand $model $device"
    return identity.contains("fire tv", ignoreCase = true) ||
        identity.contains("firetv", ignoreCase = true)
}

internal fun shouldKeepScreenAwake(
    active: Boolean,
    keepScreenOnDuringActiveHours: Boolean,
    sleepOutsideActiveHours: Boolean,
    fireTv: Boolean,
): Boolean = if (active) {
    keepScreenOnDuringActiveHours
} else {
    fireTv || !sleepOutsideActiveHours
}

class ReliabilityController(private val context: Context) {
    private val store = context.getSharedPreferences("tilecast-reliability", Context.MODE_PRIVATE)
    private val dpm = context.getSystemService(DevicePolicyManager::class.java)

    fun kioskCapability(activity: Activity? = null): ManagedKioskCapability = runCatching {
        when {
            !context.packageManager.hasSystemFeature("android.software.device_admin") -> ManagedKioskCapability.UNSUPPORTED
            dpm.isLockTaskPermitted(context.packageName) -> ManagedKioskCapability.LOCK_TASK_ALLOWED
            dpm.isDeviceOwnerApp(context.packageName) -> ManagedKioskCapability.PROVISIONED
            else -> ManagedKioskCapability.AVAILABLE_NOT_PROVISIONED
        }
    }.getOrDefault(ManagedKioskCapability.ERROR)

    fun accessibilityEnabled(): Boolean {
        val enabled = Settings.Secure.getString(
            context.contentResolver,
            Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES,
        ).orEmpty()
        return enabled.split(':').any { it.contains(context.packageName, true) }
    }

    fun applyWindow(
        activity: Activity,
        platform: CorePlatformConfig,
        activeHours: Boolean,
        takeover: Boolean = false,
    ): ReliabilityStatus {
        val active = activeHours || takeover
        val fireTv = fireTvDevice()
        val keep = shouldKeepScreenAwake(
            active = active,
            keepScreenOnDuringActiveHours = platform.power.keepScreenOn,
            sleepOutsideActiveHours = platform.power.sleepOutsideActiveHours,
            fireTv = fireTv,
        )
        if (keep) {
            activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        } else {
            activity.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
        if (platform.reliability.immersiveMode && active) {
            activity.window.decorView.systemUiVisibility =
                android.view.View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or
                android.view.View.SYSTEM_UI_FLAG_FULLSCREEN or
                android.view.View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
        }
        val capability = kioskCapability(activity)
        var effective = "standard"
        if (
            maintenanceUntil() == null &&
            platform.reliability.mode == "managed_kiosk" &&
            platform.managedKiosk.lockTaskEnabled &&
            dpm.isLockTaskPermitted(context.packageName)
        ) {
            runCatching { activity.startLockTask() }
            effective = if (activity.isInLockTask()) "managed_kiosk" else "standard"
        }
        store.edit()
            .putString("configured-mode", platform.reliability.mode)
            .putString("effective-mode", effective)
            .putBoolean("keep-screen-on", keep)
            .putBoolean("immersive", platform.reliability.immersiveMode && active)
            .putBoolean("fire-tv-sleep-blocked", fireTv)
            .apply()
        return ReliabilityStatus(
            platform.reliability.mode,
            effective,
            true,
            platform.reliability.immersiveMode && active,
            keep,
            if (effective == "managed_kiosk") {
                ManagedKioskCapability.LOCK_TASK_ACTIVE
            } else {
                capability
            },
            accessibilityEnabled(),
            active,
            store.getBoolean("safe-mode", false),
            maintenanceUntil(),
        )
    }

    fun requestSleep(): String {
        if (fireTvDevice()) return recordSleepResult("fire_tv_sleep_blocked")
        if (maintenanceUntil() != null) return recordSleepResult("maintenance_session_deferred")
        if (store.getBoolean("update-active", false)) return recordSleepResult("player_update_deferred")
        val result = runCatching {
            if (dpm.isDeviceOwnerApp(context.packageName)) {
                dpm.lockNow()
                "device_policy_requested"
            } else if (accessibilityEnabled()) {
                if (TilecastAccessibilityService.requestLock()) {
                    "accessibility_lock_requested"
                } else {
                    store.edit().putBoolean("request-lock", true).apply()
                    "accessibility_lock_deferred"
                }
            } else {
                "black_screen_only"
            }
        }.getOrElse { "sleep_unsupported" }
        return recordSleepResult(result)
    }

    fun requestWake(): String {
        val intent = Intent(context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        return runCatching {
            context.startActivity(intent)
            "device_wake_requested"
        }.getOrElse { "wake_launch_blocked" }
            .also { store.edit().putString("last-wake-result", it).apply() }
    }

    fun restartActivity() {
        context.startActivity(
            Intent(context, MainActivity::class.java).addFlags(
                Intent.FLAG_ACTIVITY_NEW_TASK or
                    Intent.FLAG_ACTIVITY_CLEAR_TOP or
                    Intent.FLAG_ACTIVITY_CLEAR_TASK,
            ),
        )
    }

    fun restartProcess() {
        val alarm = context.getSystemService(AlarmManager::class.java)
        val restartIntent = Intent()
            .setClass(context, MainActivity::class.java)
            .setPackage(context.packageName)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        val pending = PendingIntent.getActivity(context, 4040, restartIntent, PendingIntent.FLAG_IMMUTABLE)
        alarm.setExact(
            AlarmManager.ELAPSED_REALTIME_WAKEUP,
            android.os.SystemClock.elapsedRealtime() + 1500,
            pending,
        )
        Process.killProcess(Process.myPid())
    }

    fun scheduleWake(at: Instant) {
        val alarm = context.getSystemService(AlarmManager::class.java)
        val wakeIntent = Intent()
            .setClass(context, ActiveHoursReceiver::class.java)
            .setPackage(context.packageName)
        val intent = PendingIntent.getBroadcast(context, 1010, wakeIntent, PendingIntent.FLAG_IMMUTABLE)
        alarm.setWindow(AlarmManager.RTC_WAKEUP, at.toEpochMilli(), 60_000, intent)
    }

    fun beginMaintenance(minutes: Int) {
        (context as? Activity)?.let { runCatching { it.stopLockTask() } }
        store.edit()
            .putLong(
                "maintenance-until",
                System.currentTimeMillis() + minutes.coerceIn(1, 120) * 60_000L,
            )
            .apply()
        (context as? MainActivity)?.maintenanceChanged()
    }

    fun maintenanceUntil(): Instant? = store.getLong("maintenance-until", 0)
        .takeIf { it > System.currentTimeMillis() }
        ?.let { Instant.ofEpochMilli(it) }

    fun setSafeMode(value: Boolean) {
        store.edit().putBoolean("safe-mode", value).apply()
    }

    fun isSafeMode(): Boolean = store.getBoolean("safe-mode", false)

    fun hasAdminPin() = store.contains("admin-pin-hash")

    fun setAdminPin(pin: CharArray) {
        val stored = AdminPinGate().create(pin)
        store.edit()
            .putString("admin-pin-salt", Base64.encodeToString(stored.salt, Base64.NO_WRAP))
            .putString("admin-pin-hash", Base64.encodeToString(stored.hash, Base64.NO_WRAP))
            .putInt("admin-pin-iterations", stored.iterations)
            .putLong("admin-pin-changed-at", System.currentTimeMillis())
            .commit()
        pin.fill('\u0000')
    }

    fun verifyAdminPin(pin: CharArray): Boolean {
        if (store.getLong("admin-pin-lockout-until", 0) > System.currentTimeMillis()) {
            pin.fill('\u0000')
            return false
        }
        val salt = store.getString("admin-pin-salt", null) ?: return false
        val hash = store.getString("admin-pin-hash", null) ?: return false
        val valid = pinGate.verify(
            pin,
            StoredPin(
                Base64.decode(salt, Base64.NO_WRAP),
                Base64.decode(hash, Base64.NO_WRAP),
                store.getInt("admin-pin-iterations", 120000),
            ),
        )
        pin.fill('\u0000')
        if (valid) {
            store.edit().remove("admin-pin-failures").remove("admin-pin-lockout-until").apply()
        } else {
            val failures = store.getInt("admin-pin-failures", 0) + 1
            if (failures >= 5) {
                store.edit()
                    .putInt("admin-pin-failures", 0)
                    .putLong("admin-pin-lockout-until", System.currentTimeMillis() + 300_000)
                    .apply()
            } else {
                store.edit().putInt("admin-pin-failures", failures).apply()
            }
        }
        return valid
    }

    private val pinGate = AdminPinGate()

    private fun fireTvDevice(): Boolean = isFireTvDevice(
        manufacturer = Build.MANUFACTURER.orEmpty(),
        brand = Build.BRAND.orEmpty(),
        model = Build.MODEL.orEmpty(),
        device = Build.DEVICE.orEmpty(),
    )

    private fun recordSleepResult(result: String): String = result.also {
        store.edit().putString("last-sleep-result", it).apply()
    }

    private fun Activity.isInLockTask(): Boolean {
        val am = getSystemService(android.app.ActivityManager::class.java)
        return if (Build.VERSION.SDK_INT >= 23) {
            am.lockTaskModeState != android.app.ActivityManager.LOCK_TASK_MODE_NONE
        } else {
            false
        }
    }
}

class ActiveHoursReceiver : android.content.BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        ReliabilityController(context).requestWake()
    }
}

enum class ManagedKioskCapability { UNSUPPORTED, AVAILABLE_NOT_PROVISIONED, PROVISIONED, LOCK_TASK_ALLOWED, LOCK_TASK_ACTIVE, ERROR }
