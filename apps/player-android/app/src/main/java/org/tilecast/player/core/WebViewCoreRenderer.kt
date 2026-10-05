package org.tilecast.player.core

import android.content.Context
import android.util.Base64
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebResourceResponse
import androidx.webkit.JavaScriptReplyProxy
import android.webkit.WebStorage
import android.webkit.WebView
import java.io.File
import java.util.concurrent.Executors
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import org.tilecast.player.network.PlayerPresentationSupport
import org.tilecast.player.runtime.HostChannel
import org.tilecast.player.runtime.MediaAuthorization
import org.tilecast.player.runtime.RuntimeBridgeProtocol
import org.tilecast.player.runtime.RuntimeComponentProbe
import org.tilecast.player.runtime.RuntimeCrashPolicy
import org.tilecast.player.runtime.RuntimeHostSession
import org.tilecast.player.runtime.RuntimePresentationBuilder
import org.tilecast.player.runtime.RuntimeScreenState
import org.tilecast.player.runtime.RuntimeSupportAssessment
import org.tilecast.player.runtime.TcMediaBridge
import org.tilecast.player.runtime.TrustedRuntimeEndpoint
import org.tilecast.player.runtime.TrustedRuntimeWebView
import org.tilecast.player.runtime.WidgetComponentCapabilities

/**
 * The production Core renderer: Core activations drive the trusted WebView
 * Player Runtime, and page reports return to Core as renderer reports.
 *
 * Threading: [handle] runs on Rust worker threads and answers fast under a
 * short monitor; WebView work posts to the main thread and reports flow
 * through one ordered background lane. The view is created with the
 * application context; the UI host attaches [view] to its hierarchy.
 */
