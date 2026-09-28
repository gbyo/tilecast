package org.tilecast.player.runtime

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.tilecast.player.network.ManifestItem
import org.tilecast.player.runtime.RemoteWebCallHandler.CallOutcome
import org.tilecast.player.runtime.RuntimeBridgeProtocol.HostMessage

/** One live runtime instance: host state, remote surfaces, and evidence routing.
 *
 * Composes the PR1 [AndroidRuntimeHost] without changing it. Content state
 * carries its own [stateGeneration] so the page pulls exactly what changed;
 * renderer identity ([rendererGeneration]) rejects callbacks from dead
 * WebViews. Remote surfaces reset on activation change; the caller destroys
 * the removed WebViews.
 */
class RuntimeHostSession(
    hostVersion: String,
    engineVersion: String,
    private val rendererGeneration: Long,
    items: List<ManifestItem>,
    activationId: String,
    onBoundary: (itemId: String, assetId: String) -> Unit,
    onError: (String) -> Unit,
    onProgress: () -> Unit,
    onFirstFrame: (itemId: String) -> Unit = {},
    onItemTransition: (itemId: String) -> Unit = {},
) {
    val host = AndroidRuntimeHost(hostVersion, engineVersion)
    val remoteWeb = RemoteWebHostManager.Tracker(rendererGeneration)
    private val router = RuntimeEvidenceRouter(
        items, activationId, onBoundary, onError, onProgress, onFirstFrame, onItemTransition,
    )
    private var stateGeneration = 0L
    private var lastActivationId: String? = null

    fun capabilities(): Map<String, Any?> = RemoteWebCallHandler.capabilities()

    /** Rebind reports before offering a replacement presentation. */
    fun updatePresentation(items: List<ManifestItem>, activationId: String) {
        router.replace(items, activationId)
    }

    /** Offers a host message. Returns the new state generation and any remote
     * surfaces dropped by an activation change. */
    fun offer(message: HostMessage): OfferResult {
        if (message is HostMessage.Presentation && message.activationId != lastActivationId) {
            lastActivationId = message.activationId
            val removed = remoteWeb.reset(rendererGeneration)
            host.offer(message)
            stateGeneration++
            return OfferResult(stateGeneration, removed)
        }
        host.offer(message)
        stateGeneration++
        return OfferResult(stateGeneration, emptyList())
    }

    data class OfferResult(val stateGeneration: Long, val removedSurfaces: List<String>)

    private var eventsReply: androidx.webkit.JavaScriptReplyProxy? = null

    fun currentStateGeneration(): Long = stateGeneration

    /** Arms remote-event pushes for one page subscription. */
    fun armEvents(reply: androidx.webkit.JavaScriptReplyProxy?, callerRendererGeneration: Long) {
        if (callerRendererGeneration != rendererGeneration) return
        eventsReply = reply
    }

    /** Pushes a remote-web event to the armed page. False when nobody listens. */
    fun postRemoteEvent(surfaceId: String?, kind: String, code: String?): Boolean {
        val reply = eventsReply ?: return false
        return runCatching {
            reply.postMessage(HostChannel.remoteEvent(surfaceId, kind, code))
            true
        }.getOrDefault(false)
    }

    /** Handles one page message. Returns reply JSON, or null to stay silent.
     * Event subscriptions and call replies use the message's reply proxy. */
    fun handlePageMessage(
        raw: String,
        callerRendererGeneration: Long,
        reply: androidx.webkit.JavaScriptReplyProxy?,
    ): String? {
        if (callerRendererGeneration != rendererGeneration) return null
        return when (val message = HostChannel.parsePageMessage(raw)) {
            null -> null
            is HostChannel.PageMessage.StateWant ->
                HostChannel.stateBundle(stateGeneration, bundle())
            is HostChannel.PageMessage.Call -> handleCall(message)
            is HostChannel.PageMessage.Report -> {
                routeReport(message.raw)
                null
            }
            is HostChannel.PageMessage.EventsWant -> {
                armEvents(reply, callerRendererGeneration)
                null
            }
        }
    }

    private fun bundle(): List<JsonObject> = host.replayForReady().map(::bodyOf)

    private fun bodyOf(message: HostMessage): JsonObject = when (message) {
        is HostMessage.Presentation -> message.body
        is HostMessage.Plugins -> message.body
        is HostMessage.Identify -> message.body
        is HostMessage.Command -> message.body
        is HostMessage.DiscoveredServer -> message.body
    }

    private fun handleCall(call: HostChannel.PageMessage.Call): String {
        val outcome = RemoteWebCallHandler.handle(call, remoteWeb, rendererGeneration)
        return when (outcome) {
            is CallOutcome.Created -> HostChannel.callResult(
                call.id, true,
                buildJsonObject { put("kind", "host-layer") }, null,
            )
            is CallOutcome.Ack -> HostChannel.callResult(call.id, true, null, null)
            is CallOutcome.Refused -> HostChannel.callResult(call.id, false, null, outcome.code)
        }
    }

    private fun routeReport(raw: String) {
        val report = host.handleRuntimeMessage(raw, rendererGeneration) ?: return
        val activation = when (report) {
            is RuntimeBridgeProtocol.RuntimeReport.Ready -> null
            is RuntimeBridgeProtocol.RuntimeReport.PresentationResult -> report.activationId
            is RuntimeBridgeProtocol.RuntimeReport.Evidence -> report.activationId
            is RuntimeBridgeProtocol.RuntimeReport.PlaybackError -> report.activationId
        }
        router.handle(report, activation)
    }
}
