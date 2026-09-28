package org.tilecast.player.runtime

import android.annotation.SuppressLint
import android.net.Uri
import android.net.http.SslError
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.GeolocationPermissions
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.SslErrorHandler
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.webkit.JavaScriptReplyProxy
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.put
import org.tilecast.player.content.PlaybackSession
import org.tilecast.player.content.WebsiteNavigationPolicy
import org.tilecast.player.content.youtubeHTML
import org.tilecast.player.network.ManifestItem
import org.tilecast.player.network.ManifestWebsite
import org.tilecast.player.network.YouTubeSourceConfig
import org.tilecast.player.runtime.MediaAuthorization.AuthorizedMedia
import org.tilecast.player.runtime.RemoteWebHostManager.Surface

private class StageRefs {
    var owner: TrustedRuntimeWebView? = null
    var webView: WebView? = null
    var authorized: Set<AuthorizedMedia> = emptySet()
    var localFiles: Map<String, String> = emptyMap()
    var mimeByVariant: Map<String, String> = emptyMap()
}

private class RemoteBridge(private val onEvent: (kind: String, code: String?) -> Unit) {
    @JavascriptInterface
    fun report(state: String, detail: String?) {
        when (state) {
            "ended" -> onEvent("media-ended", null)
            "ready" -> onEvent("loaded", null)
            "playing" -> {
                onEvent("loaded", null)
                onEvent("stream-ready", null)
            }
            "player_error", "autoplay_blocked" -> onEvent("failed", detail ?: state)
            else -> Unit
        }
    }
}

/** Shared-runtime presentation stage with the host-owned remote-web layer.
 *
 * Hierarchy: trusted Player Runtime WebView filling the screen, with one
 * isolated remote WebView per runtime-requested surface positioned from the
 * runtime-supplied viewport. Remote views never receive the trusted bridge.
 * Credentials, networking, cache, and reporting stay native.
 */
@Composable
fun SharedRuntimePlayback(
    session: PlaybackSession,
    message: JsonObject,
    activationId: String,
    hostVersion: String,
    engineVersion: String,
    onBoundary: (itemId: String, assetId: String) -> Unit,
    onError: (String) -> Unit,
    onProgress: () -> Unit = {},
    onFirstFrame: (itemId: String) -> Unit = {},
    onItemTransition: (itemId: String) -> Unit = {},
) {
    val manifest = session.content.manifest
    val items = manifest.playlist?.items ?: emptyList()
    // Recreated only on renderer death; new presentations reuse the WebView
    // and arrive through state replay plus a numeric nudge.
    var instance by remember { mutableIntStateOf(0) }
    key(instance) {
        val crashPolicy = remember { RuntimeCrashPolicy() }
        val runtimeSession = remember {
            RuntimeHostSession(
                hostVersion, engineVersion,
                crashPolicy.currentGeneration(),
                items, activationId,
                onBoundary, onError, onProgress, onFirstFrame, onItemTransition,
            )
        }
        var surfaces by remember { mutableStateOf(emptyList<Surface>()) }
        val refs = remember { StageRefs() }
        val authorized = remember(message) {
            manifest.assets.map { AuthorizedMedia(it.assetId, it.variantId) }.toSet()
        }
        val mimeByVariant = remember(message) {
            manifest.assets.associate { it.variantId to it.mimeType }
        }
        // The trusted WebView survives presentation replacement, so its
        // interceptor reads current grants/maps through these mutable refs.
        refs.authorized = authorized
        refs.localFiles = session.content.localFiles
        refs.mimeByVariant = mimeByVariant

        // Fail closed before creating anything when the secure bridge is
        // unavailable on this device/WebView combination.
        val context = LocalContext.current
        val bridgeOk = remember(hostVersion, engineVersion) {
            TrustedRuntimeWebView(context).bridgeAvailable()
        }
        if (!bridgeOk) {
            LaunchedEffect(Unit) { onError("shared runtime unsupported on this WebView") }
        } else {
            RuntimeStageBody(
                message = message,
                activationId = activationId,
                items = items,
                instance = instance,
                refs = refs,
                crashPolicy = crashPolicy,
                runtimeSession = runtimeSession,
                surfaces = surfaces,
                session = session,
                hostVersion = hostVersion,
                engineVersion = engineVersion,
                onIncrementInstance = { instance++ },
                onError = onError,
                onHandlePageMessage = { payload, generation, reply ->
                    val response = runtimeSession.handlePageMessage(payload, generation, reply)
                    if (response != null && reply != null) {
                        val delivered = runCatching {
                            reply.postMessage(response)
                            true
                        }.getOrDefault(false)
                        if (delivered) runtimeSession.responseDelivered(response)
                    }
                    surfaces = runtimeSession.remoteWeb.snapshot()
                },
            )
        }
    }
}

