package org.tilecast.player.conformance

import android.annotation.SuppressLint
import android.graphics.Bitmap
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import java.io.ByteArrayInputStream
import java.io.File
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import org.json.JSONObject
import org.tilecast.player.runtime.TrustedRuntimeOrigin
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Android engine for the shared Player Runtime conformance suite.
 *
 * Driven once per run by apps/player-android/conformance/run-android.sh, which
 * pushes fixture JSON, the built conformance-host.js and the media CAS to the
 * device. Each fixture loads the exact packaged runtime asset
 * (src/main/assets/shared-runtime, verified against runtime-manifest.json at
 * build time) through the same app-owned origin production uses, injects the
 * same fixture host every other engine runs, serves tcmedia bytes from the
 * pushed CAS, and records the same result.json plus per-checkpoint PNGs that
 * compare.mjs consumes.
 *
 * The @JavascriptInterface bridge below is test-only surface (this source
 * set never ships): production keeps no generic native invocation on the
 * trusted document. Remote web fixtures run with the default null remoteWeb
 * capability, exactly as on WPE, so no host-view plumbing is needed here.
 */
@RunWith(AndroidJUnit4::class)
class PlayerRuntimeConformanceTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()

    @Test
    fun runAllFixtures() {
        val args = InstrumentationRegistry.getArguments()
        val root = File(
            args.getString("conformanceRoot")
                ?: error("conformance: -e conformanceRoot <device dir> is required"),
        )
        val only = args.getString("only")?.split(",")?.toSet()
        TimeZone.setDefault(TimeZone.getTimeZone("UTC"))
        Locale.setDefault(Locale.US)

        val hostSource = File(root, "in/conformance-host.js").readText()
        val casRoot = File(root, "cas")
        val outRoot = File(instrumentation.targetContext.filesDir, "conformance/out")
        val fixtures = (File(root, "in").listFiles { file ->
            file.isFile && file.name.endsWith(".fixture.json")
        } ?: emptyArray())
            .map { it.name.removeSuffix(".fixture.json") to it.readText() }
            .filter { (name, _) -> only == null || name in only }
            .sortedBy { (name, _) -> name }
        check(fixtures.isNotEmpty()) { "conformance: no fixtures pushed to $root/in" }
        for ((name, fixtureJson) in fixtures) {
            runFixture(name, fixtureJson, hostSource, casRoot, File(outRoot, name))
        }
    }

    private fun runFixture(
        name: String,
        fixtureJson: String,
        hostSource: String,
        casRoot: File,
        outDir: File,
    ) {
        outDir.mkdirs()
        val viewport = runCatching {
            JSONObject(fixtureJson).getJSONObject("viewport").let {
                it.getInt("width") to it.getInt("height")
            }
        }.getOrDefault(1280 to 720)
        val done = CountDownLatch(1)
        val failure = AtomicReference<String?>(null)
        val scenario = ActivityScenario.launch(ConformanceActivity::class.java)
        scenario.onActivity { activity ->
            startFixtureWebView(
                activity = activity,
                fixtureJson = fixtureJson,
                hostSource = hostSource,
                casRoot = casRoot,
                outDir = outDir,
                viewportWidth = viewport.first,
                viewportHeight = viewport.second,
                onFailure = { failure.set(it); done.countDown() },
                onFinish = { resultJson ->
                    File(outDir, "result.json").writeText(resultJson)
                    done.countDown()
                },
            )
        }
        val finished = done.await(180, TimeUnit.SECONDS)
        scenario.close()
        if (!finished) {
            failure.set("timed out")
        }
        failure.get()?.let { reason ->
            if (!File(outDir, "result.json").exists()) {
                File(outDir, "result.json").writeText(
                    JSONObject()
                        .put("fixture", name)
                        .put("checkpoints", org.json.JSONArray())
                        .put("failure", reason)
                        .toString(),
                )
            }
        }
    }

    @SuppressLint("SetJavaScriptEnabled", "AddJavascriptInterface")
    private fun startFixtureWebView(
        activity: ConformanceActivity,
        fixtureJson: String,
        hostSource: String,
        casRoot: File,
        outDir: File,
        viewportWidth: Int,
        viewportHeight: Int,
        onFailure: (String) -> Unit,
        onFinish: (String) -> Unit,
    ) {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            onFailure("document-start script unsupported by this WebView")
            return
        }
        val webView = WebView(activity)
        with(webView.settings) {
            javaScriptEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            allowFileAccessFromFileURLs = false
            allowUniversalAccessFromFileURLs = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            setGeolocationEnabled(false)
            mediaPlaybackRequiresUserGesture = false
            domStorageEnabled = true
        }
        webView.layoutParams = ViewGroup.LayoutParams(viewportWidth, viewportHeight)
        activity.container.addView(webView)

        val assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler(
                "/assets/",
                WebViewAssetLoader.AssetsPathHandler(activity),
            )
            .build()
        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(
                view: WebView,
                request: WebResourceRequest,
            ): WebResourceResponse? {
                val url = request.url?.toString() ?: return null
                if (url.startsWith("tcmedia://", ignoreCase = true)) {
                    return serveCasObject(casRoot, url, request.requestHeaders?.get("Range"))
                }
                // Hermetic run: only the packaged runtime tree loads.
                if (!url.startsWith("https://appassets.androidplatform.net/assets/shared-runtime/")) {
                    return WebResourceResponse("text/plain", null, 404, "not found", emptyMap(), null)
                }
                return assetLoader.shouldInterceptRequest(request.url)
            }

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean = true

            @Suppress("DEPRECATION")
            override fun shouldOverrideUrlLoading(view: WebView, url: String): Boolean = true

            override fun onRenderProcessGone(view: WebView, detail: android.webkit.RenderProcessGoneDetail): Boolean {
                runCatching {
                    view.stopLoading()
                    view.loadUrl("about:blank")
                    view.removeAllViews()
                    view.destroy()
                }
                return true
            }
        }

        val bridge = ConformanceBridge(
            fixtureJson = fixtureJson,
            onSnapshot = { checkpoint ->
                snapshotCheckpoint(activity, webView, outDir, checkpoint)
            },
            onFinish = onFinish,
        )
        webView.addJavascriptInterface(bridge, "TcConformance")
        // The fixture is inlined (as on WPE), never pasted through a URL.
        val runnerScript =
            "globalThis.__tilecastConformanceRunner=Object.freeze({" +
                "fixture:$fixtureJson," +
                "snapshot:function(n){TcConformance.snapshot(String(n));return Promise.resolve();}," +
                "finish:function(r){TcConformance.finish(JSON.stringify(r));}});\n;" +
                hostSource
        WebViewCompat.addDocumentStartJavaScript(
            webView,
            runnerScript,
            setOf(TrustedRuntimeOrigin.origin),
        )
        webView.loadUrl(TrustedRuntimeOrigin.entryUrl)
    }

    private class ConformanceBridge(
        private val fixtureJson: String,
        private val onSnapshot: (String) -> Unit,
        private val onFinish: (String) -> Unit,
    ) {
        @JavascriptInterface
        fun getFixture(): String = fixtureJson

        @JavascriptInterface
        fun snapshot(name: String): String {
            // Called on the JavaBridge thread; blocking here is safe.
            onSnapshot(name)
            return "ok"
        }

        @JavascriptInterface
        fun finish(resultJson: String) {
            onFinish(resultJson)
        }
    }

    private fun snapshotCheckpoint(
        activity: ConformanceActivity,
        webView: WebView,
        outDir: File,
        checkpoint: String,
    ) {
        require(checkpoint.matches(Regex("[A-Za-z0-9_-]{1,64}"))) { "invalid checkpoint name" }
        val rect = IntArray(2)
        val located = java.util.concurrent.FutureTask { webView.getLocationOnScreen(rect) }
        activity.runOnUiThread(located)
        located.get(10, TimeUnit.SECONDS)
        val visualStateReady = CountDownLatch(1)
        activity.runOnUiThread {
            webView.postVisualStateCallback(
                System.nanoTime(),
                object : WebView.VisualStateCallback() {
                    override fun onComplete(requestId: Long) {
                        visualStateReady.countDown()
                    }
                },
            )
        }
        check(visualStateReady.await(10, TimeUnit.SECONDS)) {
            "timed out waiting for WebView visual state before $checkpoint screenshot"
        }
        val full = instrumentation.uiAutomation.takeScreenshot()
            ?: error("screenshot unavailable")
        val x = rect[0].coerceIn(0, full.width - 1)
        val y = rect[1].coerceIn(0, full.height - 1)
        val w = webView.width.coerceIn(1, full.width - x)
        val h = webView.height.coerceIn(1, full.height - y)
        val cropped = Bitmap.createBitmap(full, x, y, w, h)
        File(outDir, "$checkpoint.png").outputStream().use { out ->
            cropped.compress(Bitmap.CompressFormat.PNG, 100, out)
        }
        cropped.recycle()
        if (cropped !== full) full.recycle()
    }

    /** Serves pushed CAS bytes for tcmedia: URIs, with basic Range support. */
    private fun serveCasObject(casRoot: File, url: String, rangeHeader: String?): WebResourceResponse? {
        val hex = url.substringAfter("tcmedia://", "")
            .removePrefix("sha256/").removePrefix("cap/")
            .substringBefore("?").substringBefore("#")
            .takeIf { it.matches(Regex("[0-9a-f]{64}")) }
            ?: return WebResourceResponse("text/plain", null, 404, "not found", emptyMap(), null)
        val file = File(casRoot, "sha256/${hex.take(2)}/$hex")
        if (!file.isFile) {
            return WebResourceResponse("text/plain", null, 404, "not found", emptyMap(), null)
        }
        val bytes = file.readBytes()
        val mime = if (bytes.size > 8 && bytes[0] == 0x89.toByte() && bytes[1] == 0x50.toByte()) {
            "image/png"
        } else {
            "video/mp4"
        }
        val headers = mutableMapOf("Accept-Ranges" to "bytes")
        val range = rangeHeader?.removePrefix("bytes=")?.split("-")
        if (range?.size == 2) {
            val start = range[0].toLongOrNull() ?: 0L
            val end = range[1].toLongOrNull()?.coerceAtMost(bytes.size - 1L) ?: (bytes.size - 1L)
            if (start in 0 until bytes.size && end >= start) {
                headers["Content-Range"] = "bytes $start-$end/${bytes.size}"
                val slice = bytes.sliceArray(start.toInt()..end.toInt())
                return WebResourceResponse(
                    mime, null, 206, "Partial Content", headers,
                    ByteArrayInputStream(slice),
                )
            }
        }
        return WebResourceResponse(mime, null, 200, "OK", headers, ByteArrayInputStream(bytes))
    }
}
