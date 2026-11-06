package org.tilecast.player.runtime

import android.annotation.SuppressLint
import android.net.http.SslError
import android.os.Handler
import android.os.Looper
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
import androidx.compose.foundation.layout.requiredSize
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
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.viewinterop.AndroidView
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.tilecast.player.runtime.RemoteWebHostManager.PageContent
import org.tilecast.player.runtime.RemoteWebHostManager.Surface
import org.tilecast.player.runtime.RemoteWebHostManager.YouTubeContent

/** Posts one remote-web event back to the runtime page that owns [generation]. */
typealias RemoteWebEventSink = (generation: Long, surfaceId: String?, kind: String, code: String?) -> Unit

/**
 * The host-view layer for `remoteWeb: "host-view"`: one isolated WebView per
 * surface the runtime created, placed at the runtime-supplied viewport above
 * the trusted runtime view.
 *
 * Remote views never receive the trusted runtime bridge. The runtime owns
 * timing and failure policy; this layer only renders, enforces the main-frame
 * allowlist, and reports `loaded`, `stream-ready`, `navigation-blocked`,
 * `failed`, `media-ended` and `process-terminated`.
 */
@Composable
fun RemoteWebLayer(surfaces: List<Surface>, onEvent: RemoteWebEventSink) {
    if (surfaces.isEmpty()) return
    val density = LocalDensity.current
    val latestEvent = rememberUpdatedState(onEvent)
    Box(Modifier.fillMaxSize().clipToBounds()) {
        surfaces.forEach { surface ->
            key(surface.surfaceId, surface.serial) {
                val px = surface.viewportPx
                val placement = Modifier
                    .offset { IntOffset(px.x, px.y) }
                    .requiredSize(
                        with(density) { px.width.toDp() },
                        with(density) { px.height.toDp() },
                    )
                    // Hidden surfaces keep their view so a later show is instant.
                    .alpha(if (surface.visible) 1f else 0f)
                val emit: (String?, String, String?) -> Unit = { id, kind, code ->
                    latestEvent.value(surface.generation, id, kind, code)
                }
                RemoteSurface(surface, placement, emit)
            }
        }
    }
}

@Composable
private fun RemoteSurface(
    surface: Surface,
    modifier: Modifier,
    emit: (surfaceId: String?, kind: String, code: String?) -> Unit,
) {
    // A web process that died leaves its view unusable. The runtime sees
    // `process-terminated`; the view is rebuilt only if it asks for a reload.
    var dead by remember { mutableStateOf(false) }
    var incarnation by remember { mutableIntStateOf(0) }
    LaunchedEffect(surface.reloadCount) {
        if (dead) {
            dead = false
            incarnation++
        }
    }
    if (dead) return
    val surfaceEmit: (String, String?) -> Unit = { kind, code -> emit(surface.surfaceId, kind, code) }
    val onProcessGone: () -> Unit = {
        dead = true
        emit(null, "process-terminated", RemoteWebFailure.RENDERER_CRASH)
    }
    key(incarnation) {
        when {
            surface.page != null -> PageView(surface, surface.page, modifier, surfaceEmit, onProcessGone)
            surface.youTube != null -> YouTubeView(surface, surface.youTube, modifier, surfaceEmit, onProcessGone)
        }
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

private fun WebView.destroyQuietly() {
    runCatching {
        stopLoading()
        loadUrl("about:blank")
        clearHistory()
        removeAllViews()
        destroy()
    }
}

@SuppressLint("SetJavaScriptEnabled")
@Composable
private fun PageView(
    surface: Surface,
    page: PageContent,
    modifier: Modifier,
    emit: (kind: String, code: String?) -> Unit,
    onProcessGone: () -> Unit,
) {
    var lastReload by remember { mutableIntStateOf(surface.reloadCount) }
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
                settings.setSupportMultipleWindows(false)
                settings.javaScriptCanOpenWindowsAutomatically = false
                settings.mediaPlaybackRequiresUserGesture = false
                settings.cacheMode = WebSettings.LOAD_DEFAULT
                CookieManager.getInstance().setAcceptCookie(page.cookiePolicy != "disabled")
                CookieManager.getInstance().setAcceptThirdPartyCookies(
                    this,
                    page.cookiePolicy == "first_and_third_party",
                )
                if (page.userAgent.isNotBlank()) settings.userAgentString = page.userAgent
                RemoteWebColor.parse(page.backgroundColor)?.let(::setBackgroundColor)
                setInitialScale(RemoteWebZoom.initialScale(page.zoomPercent, resources.displayMetrics.density))
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
                    // The allowlist covers main-frame documents, per the remote-web
                    // contract; frames inside an allowed page are the page's own.
                    private fun blocked(request: WebResourceRequest): Boolean {
                        if (!request.isForMainFrame) return false
                        val target = request.url?.toString()
                        if (RemoteWebNavigationPolicy.allows(target, page)) return false
                        emit("navigation-blocked", RemoteWebNavigationPolicy.blockedHost(target))
                        return true
                    }

                    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                        blocked(request)

                    override fun onPageCommitVisible(view: WebView, url: String) {
                        emit("stream-ready", null)
                    }

                    override fun onPageFinished(view: WebView, url: String) {
                        view.post { view.scrollTo(page.scrollX, page.scrollY) }
                        val current = latestSurface.value
                        setPageAudioMuted(view, current.muted || !current.visible)
                        emit("loaded", null)
                    }

                    override fun onReceivedError(
                        view: WebView,
                        request: WebResourceRequest,
                        error: WebResourceError,
                    ) {
                        if (request.isForMainFrame) emit("failed", RemoteWebFailure.forLoadError(error.errorCode))
                    }

                    override fun onReceivedHttpError(
                        view: WebView,
                        request: WebResourceRequest,
                        response: WebResourceResponse,
                    ) {
                        if (request.isForMainFrame && RemoteWebFailure.isMainFrameHttpFailure(response.statusCode)) {
                            emit("failed", RemoteWebFailure.HTTP_ERROR)
                        }
                    }

                    override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
                        handler.cancel()
                        emit("failed", RemoteWebFailure.TLS_FAILURE)
                    }

                    override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                        onProcessGone()
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
        onRelease = { view -> view.destroyQuietly() },
    )
}

