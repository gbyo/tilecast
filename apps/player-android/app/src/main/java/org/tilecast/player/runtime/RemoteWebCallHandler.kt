package org.tilecast.player.runtime

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.tilecast.player.runtime.RemoteWebHostManager.PageContent
import org.tilecast.player.runtime.RemoteWebHostManager.Surface
import org.tilecast.player.runtime.RemoteWebHostManager.Viewport
import org.tilecast.player.runtime.RemoteWebHostManager.YouTubeContent

/** Pure handling of `remoteWeb` host calls from the shared runtime.
 *
 * Every operation is explicitly named and bounded; results are host-layer
 * targets only. There is no generic native-invocation path.
 */
object RemoteWebCallHandler {
    fun capabilities(): Map<String, Any?> = mapOf(
        "remoteWeb" to "host-view",
        "synchronizedPlayback" to true,
        "setup" to false,
        "discovery" to false,
    )

    /** Handles one parsed call. Returns the result payload for `create`-style
     * calls, or null when the call is fire-and-forget. */
    fun handle(
        call: HostChannel.PageMessage.Call,
        tracker: RemoteWebHostManager.Tracker,
        generation: Long,
    ): CallOutcome = runCatching { handleOrThrow(call, tracker, generation) }
        .getOrDefault(CallOutcome.Refused("bad_message"))

    private fun handleOrThrow(
        call: HostChannel.PageMessage.Call,
        tracker: RemoteWebHostManager.Tracker,
        generation: Long,
    ): CallOutcome = when (call.call) {
        "remoteWeb.create" -> create(call.payload, tracker, generation)
        "remoteWeb.updateViewport",
        "remoteWeb.setVisible",
        "remoteWeb.setMuted",
        "remoteWeb.reload",
        "remoteWeb.destroy",
        "remoteWeb.reportRecovered" -> {
            val applied = applySurfaceOp(call, tracker, generation)
            if (applied) CallOutcome.Ack else CallOutcome.Refused("unknown_surface")
        }
        else -> CallOutcome.Refused("unsupported_call")
    }

    sealed interface CallOutcome {
        data class Created(val surface: Surface) : CallOutcome
        data object Ack : CallOutcome
        data class Refused(val code: String) : CallOutcome
    }

    private fun create(
        payload: JsonObject,
        tracker: RemoteWebHostManager.Tracker,
        generation: Long,
    ): CallOutcome {
        val surfaceId = payload["surfaceId"]?.jsonPrimitive?.contentOrNull ?: return CallOutcome.Refused("bad_surface_id")
        if (!RemoteWebHostManager.validSurfaceId(surfaceId)) return CallOutcome.Refused("bad_surface_id")
        val content = payload["content"]?.jsonObject ?: return CallOutcome.Refused("bad_content")
        val viewport = payload["viewport"]?.jsonObject?.let(::parseViewport)
            ?.let(RemoteWebHostManager::mapViewport) ?: return CallOutcome.Refused("bad_viewport")
        val muted = payload["muted"]?.jsonPrimitive?.booleanOrNull ?: false
        val visible = payload["visible"]?.jsonPrimitive?.booleanOrNull ?: true
        val page = content.takeIf { it["kind"]?.jsonPrimitive?.contentOrNull == "page" }?.let(::parsePage)
        val youTube = content.takeIf { it["kind"]?.jsonPrimitive?.contentOrNull == "youtube" }?.let(::parseYouTube)
        if ((page == null) == (youTube == null)) return CallOutcome.Refused("bad_content")
        val surface = Surface(surfaceId, page, youTube, viewport, muted, visible, 0, generation)
        return if (tracker.create(surface)) CallOutcome.Created(surface)
        else CallOutcome.Refused("stale_generation")
    }

