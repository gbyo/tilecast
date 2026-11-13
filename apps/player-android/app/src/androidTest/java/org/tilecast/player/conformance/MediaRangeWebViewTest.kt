package org.tilecast.player.conformance

import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import org.junit.Test
import org.junit.runner.RunWith
import org.tilecast.player.runtime.MediaAuthorization
import org.tilecast.player.runtime.TcMediaBridge
import org.tilecast.player.runtime.TrustedRuntimeOrigin

/** Exercises WebView's own range seek, which a direct InputStream test omits. */
@RunWith(AndroidJUnit4::class)
class MediaRangeWebViewTest {
    @Test
    fun readsNonzeroRangesAndReopensTheStart() {
        val done = CountDownLatch(1)
        val result = AtomicReference<String?>()
        val scenario = ActivityScenario.launch(ConformanceActivity::class.java)
        try {
            scenario.onActivity { activity ->
                val file = File(activity.cacheDir, "range-webview.bin")
                file.writeBytes(ByteArray(1024) { it.toByte() })
                val webView = WebView(activity)
                webView.settings.javaScriptEnabled = true
                webView.settings.allowFileAccess = false
                webView.settings.allowContentAccess = false
                webView.webViewClient = object : WebViewClient() {
                    override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                        if (request.url.toString() != "${TrustedRuntimeOrigin.origin}/range-test") return null
                        val range = request.requestHeaders.entries.firstOrNull { it.key.equals("Range", true) }?.value
                        return TcMediaBridge.resolve(
                            "tcmedia://variant/a/v", setOf(MediaAuthorization.AuthorizedMedia("a", "v")),
                            mapOf("v" to file.absolutePath), mapOf("v" to "application/octet-stream"), range,
                        )?.let(TcMediaBridge::toResponse)
                    }

                    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                        result.set(request.url.lastPathSegment)
                        done.countDown()
                        return true
                    }
                }
                activity.container.addView(webView)
                webView.loadDataWithBaseURL(
                    "${TrustedRuntimeOrigin.origin}/range-page",
                    """<script>
                    (async function() {
                      try {
                        for (const [range, start, length] of [
                          ['bytes=900-909', 900, 10], ['bytes=-10', 1014, 10],
                          ['bytes=0-9', 0, 10], ['bytes=0-0', 0, 1]
                        ]) {
                          const response = await fetch('/range-test', {headers: {Range: range}});
                          const bytes = new Uint8Array(await response.arrayBuffer());
                          if (response.status !== 206 || bytes.length !== length ||
                              bytes.some((value, index) => value !== ((start + index) & 255))) {
                            throw new Error('range mismatch');
                          }
                        }
                        location.href = '/range-result/ok';
                      } catch (_) { location.href = '/range-result/failed'; }
                    })();
                    </script>""".trimIndent(),
                    "text/html", "UTF-8", null,
                )
            }
            check(done.await(30, TimeUnit.SECONDS)) { "WebView range request did not finish" }
            check(result.get() == "ok") { "WebView range response failed: ${result.get()}" }
        } finally {
            scenario.close()
        }
    }
}