/** Receives wrapper state on the WebView's own thread and hands it to the main thread. */
private class YouTubeBridge(private val emit: (kind: String, code: String?) -> Unit) {
    private val main = Handler(Looper.getMainLooper())

    @JavascriptInterface
    fun report(state: String, detail: String?) {
        val event = YouTubeEmbed.eventFor(state, detail?.take(64)) ?: return
        main.post { emit(event.first, event.second) }
    }
}

@SuppressLint("SetJavaScriptEnabled")
@Composable
private fun YouTubeView(
    surface: Surface,
    content: YouTubeContent,
    modifier: Modifier,
    emit: (kind: String, code: String?) -> Unit,
    onProcessGone: () -> Unit,
) {
    val html = remember(surface.serial) { YouTubeEmbed.html(content) }
    var lastReload by remember { mutableIntStateOf(surface.reloadCount) }
    var lastMute by remember { mutableStateOf<Boolean?>(null) }
    val latestSurface = rememberUpdatedState(surface)
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
                    settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
                    settings.setGeolocationEnabled(false)
                    settings.setSupportMultipleWindows(false)
                    webChromeClient = object : WebChromeClient() {
                        override fun onPermissionRequest(request: PermissionRequest) = request.deny()
                        override fun onCreateWindow(
                            view: WebView,
                            isDialog: Boolean,
                            isUserGesture: Boolean,
                            resultMsg: android.os.Message,
                        ) = false
                    }
                    webViewClient = object : WebViewClient() {
                        // The wrapper never navigates its own document; the player frame is a subframe.
                        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                            if (!request.isForMainFrame) return false
                            emit("navigation-blocked", RemoteWebNavigationPolicy.blockedHost(request.url?.toString()))
                            return true
                        }

                        // The wrapper keeps the last mute decision, so a reloaded
                        // document applies it once its player is ready.
                        override fun onPageFinished(view: WebView, url: String) {
                            val current = latestSurface.value
                            val mute = YouTubeEmbed.effectiveMute(content, current.muted, current.visible)
                            view.evaluateJavascript(YouTubeEmbed.audioScript(mute, content.volume), null)
                        }

                        override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
                            handler.cancel()
                            emit("failed", RemoteWebFailure.TLS_FAILURE)
                        }

                        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                            onProcessGone()
                            return true
                        }
                    }
                    addJavascriptInterface(YouTubeBridge(emit), YouTubeEmbed.BRIDGE_NAME)
                    loadDataWithBaseURL(YouTubeEmbed.BASE_URL, html, "text/html", "UTF-8", null)
                }
                addView(webView)
            }
        },
        update = { container ->
            val webView = container.getChildAt(0) as? WebView
            container.isClickable = surface.visible
            container.isFocusable = surface.visible
            if (surface.reloadCount != lastReload) {
                lastReload = surface.reloadCount
                webView?.reload()
                lastMute = null
            }
            // The wrapper starts with the author's mute; apply the runtime's
            // decision, and re-apply it after a reload.
            val mute = YouTubeEmbed.effectiveMute(content, surface.muted, surface.visible)
            if (mute != lastMute) {
                lastMute = mute
                webView?.evaluateJavascript(YouTubeEmbed.audioScript(mute, content.volume), null)
            }
        },
        onRelease = { container ->
            val webView = container.getChildAt(0) as? WebView
            runCatching { webView?.removeJavascriptInterface(YouTubeEmbed.BRIDGE_NAME) }
            webView?.destroyQuietly()
            container.removeAllViews()
        },
    )
}