@Composable
private fun RuntimeStageBody(
    message: JsonObject,
    activationId: String,
    items: List<ManifestItem>,
    instance: Int,
    refs: StageRefs,
    crashPolicy: RuntimeCrashPolicy,
    runtimeSession: RuntimeHostSession,
    surfaces: List<Surface>,
    session: PlaybackSession,
    hostVersion: String,
    engineVersion: String,
    onIncrementInstance: () -> Unit,
    onError: (String) -> Unit,
    onHandlePageMessage: (String, Long, JavaScriptReplyProxy?) -> Unit,
) {
        fun handlePageMessage(payload: String, generation: Long, reply: JavaScriptReplyProxy?) {
            onHandlePageMessage(payload, generation, reply)
        }

        LaunchedEffect(message, activationId, items, instance) {
            val parsed = RuntimeBridgeProtocol.parseHostMessage(message.toString()).getOrNull()
            if (parsed == null) {
                onError("shared presentation refused")
                return@LaunchedEffect
            }
            runtimeSession.updatePresentation(items, activationId)
            runtimeSession.offer(parsed)
            refs.webView?.let { refs.owner?.nudge(it, runtimeSession.currentStateGeneration()) }
        }

        Box(Modifier.fillMaxSize().background(Color.Black)) {
            AndroidView(
                modifier = Modifier.fillMaxSize(),
                factory = { context ->
                    val owner = TrustedRuntimeWebView(
                        context,
                        crashPolicy,
                        onRuntimeMessage = { payload, generation, reply ->
                            handlePageMessage(payload, generation, reply)
                        },
                        documentStartScript = HostChannel.installScript(hostVersion, engineVersion),
                        mediaInterceptor = { url, range ->
                            val resolved = TcMediaBridge.resolve(
                                url, refs.authorized, refs.localFiles, refs.mimeByVariant, range,
                            )
                            resolved?.let(TcMediaBridge::toResponse)
                        },
                        onRendererGone = { onIncrementInstance() },
                    )
                    refs.owner = owner
                    when (val endpoint = owner.create()) {
                        is TrustedRuntimeEndpoint.Ready -> {
                            refs.webView = endpoint.webView
                            endpoint.webView
                        }
                        is TrustedRuntimeEndpoint.Unsupported -> {
                            refs.webView = null
                            WebView(context).also {
                                it.tag = "unsupported"
                                it.visibility = View.GONE
                            }
                        }
                    }
                },
                onRelease = { view ->
                    if (view.tag != "unsupported") refs.owner?.destroy(view)
                    else runCatching { view.destroy() }
                },
            )
            val density = LocalDensity.current.density
            surfaces.filter { it.visible }.forEach { surface ->
                key(surface.surfaceId) {
                    RemoteSurfaceView(
                        surface = surface,
                        origin = session.serverUrl.trimEnd('/'),
                        densityScale = density,
                        onRemoteEvent = { kind, code ->
                            runtimeSession.postRemoteEvent(surface.surfaceId, kind, code)
                        },
                    )
                }
            }
        }
}

@Composable
private fun RemoteSurfaceView(
    surface: Surface,
    origin: String,
    densityScale: Float,
    onRemoteEvent: (kind: String, code: String?) -> Unit,
) {
    val px = surface.viewportPx
    val modifier = Modifier
        .offset((px.x / densityScale).dp, (px.y / densityScale).dp)
        .size(((px.width / densityScale).coerceAtLeast(1f)).dp, ((px.height / densityScale).coerceAtLeast(1f)).dp)
    if (surface.page != null) {
        PageRemoteView(surface, modifier, onRemoteEvent)
    } else if (surface.youTube != null) {
        YouTubeRemoteView(surface, origin, modifier, onRemoteEvent)
    }
}

