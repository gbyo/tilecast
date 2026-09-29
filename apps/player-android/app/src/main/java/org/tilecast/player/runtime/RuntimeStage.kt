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
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.put
import org.tilecast.player.content.PlaybackSession
import org.tilecast.player.content.WebsiteNavigationPolicy
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
    var downloadPathByVariant: Map<String, String> = emptyMap()
}

private class RemoteBridge(private val onEvent: (kind: String, code: String?) -> Unit) {
    @JavascriptInterface
    fun report(state: String, detail: String?) {
        when (state) {
            "ended" -> onEvent("media-ended", null)
            "ready" -> onEvent("loaded", null)
            "playing" -> onEvent("stream-ready", null)
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
    items: List<ManifestItem> = session.content.manifest.playlist?.items ?: emptyList(),
    message: JsonObject,
    activationId: String,
    hostVersion: String,
    engineVersion: String,
    onBoundary: (itemId: String, assetId: String) -> Unit,
    onError: (String) -> Unit,
    onProgress: () -> Unit = {},
    onFirstFrame: (itemId: String) -> Unit = {},
    onItemTransition: (itemId: String) -> Unit = {},
    onPlaybackError: (itemId: String?, message: String) -> Unit = { _, _ -> },
    onWidgetStatus: (org.tilecast.player.content.WidgetPlaybackStatus) -> Unit = {},
    onWebsiteStatus: (org.tilecast.player.content.WebsitePlaybackStatus) -> Unit = {},
    onComponentProbeDone: (Boolean) -> Unit = {},
) {
    val manifest = session.content.manifest
    // Recreated only on renderer death; new presentations reuse the WebView
    // and arrive through state replay plus a numeric nudge.
    var instance by remember { mutableIntStateOf(0) }
    val crashPolicy = remember { RuntimeCrashPolicy() }
    // Status identity comes from the verified manifest, never the page.
    val widgetProviders = manifest.widgets.associate { it.assetId to it.provider }
    val websiteAssets = manifest.websites.map { it.assetId }.toSet()
    key(instance) {
        val rendererGeneration = crashPolicy.currentGeneration()
        val latestBoundary = rememberUpdatedState(onBoundary)
        val latestError = rememberUpdatedState(onError)
        val latestProgress = rememberUpdatedState(onProgress)
        val latestFirstFrame = rememberUpdatedState(onFirstFrame)
        val latestTransition = rememberUpdatedState(onItemTransition)
        val latestPlaybackError = rememberUpdatedState(onPlaybackError)
        val latestWidgetStatus = rememberUpdatedState(onWidgetStatus)
        val latestWebsiteStatus = rememberUpdatedState(onWebsiteStatus)
        val latestProbeDone = rememberUpdatedState(onComponentProbeDone)
        val runtimeSession = remember(rendererGeneration) {
            RuntimeHostSession(
                hostVersion, engineVersion,
                rendererGeneration,
                items, activationId,
                { itemId, assetId -> latestBoundary.value(itemId, assetId) },
                { message -> latestError.value(message) },
                { latestProgress.value() },
                { itemId -> latestFirstFrame.value(itemId) },
                { itemId -> latestTransition.value(itemId) },
                { itemId, message -> latestPlaybackError.value(itemId, message) },
                { status -> latestWidgetStatus.value(status) },
                { status -> latestWebsiteStatus.value(status) },
                widgetProviders, websiteAssets,
                crashPolicy,
            )
        }
        var surfaces by remember { mutableStateOf(emptyList<Surface>()) }
        val refs = remember { StageRefs() }
        val authorized = manifest.assets
            .map { AuthorizedMedia(it.assetId, it.variantId) }
            .toSet()
        val mimeByVariant = manifest.assets.associate { it.variantId to it.mimeType }
        val downloadPathByVariant = manifest.assets.associate { it.variantId to it.downloadPath }
        // The trusted WebView survives presentation replacement, so its
        // interceptor reads current grants/maps through these mutable refs.
        refs.authorized = authorized
        refs.localFiles = session.content.localFiles
        refs.mimeByVariant = mimeByVariant
        refs.downloadPathByVariant = downloadPathByVariant

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
                widgetProviders = widgetProviders,
                websiteAssets = websiteAssets,
                instance = instance,
                refs = refs,
                crashPolicy = crashPolicy,
                runtimeSession = runtimeSession,
                surfaces = surfaces,
                session = session,
                hostVersion = hostVersion,
                engineVersion = engineVersion,
                onComponentProbeDone = { latestProbeDone.value(it) },
                onIncrementInstance = {
                    crashPolicy.onRecreated()
                    instance++
                },
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
    widgetProviders: Map<String, String>,
    websiteAssets: Set<String>,
    instance: Int,
    refs: StageRefs,
    crashPolicy: RuntimeCrashPolicy,
    runtimeSession: RuntimeHostSession,
    surfaces: List<Surface>,
    session: PlaybackSession,
    hostVersion: String,
    engineVersion: String,
    onComponentProbeDone: (Boolean) -> Unit = {},
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
            runtimeSession.updatePresentation(items, activationId, widgetProviders, websiteAssets)
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
                        onComponentProbeDone = onComponentProbeDone,
                        mediaInterceptor = { url, range ->
                            val resolved = TcMediaBridge.resolve(
                                url, refs.authorized, refs.localFiles, refs.mimeByVariant, range,
                            )
                            resolved?.let(TcMediaBridge::toResponse)
                                // Stream-policy and not-yet-cached variants have
                                // no cache file: proxy the authenticated server
                                // bytes (Range included) with the credential
                                // held in the host, never in the runtime.
                                ?: TcMediaStreamFallback.fetch(
                                    session.serverUrl, session.credential, url,
                                    refs.authorized, refs.downloadPathByVariant,
                                    refs.mimeByVariant, range,
                                )
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
            surfaces.forEach { surface ->
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
        .alpha(if (surface.visible) 1f else 0f)
    if (surface.page != null) {
        PageRemoteView(surface, modifier, onRemoteEvent)
    } else if (surface.youTube != null) {
        YouTubeRemoteView(surface, origin, modifier, onRemoteEvent)
    }
}

private fun setPageAudioMuted(view: WebView, muted: Boolean) {
    if (WebViewFeature.isFeatureSupported(WebViewFeature.MUTE_AUDIO)) {
        runCatching { WebViewCompat.setAudioMuted(view, muted) }
        return
    }
    val flag = if (muted) "true" else "false"
    view.evaluateJavascript(
        """(function(m){
          var states=window.__tilecastMuteStates||(window.__tilecastMuteStates=new WeakMap());
          function apply(){
            document.querySelectorAll('audio,video').forEach(function(el){
              if(m){if(!states.has(el))states.set(el,!!el.muted);el.muted=true;}
              else if(states.has(el)){el.muted=states.get(el);states.delete(el);}
            });
          }
          window.__tilecastHostMuted=m;apply();
          if(!window.__tilecastMuteObserver){
            window.__tilecastMuteObserver=new MutationObserver(function(){if(window.__tilecastHostMuted)apply();});
            window.__tilecastMuteObserver.observe(document.documentElement||document,{childList:true,subtree:true});
          }
        })($flag);""".trimIndent(),
        null,
    )
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
    val latestSurface = rememberUpdatedState(surface)
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
                setPageAudioMuted(this, surface.muted || !surface.visible)
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
                    private fun shouldBlock(target: String?): Boolean {
                        val url = target ?: return true
                        if (WebsiteNavigationPolicy.allows(url, site)) return false
                        onRemoteEvent("navigation-blocked", Uri.parse(url).host)
                        return true
                    }

                    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                        shouldBlock(request.url?.toString())

                    @Suppress("DEPRECATION")
                    override fun shouldOverrideUrlLoading(view: WebView, url: String): Boolean =
                        shouldBlock(url)
                    override fun onPageCommitVisible(view: WebView, url: String) {
                        onRemoteEvent("stream-ready", null)
                    }
                    override fun onPageFinished(view: WebView, url: String) {
                        view.setInitialScale(page.zoomPercent)
                        view.post { view.scrollTo(page.scrollX, page.scrollY) }
                        val current = latestSurface.value
                        setPageAudioMuted(view, current.muted || !current.visible)
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
            view.isClickable = surface.visible
            view.isFocusable = surface.visible
            setPageAudioMuted(view, surface.muted || !surface.visible)
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
    var lastAudioState by remember(surface.surfaceId) { mutableStateOf<Pair<Boolean, Int>?>(null) }
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
            container.isClickable = surface.visible
            container.isFocusable = surface.visible
            val shouldMute = content.muted || surface.muted || !surface.visible
            val audioState = shouldMute to content.volume.coerceIn(0, 100)
            if (audioState != lastAudioState) {
                lastAudioState = audioState
                webView?.evaluateJavascript(
                    "if(window.tilecastSetMuted){window.tilecastSetMuted($shouldMute);}if(window.player){window.player.setVolume(${audioState.second});}",
                    null,
                )
            }
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

/** Host-view YouTube surface document (runtime remote-web path). */
private fun YouTubeSourceConfig.loadTimeoutSeconds() = 30_000L

internal fun youtubeHTML(
    config: YouTubeSourceConfig,
    origin: String,
    startOffsetMs: Long = 0,
): String {
    val id = if (config.kind == "playlist") config.playlistId.orEmpty() else config.videoId.orEmpty()
    val listOptions = if (config.kind == "playlist") "listType:'playlist',list:'$id'," else "videoId:'$id',"
    val loopPlaylist = if (config.loop && config.kind == "video") ",playlist:'$id'" else ""
    val captions = if (config.captions) "cc_load_policy:1,cc_lang_pref:'${config.captionLanguage}'," else "cc_load_policy:0,"
    val end = config.endSeconds?.let { "end:$it," }.orEmpty()
    val synchronizedStartSeconds = config.startSeconds + startOffsetMs.coerceAtLeast(0) / 1000.0
    return """<!doctype html><html><head><meta name="referrer" content="origin"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"><style>html,body,#player,iframe{margin:0;width:100%;height:100%;overflow:hidden;background:transparent;border:0}</style></head><body><div id="player"></div><script src="https://www.youtube.com/iframe_api"></script><script>
      var player; var tilecastMuted=${if (config.muted) "true" else "false"}; function send(s,d){try{Tilecast.report(s,d||null)}catch(e){}}
      window.tilecastSetMuted=function(m){tilecastMuted=!!m;if(player){if(tilecastMuted){player.mute();}else{player.unMute();}}};
      function onYouTubeIframeAPIReady(){player=new YT.Player('player',{width:'100%',height:'100%',${listOptions}playerVars:{autoplay:1,playsinline:1,controls:${if (config.controls) 1 else 0},disablekb:1,fs:0,rel:0,start:$synchronizedStartSeconds,${end}loop:${if (config.loop) 1 else 0}$loopPlaylist,origin:'$origin',$captions},events:{onReady:function(e){if(tilecastMuted){e.target.mute();}else{e.target.unMute();}e.target.setVolume(${config.volume});e.target.playVideo();send('ready')},onStateChange:function(e){var m={0:'ended',1:'playing',2:'paused',3:'buffering',5:'ready'};send(m[e.data]||'waiting')},onError:function(e){send('player_error','youtube_'+e.data)}}});}
    </script></body></html>"""
}