class WebViewCoreRenderer(
    appContext: Context,
    private val hostVersion: String,
    private val engineVersion: String,
    private val report: suspend (String) -> Int,
    private val captureFrame: (suspend (maxWidth: Int, maxHeight: Int) -> CapturedImage?)? = null,
) : CoreRendererAdapter {
    data class CapturedImage(val bytes: ByteArray, val width: Int, val height: Int)

    private data class Grants(
        val authorized: Set<MediaAuthorization.AuthorizedMedia>,
        val localFiles: Map<String, String>,
        val mimeByVariant: Map<String, String>,
    )

    private val context = appContext.applicationContext
    private val worker = Executors.newSingleThreadExecutor { task ->
        Thread(task, "core-renderer").apply { isDaemon = true }
    }
    private val scope = CoroutineScope(SupervisorJob() + worker.asCoroutineDispatcher())
    private val lock = Any()
    private val crashPolicy = RuntimeCrashPolicy()

    private var owner: TrustedRuntimeWebView? = null
    private var webView: WebView? = null
    private var session: RuntimeHostSession? = null
    private var started = false

    @Volatile
    private var liveGeneration: Long = 0L

    @Volatile
    private var grants: Grants? = null

    /** The live WebView for the UI host to attach, if the renderer started. */
    val view: WebView?
        get() = synchronized(lock) { webView }

    /**
     * Fires on the main thread whenever a restart or renderer death
     * swaps in a fresh WebView. The UI host must attach the new view
     * (replacing the old one): view-posted work only runs attached.
     * The callback must return fast and never block.
     */
    @Volatile
    var onViewRecreated: ((WebView) -> Unit)? = null

    /**
     * Creates the trusted WebView and announces it to Core. Must be called
     * before any request can queue; false means this WebView cannot host
     * the secure runtime bridge.
     */
    suspend fun start(): Boolean {
        withContext(Dispatchers.Main.immediate) {
            synchronized(lock) {
                if (started) return@withContext
                val candidate = TrustedRuntimeWebView(
                    context,
                    crashPolicy,
                    onRuntimeMessage = { payload, generation, reply ->
                        handlePageMessage(payload, generation, reply)
                    },
                    documentStartScript = HostChannel.installScript(hostVersion, engineVersion),
                    mediaInterceptor = { url, range -> serveMedia(url, range) },
                    onRendererGone = { dead -> scope.launch { onRendererGone(dead) } },
                    onComponentProbeDone = { passed ->
                        if (passed) scope.launch { rereportReady() }
                    },
                )
                when (val endpoint = candidate.create()) {
                    is TrustedRuntimeEndpoint.Ready -> {
                        owner = candidate
                        webView = endpoint.webView
                        liveGeneration = endpoint.generation
                        session = newSession(endpoint.generation)
                        started = true
                    }
                    is TrustedRuntimeEndpoint.Unsupported -> return@withContext
                }
            }
            reportConnected(liveGeneration)
        }
        return synchronized(lock) { started }
    }

    /** Tears the renderer down and reports its disconnection. Best effort. */
    suspend fun close() {
        val dead = liveGeneration
        liveGeneration = 0L
        if (dead != 0L) runCatching { report(disconnectedReport(dead)) }
        withContext(Dispatchers.Main.immediate) {
            synchronized(lock) {
                webView?.let { view ->
                    (view.parent as? ViewGroup)?.removeView(view)
                    owner?.destroy(view)
                }
                owner = null
                webView = null
                session = null
                grants = null
                started = false
            }
        }
        scope.cancel()
        runCatching { worker.shutdownNow() }
    }

    private fun newSession(rendererGeneration: Long): RuntimeHostSession =
        RuntimeHostSession(
            hostVersion, engineVersion,
            rendererGeneration,
            items = emptyList(),
            activationId = "",
            onBoundary = { _, _ -> },
            onError = {},
            onProgress = {},
            crashPolicy = crashPolicy,
        )

    override fun handle(envelope: String): Int {
        if (envelope.isBlank() || envelope.length > MAX_ENVELOPE_CHARS) {
            return CoreRendererRequestCode.INVALID_ACTIVATION
        }
        val root = runCatching {
            kotlinx.serialization.json.Json.parseToJsonElement(envelope).jsonObject
        }.getOrNull() ?: return CoreRendererRequestCode.INVALID_ACTIVATION
        return when (root.stringOrNull("op")) {
            "activate" -> handleActivate(root)
            "clear" -> handleClear()
            "command" -> handleCommand(root)
            "capture" -> handleCapture(root)
            "restart" -> handleRestart()
            "show_safe_mode" -> handleShowSafeMode(root)
            "show_unavailable" -> handleShowUnavailable()
            else -> CoreRendererRequestCode.INVALID_ACTIVATION
        }
    }

    private fun handleActivate(root: JsonObject): Int {
        val pair = synchronized(lock) { session to webView }
        val current = pair.first ?: return CoreRendererRequestCode.NOT_READY
        val view = pair.second ?: return CoreRendererRequestCode.NOT_READY
        val activationId = root.stringOrNull("activationId")?.take(64)
        val generation = root["generation"]?.jsonPrimitive?.longOrNull
        val presentation = runCatching { root["presentation"]?.jsonObject }.getOrNull()
        if (activationId.isNullOrEmpty() || generation == null || presentation == null) {
            return CoreRendererRequestCode.INVALID_ACTIVATION
        }
        val authorized = mutableSetOf<MediaAuthorization.AuthorizedMedia>()
        val localFiles = mutableMapOf<String, String>()
        val mimeByVariant = mutableMapOf<String, String>()
        val content = runCatching {
            root["content"] as? JsonArray
        }.getOrNull() ?: return CoreRendererRequestCode.INVALID_ACTIVATION
        for (entry in content) {
            val grant = runCatching { entry.jsonObject }.getOrNull()
                ?: return CoreRendererRequestCode.INVALID_ACTIVATION
            val assetId = grant.stringOrNull("assetId")?.take(128)
            val variantId = grant.stringOrNull("variantId")?.take(128)
            val path = grant.stringOrNull("path")
            val mime = grant.stringOrNull("mimeType")?.take(128)
            if (assetId.isNullOrEmpty() || variantId.isNullOrEmpty() || path.isNullOrEmpty() || mime.isNullOrEmpty()) {
                return CoreRendererRequestCode.INVALID_ACTIVATION
            }
            if (!File(path).isFile) return CoreRendererRequestCode.RESOURCE_UNAVAILABLE
            authorized += MediaAuthorization.AuthorizedMedia(assetId, variantId)
            localFiles[variantId] = path
            mimeByVariant[variantId] = mime
        }
        val message = buildJsonObject {
            put("type", "presentation")
            put("presentation", presentation)
            put("activation", buildJsonObject {
                put("activationId", activationId)
                put("generation", generation)
            })
            root["timing"]?.let { put("timing", it) }
            root["projection"]?.let { put("projection", it) }
        }
        val parsed = RuntimeBridgeProtocol.parseHostMessage(message.toString()).getOrNull()
            ?: return CoreRendererRequestCode.INVALID_ACTIVATION
        // Plugin surfaces travel beside the presentation and reach the
        // runtime as its own host message, as on the reference players.
        val pluginsMessage = (root["plugins"] as? JsonArray)?.let { plugins ->
            val offset = root["clockOffsetMs"]?.jsonPrimitive?.longOrNull ?: 0L
            val pluginsJson = buildJsonObject {
                put("type", "plugins")
                put("plugins", plugins)
                put("clockOffsetMs", offset)
            }
            RuntimeBridgeProtocol.parseHostMessage(pluginsJson.toString()).getOrNull()
                ?: return CoreRendererRequestCode.INVALID_ACTIVATION
        }
        val stateGeneration = synchronized(lock) {
            val live = session ?: return CoreRendererRequestCode.NOT_READY
            grants = Grants(authorized, localFiles, mimeByVariant)
            live.offer(parsed)
            pluginsMessage?.let { live.offer(it) }
            live.currentStateGeneration()
        }
        owner?.nudge(view, stateGeneration)
        return CoreRendererRequestCode.QUEUED
    }

    private fun handleClear(): Int {
        val pair = synchronized(lock) { session to webView }
        val current = pair.first ?: return CoreRendererRequestCode.NOT_READY
        val view = pair.second ?: return CoreRendererRequestCode.NOT_READY
        val unavailable = buildJsonObject {
            put("type", "presentation")
            put("presentation", RuntimePresentationBuilder.build(RuntimeScreenState.Unavailable))
        }
        synchronized(lock) { grants = null }
        return offerPageMessage(current, view, unavailable.toString())
    }

    private fun handleCommand(root: JsonObject): Int {
        val pair = synchronized(lock) { session to webView }
        val current = pair.first ?: return CoreRendererRequestCode.NOT_READY
        val view = pair.second ?: return CoreRendererRequestCode.NOT_READY
        return when (root.stringOrNull("command")) {
            "retry_item", "skip_item" -> {
                val verb = if (root.stringOrNull("command") == "retry_item") "retry-item" else "skip-item"
                val message = buildJsonObject {
                    put("type", "command")
                    put("command", verb)
                }
                offerPageMessage(current, view, message.toString())
            }
            "reload" -> {
                view.post { view.reload() }
                CoreRendererRequestCode.QUEUED
            }
            "clear_website_data" -> {
                scope.launch(Dispatchers.Main.immediate) {
                    runCatching {
                        WebStorage.getInstance().deleteAllData()
                        CookieManager.getInstance().removeAllCookies(null)
                        view.clearCache(true)
                        view.clearFormData()
                    }
                }
                CoreRendererRequestCode.QUEUED
            }
            "identify" -> {
                val message = buildJsonObject {
                    put("type", "identify")
                    put("name", root.stringOrNull("name")?.take(128) ?: "player")
                    put("durationSeconds", root["durationSeconds"]?.jsonPrimitive?.intOrNull ?: 10)
                }
                offerPageMessage(current, view, message.toString())
            }
            else -> CoreRendererRequestCode.INVALID_ACTIVATION
        }
    }

    private fun offerPageMessage(session: RuntimeHostSession, view: WebView, json: String): Int {
        val parsed = RuntimeBridgeProtocol.parseHostMessage(json).getOrNull()
            ?: return CoreRendererRequestCode.INVALID_ACTIVATION
        val stateGeneration = synchronized(lock) {
            session.offer(parsed)
            session.currentStateGeneration()
        }
        owner?.nudge(view, stateGeneration)
        return CoreRendererRequestCode.QUEUED
    }

    private fun handleCapture(root: JsonObject): Int {
        synchronized(lock) {
            session ?: return CoreRendererRequestCode.NOT_READY
        }
        val requestId = root.stringOrNull("requestId")?.take(128)
        val maxWidth = root["maxWidth"]?.jsonPrimitive?.intOrNull
        val maxHeight = root["maxHeight"]?.jsonPrimitive?.intOrNull
        val maxBytes = root["maxBytes"]?.jsonPrimitive?.intOrNull
        if (requestId.isNullOrEmpty() || maxWidth == null || maxHeight == null || maxBytes == null ||
            maxWidth <= 0 || maxHeight <= 0 || maxBytes <= 0
        ) {
            return CoreRendererRequestCode.INVALID_ACTIVATION
        }
        val capture = captureFrame
        scope.launch {
            if (capture == null) {
                report(unavailableCapture(requestId, "capture_unavailable"))
                return@launch
            }
            val image = runCatching { capture(maxWidth, maxHeight) }.getOrNull()
            if (image == null) {
                report(unavailableCapture(requestId, "capture_failed"))
            } else if (image.bytes.size > maxBytes) {
                report(unavailableCapture(requestId, "image_too_large"))
            } else {
                report(
                    buildJsonObject {
                        put("type", "capture")
                        put("requestId", requestId)
                        put("jpegBase64", Base64.encodeToString(image.bytes, Base64.NO_WRAP))
                        put("width", image.width)
                        put("height", image.height)
                    }.toString(),
                )
            }
        }
        return CoreRendererRequestCode.QUEUED
    }

    private fun unavailableCapture(requestId: String, code: String): String =
        buildJsonObject {
            put("type", "capture")
            put("requestId", requestId)
            put("unavailable", true)
            put("code", code)
        }.toString()

    private fun handleRestart(): Int {
        synchronized(lock) {
            session ?: return CoreRendererRequestCode.NOT_READY
        }
        scope.launch { recreate() }
        return CoreRendererRequestCode.QUEUED
    }

    private suspend fun recreate() {
        val dead = liveGeneration
        if (dead == 0L) return
        liveGeneration = 0L
        runCatching { report(disconnectedReport(dead)) }
        withContext(Dispatchers.Main.immediate) {
            var swapped: WebView? = null
            val fresh = synchronized(lock) {
                val candidate = owner ?: return@withContext
                val old = webView ?: return@withContext
                (old.parent as? ViewGroup)?.removeView(old)
                candidate.destroy(old)
                crashPolicy.onRecreated()
                val created = candidate.create()
                val endpoint = created as? TrustedRuntimeEndpoint.Ready ?: run {
                    started = false
                    webView = null
                    session = null
                    grants = null
                    return@withContext
                }
                webView = endpoint.webView
                liveGeneration = endpoint.generation
                session = newSession(endpoint.generation)
                swapped = endpoint.webView
                endpoint.generation
            }
            swapped?.let { onViewRecreated?.invoke(it) }
            if (fresh != 0L) reportConnected(fresh)
        }
    }

    private fun handleShowSafeMode(root: JsonObject): Int {
        val pair = synchronized(lock) { session to webView }
        val current = pair.first ?: return CoreRendererRequestCode.NOT_READY
        val view = pair.second ?: return CoreRendererRequestCode.NOT_READY
        val reason = root.stringOrNull("reason")?.take(128) ?: "recovery"
        val surface = buildJsonObject {
            put("type", "presentation")
            put("presentation", RuntimePresentationBuilder.build(RuntimeScreenState.SafeMode(reason)))
        }
        // Surface only: Core keeps its current activation and its own
        // safe-mode flag, so clearing safe mode re-pushes content.
        return offerPageMessage(current, view, surface.toString())
    }

    private fun handleShowUnavailable(): Int {
        val pair = synchronized(lock) { session to webView }
        val current = pair.first ?: return CoreRendererRequestCode.NOT_READY
        val view = pair.second ?: return CoreRendererRequestCode.NOT_READY
        val unavailable = buildJsonObject {
            put("type", "presentation")
            put("presentation", RuntimePresentationBuilder.build(RuntimeScreenState.Unavailable))
        }
        return offerPageMessage(current, view, unavailable.toString())
    }

    private fun serveMedia(url: String, range: String?): WebResourceResponse? {
        val current = grants ?: return null
        val resolved = TcMediaBridge.resolve(url, current.authorized, current.localFiles, current.mimeByVariant, range)
            ?: return null
        return TcMediaBridge.toResponse(resolved)
    }

    private fun handlePageMessage(payload: String, generation: Long, reply: JavaScriptReplyProxy?) {
        val current = synchronized(lock) { session } ?: return
        val response = current.handlePageMessage(payload, generation, reply)
        if (response != null && reply != null) {
            runCatching {
                reply.postMessage(response)
                current.responseDelivered(response)
            }
        }
        scope.launch { forwardToCore(payload, generation) }
    }

    private suspend fun forwardToCore(payload: String, generation: Long) {
        if (generation != liveGeneration) return
        when (val parsed = RuntimeBridgeProtocol.parseRuntimeReport(payload)) {
            is RuntimeBridgeProtocol.RuntimeReport.Ready -> report(readyReport(generation))
            is RuntimeBridgeProtocol.RuntimeReport.PresentationResult -> {
                val ref = activationRefOf(payload) ?: return
                if (parsed.outcome == "accepted") {
                    report(
                        buildJsonObject {
                            put("type", "accepted")
                            put("generation", generation)
                            put("activationId", ref.first)
                            put("activationGeneration", ref.second)
                        }.toString(),
                    )
                } else {
                    report(
                        buildJsonObject {
                            put("type", "rejected")
                            put("generation", generation)
                            put("activationId", ref.first)
                            put("activationGeneration", ref.second)
                            put("code", "rejected")
                        }.toString(),
                    )
                }
            }
            is RuntimeBridgeProtocol.RuntimeReport.Evidence -> {
                val ref = activationRefOf(payload) ?: return
                report(
                    buildJsonObject {
                        put("type", "progress")
                        put("generation", generation)
                        put("activationId", ref.first)
                        put("activationGeneration", ref.second)
                        put("kind", parsed.kind)
                        parsed.itemId?.let { put("itemId", it) }
                        parsed.zoneId?.let { put("zoneId", it) }
                    }.toString(),
                )
            }
            is RuntimeBridgeProtocol.RuntimeReport.PlaybackError -> {
                val ref = activationRefOf(payload) ?: return
                report(
                    buildJsonObject {
                        put("type", "error")
                        put("generation", generation)
                        put("activationId", ref.first)
                        put("activationGeneration", ref.second)
                        put("code", "playback_error")
                        parsed.itemId?.let { put("itemId", it) }
                        put("message", parsed.message)
                    }.toString(),
                )
            }
            null -> return
        }
    }

    /**
     * The activation reference the page echoes in its reports: the
     * nested `activation` object per the host contract, or a bare
     * `activationId` string with no generation. Generation zero never
     * matches a live Core activation, so the fallback cannot apply a
     * stale report.
     */
    private fun activationRefOf(raw: String): Pair<String, Long>? {
        val root = runCatching {
            kotlinx.serialization.json.Json.parseToJsonElement(raw).jsonObject
        }.getOrNull() ?: return null
        val nested = runCatching { root["activation"]?.jsonObject }.getOrNull()
        if (nested != null) {
            val id = nested.stringOrNull("activationId")?.take(64) ?: return null
            val generation = nested["generation"]?.jsonPrimitive?.longOrNull ?: 0L
            return id to generation
        }
        val direct = root.stringOrNull("activationId")?.take(64) ?: return null
        return direct to 0L
    }

    private fun readyReport(generation: Long): String {
        val support = RuntimeSupportAssessment.assess(
            componentProbePassed = RuntimeComponentProbe.passed,
        )
        val schemas = RuntimeSupportAssessment.schemasFor(support)
        return buildJsonObject {
            put("type", "ready")
            put("generation", generation)
            put(
                "report",
                buildJsonObject {
                    put("features", JsonArray(FEATURES.map { JsonPrimitive(it) }))
                    put(
                        "support",
                        buildJsonObject {
                            put(
                                "presentationSchemas",
                                JsonArray(schemas.map { JsonPrimitive(it) }),
                            )
                            put(
                                "declarativeCapabilities",
                                buildJsonObject {
                                    for ((name, version) in PlayerPresentationSupport.native) {
                                        put(name, version)
                                    }
                                },
                            )
                            put(
                                "widgetComponents",
                                buildJsonObject {
                                    if (support.componentRuntimeSupported) {
                                        for ((name, version) in WidgetComponentCapabilities.WIDGET_COMPONENT_CAPABILITIES) {
                                            put(name, version)
                                        }
                                    }
                                },
                            )
                        },
                    )
                },
            )
        }.toString()
    }

    private suspend fun reportConnected(generation: Long) {
        if (generation == 0L) return
        runCatching {
            report(
                buildJsonObject {
                    put("type", "connected")
                    put("generation", generation)
                }.toString(),
            )
        }
    }

    private suspend fun rereportReady() {
        val generation = liveGeneration
        if (generation == 0L) return
        runCatching { report(readyReport(generation)) }
    }

    private suspend fun onRendererGone(dead: Long) {
        if (dead == 0L || dead != liveGeneration) return
        recreate()
    }

    private fun disconnectedReport(generation: Long): String =
        buildJsonObject {
            put("type", "disconnected")
            put("generation", generation)
        }.toString()

    companion object {
        const val MAX_ENVELOPE_CHARS = 8 * 1024 * 1024

        /** The page features Core dispatch may rely on. Mirrors the legacy stage. */
        val FEATURES = listOf(
            "status-surfaces-v1",
            "image",
            "video",
            "render-tree-v1",
            "layout-v1",
            "synchronized-playback-v1",
            "span-viewport-v1",
            "remote-web-v1",
            "website",
            "youtube",
        )
    }
}

private fun JsonObject.stringOrNull(key: String): String? =
    this[key]?.jsonPrimitive?.contentOrNull