@SuppressLint("SetJavaScriptEnabled")
@Composable
private fun PageRemoteView(
    surface: Surface,
    modifier: Modifier,
    onRemoteEvent: (kind: String, code: String?) -> Unit,
) {
    val page = surface.page ?: return
    // The exact legacy navigation policy, reused against the runtime's spec.
    val site = remember(surface.surfaceId) {
        ManifestWebsite(
            assetId = "", name = "", url = page.url, allowedHosts = page.allowedHosts,
            javascriptEnabled = page.javascriptEnabled, domStorageEnabled = page.domStorageEnabled,
            cookiePolicy = page.cookiePolicy, reloadPolicy = "on_each_activation",
            refreshIntervalSeconds = null, loadTimeoutSeconds = 20, zoomPercent = page.zoomPercent,
            scrollX = page.scrollX, scrollY = page.scrollY, customUserAgent = page.userAgent,
            backgroundColor = page.backgroundColor, failureBehavior = "placeholder",
            fallbackImageAssetId = null, fallbackVariantId = null,
        )
    }
    var lastReload by remember(surface.surfaceId) { mutableIntStateOf(0) }
    AndroidView(
        modifier = modifier,
        factory = { context ->
            WebView(context).apply {
                settings.javaScriptEnabled = page.javascriptEnabled
                settings.domStorageEnabled = page.domStorageEnabled
                settings.allowFileAccess = false
                settings.allowContentAccess = false
                settings.allowFileAccessFromFileURLs = false
                settings.allowUniversalAccessFromFileURLs = false
                settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
                settings.setGeolocationEnabled(false)
                settings.mediaPlaybackRequiresUserGesture = false
                settings.cacheMode = WebSettings.LOAD_DEFAULT
                CookieManager.getInstance().setAcceptCookie(page.cookiePolicy != "disabled")
                CookieManager.getInstance().setAcceptThirdPartyCookies(
                    this,
                    page.cookiePolicy == "first_and_third_party",
                )
                if (page.userAgent.isNotBlank()) settings.userAgentString = page.userAgent
                webChromeClient = object : WebChromeClient() {
                    override fun onPermissionRequest(request: PermissionRequest) = request.deny()
                    override fun onGeolocationPermissionsShowPrompt(
                        origin: String,
                        callback: GeolocationPermissions.Callback,
                    ) = callback.invoke(origin, false, false)
                    override fun onCreateWindow(
                        view: WebView,
                        isDialog: Boolean,
                        isUserGesture: Boolean,
                        resultMsg: android.os.Message,
                    ) = false
                    override fun onShowFileChooser(
                        webView: WebView,
                        filePathCallback: ValueCallback<Array<android.net.Uri>>,
                        fileChooserParams: FileChooserParams,
                    ): Boolean {
                        filePathCallback.onReceiveValue(null)
                        return false
                    }
                }
                webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                        val target = request.url?.toString() ?: return true
                        if (WebsiteNavigationPolicy.allows(target, site)) return false
                        onRemoteEvent("navigation-blocked", Uri.parse(target).host)
                        return true
                    }
                    override fun onPageCommitVisible(view: WebView, url: String) {
                        onRemoteEvent("stream-ready", null)
                    }
                    override fun onPageFinished(view: WebView, url: String) {
                        view.setInitialScale(page.zoomPercent)
                        view.post { view.scrollTo(page.scrollX, page.scrollY) }
                        onRemoteEvent("loaded", null)
                    }
                    override fun onReceivedError(
                        view: WebView,
                        request: WebResourceRequest,
                        error: WebResourceError,
                    ) {
                        if (!request.isForMainFrame) return
                        val category = when (error.errorCode) {
                            WebViewClient.ERROR_HOST_LOOKUP -> "dns_failure"
                            WebViewClient.ERROR_CONNECT -> "connection_failure"
                            WebViewClient.ERROR_TIMEOUT -> "load_timeout"
                            WebViewClient.ERROR_FAILED_SSL_HANDSHAKE -> "tls_failure"
                            WebViewClient.ERROR_UNSUPPORTED_SCHEME -> "unsupported_scheme"
                            else -> "unknown_webview_error"
                        }
                        onRemoteEvent("failed", category)
                    }
                    override fun onReceivedHttpError(
                        view: WebView,
                        request: WebResourceRequest,
                        response: WebResourceResponse,
                    ) {
                        if (request.isForMainFrame && response.statusCode >= 400) {
                            onRemoteEvent("failed", "http_error")
                        }
                    }
                    override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
                        handler.cancel()
                        onRemoteEvent("failed", "tls_failure")
                    }
                    override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                        onRemoteEvent("failed", "renderer_crash")
                        view.post {
                            runCatching {
                                view.stopLoading()
                                view.loadUrl("about:blank")
                                view.removeAllViews()
                                view.destroy()
                            }
                        }
                        return true
                    }
                }
                loadUrl(page.url)
            }
        },
        update = { view ->
            if (surface.reloadCount != lastReload) {
                lastReload = surface.reloadCount
                view.reload()
            }
        },
        onRelease = { view ->
            runCatching {
                view.stopLoading()
                view.loadUrl("about:blank")
                view.clearHistory()
                view.removeAllViews()
                view.destroy()
            }
        },
    )
}

