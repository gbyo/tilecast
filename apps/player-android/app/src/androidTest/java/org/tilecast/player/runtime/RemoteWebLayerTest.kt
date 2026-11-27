package org.tilecast.player.runtime

import android.net.Uri
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.core.view.children
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class RemoteWebLayerTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun websiteWithPercentageHeightFillsItsZone() {
        val html = """
            <!doctype html>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>html, body, main { height: 100%; margin: 0; }</style>
            <main>Website fixture</main>
        """.trimIndent()
        val viewport = RemoteWebHostManager.ViewportPx(x = 12, y = 18, width = 240, height = 160)
        val surface = RemoteWebHostManager.Surface(
            surfaceId = "website",
            page = RemoteWebHostManager.PageContent(
                url = "data:text/html;charset=utf-8,${Uri.encode(html)}",
                allowedHosts = emptyList(),
                javascriptEnabled = true,
                domStorageEnabled = false,
                cookiePolicy = "first_party",
                userAgent = "",
                zoomPercent = 100,
                scrollX = 0,
                scrollY = 0,
                backgroundColor = "",
            ),
            youTube = null,
            viewportPx = viewport,
            muted = true,
            visible = true,
            reloadCount = 0,
            generation = 1,
        )
        val loaded = CountDownLatch(1)
        compose.setContent {
            RemoteWebLayer(listOf(surface)) { _, _, kind, _ ->
                if (kind == "loaded") loaded.countDown()
            }
        }

        assertTrue("Website fixture did not load", loaded.await(15, TimeUnit.SECONDS))
        val result = LinkedBlockingQueue<String>(1)
        val activity = compose.activity
        compose.runOnIdle {
            val webView = checkNotNull(activity.window.decorView.findWebView())
            assertEquals(ViewGroup.LayoutParams.MATCH_PARENT, webView.layoutParams.width)
            assertEquals(ViewGroup.LayoutParams.MATCH_PARENT, webView.layoutParams.height)
            assertEquals(viewport.width, webView.width)
            assertEquals(viewport.height, webView.height)
            webView.evaluateJavascript(
                """document.documentElement.clientHeight > 0 &&
                    document.querySelector('main').clientHeight === document.documentElement.clientHeight
                """.trimIndent(),
            ) { value -> result.offer(value) }
        }
        assertEquals("The page fills the Website viewport", "true", result.poll(15, TimeUnit.SECONDS))
    }

    private fun View.findWebView(): WebView? = when (this) {
        is WebView -> this
        is ViewGroup -> children.firstNotNullOfOrNull { it.findWebView() }
        else -> null
    }
}
