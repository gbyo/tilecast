package org.tilecast.player.core

import android.content.Context
import android.os.Build
import android.os.SystemClock
import java.io.File
import java.util.Locale
import java.util.TimeZone
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.tilecast.player.BuildConfig
import org.tilecast.player.security.CredentialStore

/**
 * Device facts Core reports to the server. The platform tag keeps the exact
 * values the legacy Player sends, so the cutover changes no server behavior.
 */
data class DeviceFacts(
    val platform: String,
    val manufacturer: String,
    val model: String,
    val osRelease: String,
    val playerVersion: String,
    val screenWidth: Int,
    val screenHeight: Int,
    val locale: String,
    val timezone: String,
    val androidSdk: Int,
    val playerVersionCode: Long,
    val installerSource: String?,
    val installPermissionStatus: String,
) {
    fun toJson(): String = buildJsonObject {
        put("platform", platform)
        put("manufacturer", manufacturer)
        put("model", model)
        put("osRelease", osRelease)
        put("playerVersion", playerVersion)
        put("screenWidth", screenWidth)
        put("screenHeight", screenHeight)
        put("locale", locale)
        put("timezone", timezone)
        put("androidSdk", androidSdk)
        put("playerVersionCode", playerVersionCode)
        installerSource?.let { put("installerSource", it) }
        put("installPermissionStatus", installPermissionStatus)
    }.toString()

    companion object {
        fun collect(context: Context): DeviceFacts {
            val metrics = context.resources.displayMetrics
            val installer = if (Build.VERSION.SDK_INT >= 30) {
                runCatching {
                    context.packageManager.getInstallSourceInfo(context.packageName).installingPackageName
                }.getOrNull()
            } else {
                null
            }
            return DeviceFacts(
                platform = if (Build.MANUFACTURER.equals("Amazon", ignoreCase = true)) "fire-tv" else "android-tv",
                manufacturer = Build.MANUFACTURER ?: "Unknown",
                model = Build.MODEL ?: "Unknown",
                osRelease = Build.VERSION.RELEASE ?: Build.VERSION.SDK_INT.toString(),
                playerVersion = BuildConfig.VERSION_NAME,
                screenWidth = metrics.widthPixels,
                screenHeight = metrics.heightPixels,
                locale = Locale.getDefault().toLanguageTag(),
                timezone = TimeZone.getDefault().id,
                androidSdk = Build.VERSION.SDK_INT,
                playerVersionCode = BuildConfig.VERSION_CODE.toLong(),
                installerSource = installer,
                installPermissionStatus =
                    if (Build.VERSION.SDK_INT < 26 || context.packageManager.canRequestPackageInstalls()) {
                        "granted"
                    } else {
                        "required"
                    },
            )
        }
    }
}

/**
 * The Kotlin side of the Rust-to-Kotlin bridge. Core drivers call these
 * methods over JNI from Tokio worker threads: every method is blocking,
 * thread-safe, exception-free, and fast (private stores only, never the
 * network). Method names and signatures must keep their exact spelling: Rust
 * looks them up by name, and the ProGuard rules keep them through
 * minification. Integer codes are `0` for success, `1` for failure.
 */
class CoreBridgeHandler(
    private val credentials: CredentialStore,
    private val pairingFile: File,
    private val facts: DeviceFacts,
    private val pairingSink: (String) -> Unit,
    var executor: PlatformCommandExecutor = PlatformCommandExecutor.UNAVAILABLE,
    var rendererAdapter: CoreRendererAdapter = CoreRendererAdapterRefusing,
) {
    fun credentialLoad(): String? = runCatching { credentials.read() }.getOrNull()

    fun credentialSave(value: String): Int =
        runCatching {
            credentials.save(value)
            0
        }.getOrDefault(1)

    fun credentialRemove(): Int =
        runCatching {
            credentials.clear()
            0
        }.getOrDefault(1)

    fun pairingSessionLoad(): String? =
        runCatching { pairingFile.takeIf { it.isFile }?.readText() }.getOrNull()

    fun pairingSessionSave(json: String): Int =
        runCatching {
            pairingFile.parentFile?.mkdirs()
            val tmp = File(pairingFile.parentFile, "${pairingFile.name}.tmp")
            tmp.writeText(json)
            if (!tmp.renameTo(pairingFile)) {
                tmp.delete()
                error("rename failed")
            }
            0
        }.getOrDefault(1)

    fun pairingSessionRemove(): Int =
        runCatching {
            if (pairingFile.exists() && !pairingFile.delete()) error("delete failed")
            0
        }.getOrDefault(1)

    fun deviceMetadata(): String = facts.toJson()

    /** Device uptime in whole seconds since boot. A live measurement: the app sandbox cannot read the kernel uptime file. */
    fun deviceUptimeSeconds(): Long = SystemClock.elapsedRealtime() / 1000

    fun onPairingStatus(json: String) {
        runCatching { pairingSink(json) }
    }

    fun executePlatformCommand(json: String): String =
        runCatching { executor.execute(json) }
            .getOrElse { PlatformCommandExecutor.result(false, "platform_failed") }

    /** One semantic renderer operation from Core. Answers fast; slow work completes through reports. */
    fun rendererRequest(json: String): Int =
        runCatching { rendererAdapter.handle(json) }
            .getOrDefault(CoreRendererRequestCode.NOT_READY)
}

/** No renderer is attached (production until the PR3 cutover wires the stage). */
internal object CoreRendererAdapterRefusing : CoreRendererAdapter {
    override fun handle(envelope: String): Int = CoreRendererRequestCode.NOT_READY
}

/**
 * Executes platform-owned commands Core cannot run itself: power,
 * update-installer, and restart effects. The request is
 * `{"id": str, "type": str, "payload": object}`; the answer is the
 * result envelope `{"ok": bool, "code": str, "message": str}`. Called
 * on a Core worker thread; never call back into native code or block
 * on the UI thread.
 */
fun interface PlatformCommandExecutor {
    fun execute(requestJson: String): String

    companion object {
        /** Safe default until a real executor is attached: production
         * wires [CorePlatformCommands], tests substitute fakes. */
        val UNAVAILABLE = PlatformCommandExecutor {
            """{"ok":false,"code":"platform_unavailable","message":"The platform executor is not wired yet."}"""
        }

        fun result(ok: Boolean, code: String, message: String = ""): String =
            buildJsonObject {
                put("ok", ok)
                put("code", code)
                put("message", message)
            }.toString()
    }
}