private val remoteJson = Json { ignoreUnknownKeys = true }

@SuppressLint("SetJavaScriptEnabled")
@Composable
private fun YouTubeRemoteView(
    surface: Surface,
    origin: String,
    modifier: Modifier,
    onRemoteEvent: (kind: String, code: String?) -> Unit,
) {
    val content = surface.youTube ?: return
    val config = remember(surface.surfaceId) {
        runCatching {
            remoteJson.decodeFromJsonElement<YouTubeSourceConfig>(
                buildJsonObject {
                    put("url", "")
                    put("kind", if (!content.playlistId.isNullOrBlank()) "playlist" else "video")
                    content.videoId?.let { put("videoId", it) }
                    content.playlistId?.let { put("playlistId", it) }
                    put("startSeconds", content.startSeconds)
                    content.endSeconds?.let { put("endSeconds", it) }
                    put("loop", content.loop)
                    put("muted", content.muted)
                    put("volume", content.volume)
                    put("captions", content.captions)
                    put("captionLanguage", content.captionLanguage)
                    put("controls", content.controls)
                },
            )
        }.getOrNull()
    } ?: return
    val html = remember(surface.surfaceId) { youtubeHTML(config, origin) }
    var lastReload by remember(surface.surfaceId) { mutableIntStateOf(0) }
    AndroidView(
        modifier = modifier.background(Color.Black),
        factory = { context ->
            FrameLayout(context).apply {
                val webView = WebView(context).apply {
                    setBackgroundColor(android.graphics.Color.TRANSPARENT)
                    layoutParams = FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.MATCH_PARENT,
                    )
                    settings.javaScriptEnabled = true
                    settings.domStorageEnabled = true
                    settings.mediaPlaybackRequiresUserGesture = false
                    settings.cacheMode = WebSettings.LOAD_DEFAULT
                    settings.allowFileAccess = false
                    settings.allowContentAccess = false
                    webChromeClient = WebChromeClient()
                    webViewClient = object : WebViewClient() {
                        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                            onRemoteEvent("failed", "renderer_crash")
                            return true
                        }
                    }
                    addJavascriptInterface(RemoteBridge(onRemoteEvent), "Tilecast")
                    loadDataWithBaseURL("$origin/", html, "text/html", "UTF-8", null)
                }
                addView(webView)
            }
        },
        update = { container ->
            val webView = container.getChildAt(0) as? WebView
            if (surface.reloadCount != lastReload) {
                lastReload = surface.reloadCount
                webView?.reload()
            }
            // create() begins muted; activation can immediately unmute the
            // host layer. Apply that state to the already-created IFrame.
            val shouldMute = content.muted || surface.muted
            webView?.evaluateJavascript(
                "if(window.tilecastSetMuted){window.tilecastSetMuted($shouldMute);}if(window.player){window.player.setVolume(${content.volume.coerceIn(0, 100)});}",
                null,
            )
        },
        onRelease = { container ->
            val webView = container.getChildAt(0) as? WebView
            runCatching {
                webView?.stopLoading()
                webView?.loadUrl("about:blank")
                webView?.removeJavascriptInterface("Tilecast")
                webView?.removeAllViews()
                webView?.destroy()
            }
            container.removeAllViews()
        },
    )
}
