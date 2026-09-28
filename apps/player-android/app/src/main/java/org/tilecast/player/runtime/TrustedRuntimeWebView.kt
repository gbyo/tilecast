package org.tilecast.player.runtime

import android.annotation.SuppressLint
import android.content.Context
import android.os.Build
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
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
    private val onRuntimeMessage: (String, Long) -> Unit = { _, _ -> },
) {
    private val appContext = context.applicationContext
    private val assetLoader = WebViewAssetLoader.Builder()
        .addPathHandler(
            TrustedRuntimeOrigin.RUNTIME_PATH_PREFIX.trim { it == '/' },
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
            ): WebResourceResponse? = assetLoader.shouldInterceptRequest(request.url)
                ?: super.shouldInterceptRequest(view, request)

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (TrustedRuntimeOrigin.allowsTopLevelNavigation(request.url?.toString())) return false
                view.stopLoading()
                return true
            }

            override fun onRenderProcessGone(view: WebView, detail: android.webkit.RenderProcessGoneDetail): Boolean {
                crashPolicy.onRendererGone()
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
            { _, message, sourceOrigin, _, _ ->
                if (sourceOrigin.toString() != TrustedRuntimeOrigin.origin) return@addWebMessageListener
                val payload = message?.data ?: return@addWebMessageListener
                onRuntimeMessage(payload, generation)
            },
        )
        WebViewCompat.addDocumentStartJavaScript(
            webView,
            RuntimeBridgeProtocol.bootstrapScript(),
            setOf(TrustedRuntimeOrigin.origin),
        )
        webView.loadUrl(TrustedRuntimeOrigin.entryUrl)
        return TrustedRuntimeEndpoint.Ready(webView, generation)
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
