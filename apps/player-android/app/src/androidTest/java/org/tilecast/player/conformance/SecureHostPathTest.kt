package org.tilecast.player.conformance

import android.view.ViewGroup
import android.webkit.WebView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import org.junit.Test
import org.junit.runner.RunWith
import org.tilecast.player.content.PreparedContent
import org.tilecast.player.network.ManifestAsset
import org.tilecast.player.network.ManifestItem
import org.tilecast.player.network.ManifestWidget
import org.tilecast.player.network.PlayerManifest
import org.tilecast.player.runtime.MediaAuthorization
import org.tilecast.player.runtime.RuntimeBridgeProtocol
import org.tilecast.player.runtime.RuntimeComponentProbe
import org.tilecast.player.runtime.RuntimeCrashPolicy
import org.tilecast.player.runtime.RuntimeHostSession
import org.tilecast.player.runtime.RuntimePresentationBuilder
import org.tilecast.player.runtime.RuntimeScreenState
import org.tilecast.player.runtime.TcMediaBridge
import org.tilecast.player.runtime.TrustedRuntimeEndpoint
import org.tilecast.player.runtime.TrustedRuntimeOrigin
import org.tilecast.player.runtime.TrustedRuntimeWebView

/**
 * Production host-boundary coverage for the shared Player Runtime.
 *
 * The fixture gate ([PlayerRuntimeConformanceTest]) proves the packaged
 * runtime visually, but through a test-only `@JavascriptInterface` bridge
 * that bypasses the production host. This suite drives the production
 * classes instead: [TrustedRuntimeWebView] (bridge availability,
 * trusted-origin confinement, component probing), [TcMediaBridge] through
 * the same interceptor shape the stage uses (cached media, Range), and
 * [RuntimeHostSession] with [RuntimePresentationBuilder] (activation,
 * evidence and Widget/Website status lifecycle).
 */
@RunWith(AndroidJUnit4::class)
class SecureHostPathTest {
    private val bytes = "tilecast-secure-host-media".toByteArray()

    private fun launchOnActivity(block: (ConformanceActivity) -> Unit) {
        ActivityScenario.launch(ConformanceActivity::class.java).use { scenario ->
            scenario.onActivity(block)
        }
    }

    @Test
    fun trustedHostServesCachedMediaWithRangeToTrustedPage() {
        check(TrustedRuntimeOrigin.isTrustedDocument(TrustedRuntimeOrigin.entryUrl)) {
            "production entry must stay inside the trusted runtime tree"
        }
        val done = CountDownLatch(1)
        val failure = AtomicReference<String?>()
        val full = AtomicReference<String?>()
        val partial = AtomicReference<String?>()
        launchOnActivity { activity ->
            try {
                val file = File(activity.cacheDir, "secure-host-v1.bin")
                file.writeBytes(bytes)
                val authorized = setOf(MediaAuthorization.AuthorizedMedia("a1", "v1"))
                val localFiles = mapOf("v1" to file.absolutePath)
                val mime = mapOf("v1" to "application/octet-stream")
                // Same interceptor shape as the production stage: verified
                // cache first, authenticated server fallback after.
                val owner = TrustedRuntimeWebView(
                    activity,
                    RuntimeCrashPolicy(),
                    mediaInterceptor = { url, range ->
                        TcMediaBridge.resolve(url, authorized, localFiles, mime, range)
                            ?.let(TcMediaBridge::toResponse)
                    },
                )
                when (val endpoint = owner.create()) {
                    is TrustedRuntimeEndpoint.Unsupported -> {
                        failure.set("secure bridge unsupported: ${endpoint.reason}")
                        done.countDown()
                        return@launchOnActivity
                    }
                    is TrustedRuntimeEndpoint.Ready -> {
                        val webView = endpoint.webView
                        webView.layoutParams = ViewGroup.LayoutParams(320, 180)
                        activity.container.addView(webView)
                        webView.loadUrl(TrustedRuntimeOrigin.entryUrl)
                        webView.postDelayed({
                            fetchText(
                                webView,
                                "fetch('tcmedia://variant/a1/v1').then(function(r){return r.text().then(function(t){return r.status+' '+t;});}).catch(function(e){return 'ERR '+e;})",
                            ) { full.set(it); fetchText(webView, rangeScript()) { partial.set(it); done.countDown() } }
                        }, 3_000)
                    }
                }
            } catch (error: Throwable) {
                failure.set(error.toString())
                done.countDown()
            }
        }
        check(done.await(60, TimeUnit.SECONDS)) { "timed out: ${failure.get()}" }
        failure.get()?.let { throw AssertionError(it) }
        val expectedFull = "200 ${String(bytes)}"
        check(full.get()?.contains(expectedFull) == true) { "full body mismatch: ${full.get()}" }
        val expectedPartial = "206 ${String(bytes).substring(4)}"
        check(partial.get()?.contains(expectedPartial) == true) { "range body mismatch: ${partial.get()}" }
    }

    private fun rangeScript(): String =
        "fetch('tcmedia://variant/a1/v1',{headers:{Range:'bytes=4-'}}).then(function(r){return r.text().then(function(t){return r.status+' '+t;});}).catch(function(e){return 'ERR '+e;})"

    private fun fetchText(webView: WebView, script: String, next: (String?) -> Unit) {
        runCatching {
            webView.evaluateJavascript(script, next)
        }.onFailure { next(null) }
    }

