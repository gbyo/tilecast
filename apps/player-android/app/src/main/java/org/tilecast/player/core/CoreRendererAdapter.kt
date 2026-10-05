package org.tilecast.player.core

/** Answer codes for renderer requests, shared with the native host. */
object CoreRendererRequestCode {
    const val QUEUED = 0
    const val RESOURCE_UNAVAILABLE = 1
    const val INVALID_ACTIVATION = 2
    const val NOT_READY = 3
}

/**
 * Handles one `rendererRequest` envelope from Core: activation, clear,
 * renderer commands, captures, restarts, and status-surface projections.
 * Implementations answer fast from their queue and never block the calling
 * worker on the UI thread or the page; slow work (captures, WebView
 * recreation) completes asynchronously through renderer reports.
 */
interface CoreRendererAdapter {
    fun handle(envelope: String): Int
}

/**
 * In-memory renderer for host tests: records envelopes, answers from a
 * scripted code, and forwards scripted reports through [report]. No Android
 * types, so JVM tests use it directly.
 */
class FakeCoreRenderer(
    var code: Int = CoreRendererRequestCode.QUEUED,
    var report: (String) -> Int = { CoreReportCode.APPLIED },
) : CoreRendererAdapter {
    val requests = mutableListOf<String>()

    override fun handle(envelope: String): Int {
        synchronized(requests) { requests += envelope }
        return code
    }

    fun requestsSnapshot(): List<String> = synchronized(requests) { requests.toList() }

    fun opOf(index: Int): String? =
        runCatching {
            kotlinx.serialization.json.Json.parseToJsonElement(requestsSnapshot()[index])
                .let { it as? kotlinx.serialization.json.JsonObject }
                ?.get("op")?.let { (it as? kotlinx.serialization.json.JsonPrimitive)?.content }
        }.getOrNull()
}
