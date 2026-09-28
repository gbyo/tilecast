package org.tilecast.player.runtime

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/** Typed subset of `TilecastRuntimeHostV1` messages crossing the Android bridge.
 *
 * Widget component payloads stay opaque: the host forwards the JSON it was
 * given without interpreting `type`. There is intentionally no `when` over
 * widget types anywhere in this package; a future Widget must require zero
 * Android code.
 */
object RuntimeBridgeProtocol {
    const val CONTRACT_VERSION = 1
    const val HOST_GLOBAL = "tilecastRuntimeHost"
    const val BRIDGE_NAME = "tilecastRuntimeHostV1"

    private val json = Json { ignoreUnknownKeys = true }

    // ------------------------------------------------ host -> runtime -------

    sealed interface HostMessage {
        data class Presentation(val body: JsonObject, val activationId: String?, val generation: Long?) : HostMessage
        data class Plugins(val body: JsonObject) : HostMessage
        data class Identify(val body: JsonObject) : HostMessage
        data class Command(val body: JsonObject) : HostMessage
        data class DiscoveredServer(val body: JsonObject) : HostMessage
    }

    /** Strict envelope parse. Unknown `type` values and malformed bodies are refused. */
    fun parseHostMessage(raw: String): Result<HostMessage> = runCatching {
        if (raw.isBlank() || raw.length > 2_000_000) throw IllegalArgumentException("message refused")
        val obj = json.parseToJsonElement(raw).jsonObject
        when (obj["type"]?.jsonPrimitive?.contentOrNull) {
            "presentation" -> {
                val activation = obj["activation"]?.jsonObject
                HostMessage.Presentation(
                    body = obj,
                    activationId = activation?.get("activationId")?.jsonPrimitive?.contentOrNull?.take(64),
                    generation = activation?.get("generation")?.jsonPrimitive?.intOrNull?.toLong(),
                )
            }
            "plugins" -> HostMessage.Plugins(obj)
            "identify" -> HostMessage.Identify(obj)
            "command" -> HostMessage.Command(obj)
            "discovered-server", "discovered_server" -> HostMessage.DiscoveredServer(obj)
            else -> throw IllegalArgumentException("unknown message type")
        }
    }

    // ------------------------------------------------ runtime -> host -------

    /** Evidence vocabulary the supervisor understands (contract `EVIDENCE_KINDS`). */
    val evidenceKinds: Set<String> = setOf(
        "item-started", "item-transition", "image-shown", "video-progress",
        "widget-shown", "widget-alive", "widget-empty",
        "layout-shown", "layout-alive", "layout-zone-rendered",
        "website-loaded", "website-alive", "surface-shown",
    )

    sealed interface RuntimeReport {
        data class Ready(val contractVersion: Int, val runtimeVersion: String) : RuntimeReport
        data class PresentationResult(val activationId: String?, val outcome: String) : RuntimeReport
        data class Evidence(val activationId: String?, val itemId: String?, val kind: String, val zoneId: String?) : RuntimeReport
        data class PlaybackError(val activationId: String?, val itemId: String?, val message: String) : RuntimeReport
    }

    /** Validates one runtime-originated report. Returns null when refused. */
    fun parseRuntimeReport(raw: String): RuntimeReport? =
        runCatching { parseReportOrThrow(raw) }.getOrNull()

    private fun parseReportOrThrow(raw: String): RuntimeReport? {
        if (raw.isBlank() || raw.length > 256_000) return null
        val obj = runCatching { json.parseToJsonElement(raw).jsonObject }.getOrNull() ?: return null
        return when (obj["type"]?.jsonPrimitive?.contentOrNull) {
            "ready" -> {
                val version = obj["contractVersion"]?.jsonPrimitive?.intOrNull ?: return null
                if (version != CONTRACT_VERSION) return null
                val runtimeVersion = obj["runtimeVersion"]?.jsonPrimitive?.contentOrNull
                    ?.take(64)?.takeIf { it.isNotBlank() } ?: return null
                RuntimeReport.Ready(version, runtimeVersion)
            }
            "presentation.accepted", "presentation.rejected", "presentation-result" -> {
                val outcome = when (obj["type"]?.jsonPrimitive?.contentOrNull) {
                    "presentation.accepted" -> "accepted"
                    "presentation.rejected" -> "rejected"
                    else -> obj["outcome"]?.jsonPrimitive?.contentOrNull?.takeIf { it == "accepted" || it == "rejected" }
                        ?: return null
                }
                RuntimeReport.PresentationResult(activationOf(obj), outcome)
            }
            "evidence" -> {
                val kind = obj["kind"]?.jsonPrimitive?.contentOrNull ?: return null
                if (kind !in evidenceKinds) return null
                RuntimeReport.Evidence(
                    activationId = activationOf(obj),
                    itemId = obj["itemId"]?.jsonPrimitive?.contentOrNull?.take(128),
                    kind = kind,
                    zoneId = obj["zoneId"]?.jsonPrimitive?.contentOrNull?.take(128),
                )
            }
            "playback-error", "playback_error" -> {
                val message = obj["message"]?.jsonPrimitive?.contentOrNull
                    ?.take(240)?.takeIf { it.isNotBlank() } ?: return null
                RuntimeReport.PlaybackError(
                    activationId = activationOf(obj),
                    itemId = obj["itemId"]?.jsonPrimitive?.contentOrNull?.take(128),
                    message = message,
                )
            }
            else -> null
        }
    }

    private fun activationOf(obj: JsonObject): String? {
        val direct = obj["activationId"]?.jsonPrimitive?.contentOrNull
        if (!direct.isNullOrBlank()) return direct.take(64)
        val nested: JsonElement? = obj["activation"]
        if (nested is JsonObject) {
            return nested["activationId"]?.jsonPrimitive?.contentOrNull?.take(64)
        }
        return null
    }

    /** Capability check for the document-start bootstrap script. */
    fun bootstrapScript(): String =
        "(function(){if(window.__tilecastHostReady)return;window.__tilecastHostReady=true;})();"

    /** Numeric-only nudge evaluated in the page to pull host state. */
    fun nudgeJs(stateGeneration: Long): String =
        "__tilecastHostNudge(${stateGeneration.coerceAtLeast(0)});"

    fun hostInfo(hostVersion: String, engineVersion: String): Map<String, String> = mapOf(
        "host" to "android",
        "hostVersion" to hostVersion.take(32),
        "engine" to "android-webview",
        "engineVersion" to engineVersion.take(32),
    )

    /** PR1 advertises no presentation capabilities: the legacy stack still owns the screen. */
    fun pr1Capabilities(): Map<String, Any?> = mapOf(
        "remoteWeb" to null,
        "synchronizedPlayback" to false,
        "setup" to false,
        "discovery" to false,
    )
}