    @Test
    fun componentProbeRunsInProductionDocument() {
        val done = CountDownLatch(1)
        val failure = AtomicReference<String?>()
        val outcome = AtomicReference<Boolean?>()
        launchOnActivity { activity ->
            try {
                val owner = TrustedRuntimeWebView(activity, RuntimeCrashPolicy())
                when (val endpoint = owner.create()) {
                    is TrustedRuntimeEndpoint.Unsupported -> {
                        failure.set("secure bridge unsupported: ${endpoint.reason}")
                        done.countDown()
                        return@launchOnActivity
                    }
                    is TrustedRuntimeEndpoint.Ready -> {
                        val webView = endpoint.webView
                        webView.layoutParams = ViewGroup.LayoutParams(320, 180)
                        activity.container.addView(webView)
                        webView.loadUrl(TrustedRuntimeOrigin.entryUrl)
                        webView.postDelayed({
                            RuntimeComponentProbe.run(webView) { passed ->
                                outcome.set(passed)
                                done.countDown()
                            }
                        }, 3_000)
                    }
                }
            } catch (error: Throwable) {
                failure.set(error.toString())
                done.countDown()
            }
        }
        check(done.await(60, TimeUnit.SECONDS)) { "probe timed out: ${failure.get()}" }
        failure.get()?.let { throw AssertionError(it) }
        // Either verdict is device truth; the plumbing must record it.
        check(outcome.get() != null) { "probe produced no verdict" }
        check(RuntimeComponentProbe.passed == outcome.get()) { "probe verdict was not recorded" }
    }

    @Test
    fun secureHostActivationEvidenceAndStatusLifecycle() {
        val asset = ManifestAsset("a1", "v1", "image/png", "sha", bytes.size.toLong(), downloadPath = "/media/a1/v1")
        val manifest = PlayerManifest(
            schemaVersion = 16,
            manifestVersion = 1,
            screenId = "screen-1",
            generatedAt = "2026-01-01T00:00:00Z",
            mode = "presentation",
            assets = listOf(asset),
            widgets = listOf(ManifestWidget("widget-1", "Clock", "clock")),
        )
        val items = listOf(
            ManifestItem("w1", "widget-1", null, "widget", 5_000, "contain", "none", false, 0f, deliveryPolicy = "stream"),
            ManifestItem("i1", "a1", "v1", "image", 10_000, "contain", "none", false, 0f, deliveryPolicy = "cache"),
        )
        val boundaries = mutableListOf<Pair<String, String>>()
        val widgetStatuses = mutableListOf<org.tilecast.player.content.WidgetPlaybackStatus>()
        val websiteStatuses = mutableListOf<org.tilecast.player.content.WebsitePlaybackStatus>()
        val session = RuntimeHostSession(
            "test", "test", 1, items, "act1",
            onBoundary = { id, assetId -> boundaries.add(id to assetId) },
            onError = {},
            onProgress = {},
            onWidgetStatus = { widgetStatuses.add(it) },
            onWebsiteStatus = { websiteStatuses.add(it) },
            widgetProviders = mapOf("widget-1" to "clock"),
            websiteAssets = emptySet(),
        )
        // Activation travels through the production builder, exactly as
        // the stage sends it.
        val message = RuntimePresentationBuilder.hostMessage(
            RuntimeScreenState.Playing(
                content = PreparedContent(manifest, mapOf("v1" to "/cache/v1")),
                items = items,
                fullscreenLayout = null,
                playbackDefaults = null,
                websitePolicy = null,
                activationId = "act1",
                generation = 1,
                takeover = false,
                nowMillis = 0,
                clockOffsetMillis = 0,
            ),
        )
        val offered = session.offer(RuntimeBridgeProtocol.parseHostMessage(message.toString()).getOrThrow())
        check(offered.stateGeneration == 1L) { "activation did not advance: $offered" }

        session.handlePageMessage(
            """{"type":"evidence","activationId":"act1","itemId":"w1","kind":"item-started"}""", 1, null,
        )
        check(boundaries == listOf("w1" to "widget-1")) { "boundary mismatch: $boundaries" }
        session.handlePageMessage(
            """{"type":"evidence","activationId":"act1","itemId":"w1","kind":"widget-shown"}""", 1, null,
        )
        check(widgetStatuses.lastOrNull()?.widgetId == "widget-1") { "widget status missing: $widgetStatuses" }
        // A later image item displaces the Widget through the secure host:
        // the stale widgetId must clear so the watchdog resumes.
        session.handlePageMessage(
            """{"type":"evidence","activationId":"act1","itemId":"i1","kind":"item-started"}""", 1, null,
        )
        check(widgetStatuses.lastOrNull()?.widgetId == null) { "stale widget status: $widgetStatuses" }

        // Activation replacement rebinds and drops the old activation:
        // stale evidence must not publish again.
        session.updatePresentation(items, "act2", mapOf("widget-1" to "clock"), emptySet())
        val shownCount = widgetStatuses.size
        session.handlePageMessage(
            """{"type":"evidence","activationId":"act1","itemId":"w1","kind":"widget-shown"}""", 1, null,
        )
        check(widgetStatuses.size == shownCount) { "replaced activation still accepted evidence" }
        check(widgetStatuses.lastOrNull()?.widgetId == null) { "replacement kept status: $widgetStatuses" }
        check(websiteStatuses.lastOrNull()?.assetId == null) { "replacement kept website status" }
    }
}
