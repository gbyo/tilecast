package org.tilecast.player.core

import android.content.Context
import android.os.Build
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
    }.toString()

    companion object {
        fun collect(context: Context): DeviceFacts {
            val metrics = context.resources.displayMetrics
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

    fun onPairingStatus(json: String) {
        runCatching { pairingSink(json) }
    }
}