    private fun applySurfaceOp(
        call: HostChannel.PageMessage.Call,
        tracker: RemoteWebHostManager.Tracker,
        generation: Long,
    ): Boolean {
        val payload = call.payload
        val surfaceId = payload["surfaceId"]?.jsonPrimitive?.contentOrNull ?: return false
        return when (call.call) {
            "remoteWeb.updateViewport" -> {
                val viewport = payload["viewport"]?.jsonObject?.let(::parseViewport)
                    ?.let(RemoteWebHostManager::mapViewport) ?: return false
                tracker.updateViewport(surfaceId, viewport, generation)
            }
            "remoteWeb.setVisible" -> {
                val visible = payload["visible"]?.jsonPrimitive?.booleanOrNull ?: return false
                tracker.setVisible(surfaceId, visible, generation)
            }
            "remoteWeb.setMuted" -> {
                val muted = payload["muted"]?.jsonPrimitive?.booleanOrNull ?: return false
                tracker.setMuted(surfaceId, muted, generation)
            }
            "remoteWeb.reload" -> tracker.reload(surfaceId, generation)
            "remoteWeb.destroy" -> tracker.destroy(surfaceId, generation)
            "remoteWeb.reportRecovered" -> true
            else -> false
        }
    }

    private fun parseViewport(obj: JsonObject): Viewport? {
        val x = obj["x"]?.jsonPrimitive?.doubleOrNull ?: return null
        val y = obj["y"]?.jsonPrimitive?.doubleOrNull ?: return null
        val width = obj["width"]?.jsonPrimitive?.doubleOrNull ?: return null
        val height = obj["height"]?.jsonPrimitive?.doubleOrNull ?: return null
        val scale = obj["deviceScale"]?.jsonPrimitive?.doubleOrNull ?: return null
        return Viewport(x, y, width, height, scale)
    }

    private fun parsePage(content: JsonObject): PageContent? {
        val url = content["url"]?.jsonPrimitive?.contentOrNull ?: return null
        val hosts = content["allowedHosts"]?.jsonArray?.mapNotNull {
            it.jsonPrimitive.contentOrNull
        } ?: return null
        return PageContent(
            url = url,
            allowedHosts = hosts,
            javascriptEnabled = content["javascriptEnabled"]?.jsonPrimitive?.booleanOrNull ?: false,
            domStorageEnabled = content["domStorageEnabled"]?.jsonPrimitive?.booleanOrNull ?: false,
            cookiePolicy = content["cookiePolicy"]?.jsonPrimitive?.contentOrNull ?: "disabled",
            userAgent = content["userAgent"]?.jsonPrimitive?.contentOrNull ?: "",
            zoomPercent = content["zoomPercent"]?.jsonPrimitive?.intOrNull ?: 100,
            scrollX = content["scrollX"]?.jsonPrimitive?.intOrNull ?: 0,
            scrollY = content["scrollY"]?.jsonPrimitive?.intOrNull ?: 0,
            backgroundColor = content["backgroundColor"]?.jsonPrimitive?.contentOrNull ?: "#000000",
        )
    }

    private fun parseYouTube(content: JsonObject): YouTubeContent? {
        return YouTubeContent(
            videoId = content["videoId"]?.jsonPrimitive?.contentOrNull,
            playlistId = content["playlistId"]?.jsonPrimitive?.contentOrNull,
            startSeconds = content["startSeconds"]?.jsonPrimitive?.intOrNull ?: 0,
            endSeconds = content["endSeconds"]?.jsonPrimitive?.intOrNull,
            loop = content["loop"]?.jsonPrimitive?.booleanOrNull ?: false,
            muted = content["muted"]?.jsonPrimitive?.booleanOrNull ?: false,
            volume = content["volume"]?.jsonPrimitive?.intOrNull ?: 100,
            captions = content["captions"]?.jsonPrimitive?.booleanOrNull ?: false,
            captionLanguage = content["captionLanguage"]?.jsonPrimitive?.contentOrNull ?: "",
            controls = content["controls"]?.jsonPrimitive?.booleanOrNull ?: false,
        )
    }
}
