package org.tilecast.player.runtime

import android.annotation.SuppressLint
import android.content.Context
import android.os.Build
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature

/** Encapsulated owner of the trusted Player Runtime WebView.
 *
 * Security posture: the runtime loads only from the app-owned HTTPS origin,
 * top-level navigation is confined to the packaged runtime tree, no bridge
 * object is exposed to any other origin, and an unsupported WebView
 * combination fails closed via [Unsupported] instead of falling back to
 * `addJavascriptInterface`.
 */
sealed interface TrustedRuntimeEndpoint {
    data class Ready(val webView: WebView, val generation: Long) : TrustedRuntimeEndpoint
    data class Unsupported(val reason: String) : TrustedRuntimeEndpoint
}

class TrustedRuntimeWebView(
    context: Context,
    private val crashPolicy: RuntimeCrashPolicy = RuntimeCrashPolicy(),
    private val onRuntimeMessage: (String, Long, JavaScriptReplyProxy?) -> Unit = { _, _, _ -> },
    private val documentStartScript: String = RuntimeBridgeProtocol.bootstrapScript(),
    /** Serves host-authorized media (tcmedia:) and sandbox frames (tcwidget:) to the trusted page. */
    private val mediaInterceptor: (url: String, rangeHeader: String?) -> WebResourceResponse? = { _, _ -> null },
    private val onRendererGone: (deadGeneration: Long) -> Unit = {},
    /**
     * Receives the Widget runtime feature-probe outcome. The first
     * capability heartbeat can leave before the startup WebView probe
     * completes, so a late result must re-advertise capabilities.
     */
    private val onComponentProbeDone: (Boolean) -> Unit = {},
) {
    private val appContext = context.applicationContext
    private val assetLoader = WebViewAssetLoader.Builder()
        .addPathHandler(
            TrustedRuntimeOrigin.ASSET_LOADER_PATH_PREFIX,
            WebViewAssetLoader.AssetsPathHandler(appContext),
        )
        .build()

    fun bridgeAvailable(): Boolean =
        WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) &&
            WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)

    @SuppressLint("SetJavaScriptEnabled")
    fun create(): TrustedRuntimeEndpoint {
        if (!bridgeAvailable()) {
            return TrustedRuntimeEndpoint.Unsupported(
                "secure runtime bridge unavailable: WebView lacks WebMessageListener or document-start script support",
            )
        }
        val generation = crashPolicy.currentGeneration()
        val webView = WebView(appContext)
        with(webView.settings) {
            javaScriptEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            allowFileAccessFromFileURLs = false
            allowUniversalAccessFromFileURLs = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            setGeolocationEnabled(false)
            mediaPlaybackRequiresUserGesture = false
            cacheMode = WebSettings.LOAD_DEFAULT
            domStorageEnabled = true
        }
        // Safe Browsing defaults to enabled; pin it where the OS API exists.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            webView.settings.safeBrowsingEnabled = true
        }
        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(
                view: WebView,
                request: WebResourceRequest,
            ): WebResourceResponse? {
                val url = request.url?.toString() ?: return super.shouldInterceptRequest(view, request)
                if (url.startsWith("${MediaAuthorization.SCHEME}:", ignoreCase = true) ||
                    url.startsWith("${FrameAuthorization.SCHEME}:", ignoreCase = true)
                ) {
                    return mediaInterceptor(url, request.requestHeaders?.get("Range"))
                        ?: super.shouldInterceptRequest(view, request)
                }
                return assetLoader.shouldInterceptRequest(request.url)
                    ?: super.shouldInterceptRequest(view, request)
            }

            private fun shouldBlockTopLevelNavigation(view: WebView, url: String?): Boolean {
                if (TrustedRuntimeOrigin.allowsTopLevelNavigation(url)) return false
                view.stopLoading()
                return true
            }

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                shouldBlockTopLevelNavigation(view, request.url?.toString())

            @Suppress("DEPRECATION")
            override fun shouldOverrideUrlLoading(view: WebView, url: String): Boolean =
                shouldBlockTopLevelNavigation(view, url)

            override fun onPageFinished(view: WebView, url: String) {
                super.onPageFinished(view, url)
                // Prove the installed WebView runs the Widget runtime
                // contract before its capabilities are ever advertised.
                if (!probeDispatched && url == TrustedRuntimeOrigin.entryUrl) {
                    probeDispatched = true
                    RuntimeComponentProbe.run(view, onComponentProbeDone)
                }
            }

            private var probeDispatched = false

            override fun onRenderProcessGone(view: WebView, detail: android.webkit.RenderProcessGoneDetail): Boolean {
                val dead = crashPolicy.onRendererGone()
                // Capabilities must be re-proven on the recreated WebView,
                // never inherited from the dead renderer.
                RuntimeComponentProbe.record(false)
                onComponentProbeDone(false)
                onRendererGone(dead)
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
        WebViewCompat.addWebMessageListener(
            webView,
            RuntimeBridgeProtocol.BRIDGE_NAME,
            setOf(TrustedRuntimeOrigin.origin),
            { _, message, sourceOrigin, _, replyProxy ->
                if (sourceOrigin.toString() != TrustedRuntimeOrigin.origin) return@addWebMessageListener
                val payload = message?.data ?: return@addWebMessageListener
                onRuntimeMessage(payload, generation, replyProxy)
            },
        )
        WebViewCompat.addDocumentStartJavaScript(
            webView,
            documentStartScript,
            setOf(TrustedRuntimeOrigin.origin),
        )
        webView.loadUrl(TrustedRuntimeOrigin.entryUrl)
        return TrustedRuntimeEndpoint.Ready(webView, generation)
    }

    /** Nudges the page to pull new host state. Numeric payload only; all
     * presentation data travels the typed message channel. */
    fun nudge(webView: WebView, stateGeneration: Long) {
        webView.post {
            runCatching {
                webView.evaluateJavascript(
                    RuntimeBridgeProtocol.nudgeJs(stateGeneration),
                    null,
                )
            }
        }
    }

    fun destroy(webView: WebView) {
        runCatching {
            webView.stopLoading()
            webView.loadUrl("about:blank")
            webView.removeAllViews()
            webView.destroy()
        }
    }
}
