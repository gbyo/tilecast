package org.tilecast.player.core

import android.util.Base64
import android.view.ViewGroup
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import java.io.InputStream
import java.io.OutputStream
import java.net.ServerSocket
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.time.Instant
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlin.coroutines.resume
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.tilecast.player.security.KeystoreCredentialStore

/**
 * Qualifies external-Widget frames on-device: the stub serves a schema-19
 * manifest whose scoreboard Widget gates its ready signal on compiled
 * config, a prepared document, granted media bytes, and a sane clock,
 * plus a hostile Widget that probes isolation and phones a canary. The
 * frames served are the conformance fixture documents, built from
 * the checked-in generated Server template (byte-identical to what
 * the SDK builder produces):
 *
 *   python3 apps/edge/renderer-wpe/tests/build_frame_doc.py \
 *     < packages/player-contracts/fixtures/widget-package/bundle.js \
 *     > app/src/androidTest/assets/widget-fixture-frame.html
 *
 * (and likewise for hostile.js). The test asserts the verified fetch,
 * the ready-gated evidence for both Widgets, DOM proof the trusted page
 * rendered, and zero canary hits.
 */
class WidgetFrameDeviceTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext

    private class StubServer(
        val frame: ByteArray,
        val hostile: ByteArray,
    ) {
        val installationId = UUID.randomUUID().toString()
        val sessionId = UUID.randomUUID().toString()
        val screenId = UUID.randomUUID().toString()
        val pollSecret = "s".repeat(43)
        val enrollmentToken = "e".repeat(43)
        val credential = "tc_device_" + "c".repeat(26) + "." + "d".repeat(43)
        val scoreAsset = UUID.randomUUID().toString()
        val hostileAsset = UUID.randomUUID().toString()
        val heroAsset = UUID.randomUUID().toString()
        val heroVariant = UUID.randomUUID().toString()
        val documentId = UUID.randomUUID().toString()
        val scoreItem = UUID.randomUUID().toString()
        val hostileItem = UUID.randomUUID().toString()
        val playlistId = UUID.randomUUID().toString()
        val frameHits = AtomicInteger(0)
        val hostileHits = AtomicInteger(0)
        val assetHits = AtomicInteger(0)
        val exfilHits = AtomicInteger(0)
        private val pairingPolls = AtomicInteger(0)
        val payload = Base64.decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
            Base64.DEFAULT,
        )
        val digest = sha256Hex(payload)
        val frameDigest = sha256Hex(frame)
        val hostileDigest = sha256Hex(hostile)
        val packageDigest = sha256Hex("acme-athletics-package".toByteArray(StandardCharsets.UTF_8))
        val evilDigest = sha256Hex("acme-evil-package".toByteArray(StandardCharsets.UTF_8))
        private val socket = ServerSocket(0)
        val port: Int = socket.localPort
        val url: String get() = "http://127.0.0.1:$port"
        private val latch = CountDownLatch(1)

        private fun component(
            asset: String,
            label: String,
            type: String,
            version: Int,
            config: String,
            sources: String,
            media: String,
            packageId: String,
            packageDigest: String,
            frameDigest: String,
            frameSize: Int,
            framePath: String,
        ) = "\"assetId\":\"$asset\",\"name\":\"$label\",\"provider\":\"$type\"," +
            "\"configVersion\":1,\"configuration\":{}," +
            "\"presentation\":{\"schemaVersion\":3,\"kind\":\"component\"," +
            "\"requiredCapabilities\":{\"widget.external-runtime\":2}," +
            "\"component\":{\"type\":\"$type\",\"version\":$version,\"config\":$config," +
            "\"dataSources\":$sources,\"media\":$media,\"empty\":\"render\"," +
            "\"package\":{\"packageId\":\"$packageId\",\"digest\":\"sha256:$packageDigest\"," +
            "\"frame\":{\"sha256\":\"$frameDigest\",\"fileSize\":$frameSize,\"downloadPath\":\"$framePath\"}}}}"

        private fun manifestJson() = "{" +
            "\"schemaVersion\":19,\"manifestVersion\":3,\"screenId\":\"$screenId\",\"mode\":\"presentation\"," +
            "\"assets\":[{\"assetId\":\"$heroAsset\",\"variantId\":\"$heroVariant\",\"sha256\":\"$digest\"," +
            "\"fileSize\":${payload.size},\"mimeType\":\"image/png\"," +
            "\"downloadPath\":\"/api/v1/player/assets/$heroAsset/variants/$heroVariant\"}]," +
            "\"playlist\":{\"id\":\"$playlistId\",\"items\":[" +
            "{\"id\":\"$scoreItem\",\"assetId\":\"$scoreAsset\",\"assetType\":\"widget\"," +
            "\"durationMs\":15000,\"deliveryPolicy\":\"download\"}," +
            "{\"id\":\"$hostileItem\",\"assetId\":\"$hostileAsset\",\"assetType\":\"widget\"," +
            "\"durationMs\":15000,\"deliveryPolicy\":\"download\"}]}," +
            "\"playlists\":[],\"schedules\":[],\"websites\":[]," +
            "\"widgets\":[{" + component(
                scoreAsset, "Lobby", "acme.athletics.scoreboard", 2,
                "{\"label\":\"Lobby\",\"mediaAssetId\":\"$heroAsset\"," +
                    "\"mediaVariantId\":\"$heroVariant\",\"documentId\":\"$documentId\"}",
                "[\"$documentId\"]",
                "[{\"assetId\":\"$heroAsset\",\"variantId\":\"$heroVariant\"}]",
                "acme.athletics", packageDigest, frameDigest, frame.size,
                "/api/v1/player/packages/acme.athletics/widgets/scoreboard/frame",
            ) + "},{" + component(
                hostileAsset, "Probe", "acme.evil.probe", 1,
                "{\"exfil\":\"$url/api/v1/player/probe-exfil\"}",
                "[]", "[]",
                "acme.evil", evilDigest, hostileDigest, hostile.size,
                "/api/v1/player/packages/acme.evil/widgets/probe/frame",
            ) + "}]," +
            "\"dataSources\":[{\"id\":\"$documentId\",\"name\":\"Schedule\",\"provider\":\"test\"," +
            "\"configVersion\":1,\"configuration\":{}," +
            "\"dataDocument\":{\"schemaVersion\":1,\"datasets\":[{\"label\":\"Week 1\"}]}}]," +
            "\"plugins\":[],\"layouts\":[]}"

        fun start() {
            thread(name = "stub-widget-server", isDaemon = true) {
                latch.countDown()
                while (!socket.isClosed) {
                    try {
                        val client = socket.accept()
                        thread(name = "stub-widget-conn", isDaemon = true) {
                            runCatching { serve(client.getInputStream(), client.getOutputStream()) }
                            runCatching { client.close() }
                        }
                    } catch (_: Exception) {
                        return@thread
                    }
                }
            }
            latch.await(5, TimeUnit.SECONDS)
        }

        fun stop() {
            runCatching { socket.close() }
        }

        private fun readLine(input: InputStream): String? {
            val line = StringBuilder()
            while (true) {
                val byte = input.read()
                if (byte < 0) return if (line.isEmpty()) null else line.toString()
                if (byte == '\n'.code) break
                if (byte != '\r'.code) line.append(byte.toChar())
            }
            return line.toString()
        }

        private fun readHttp(input: InputStream): Triple<String, String, Map<String, String>>? {
            val requestLine = readLine(input) ?: return null
            val parts = requestLine.split(" ")
            if (parts.size < 2) return null
            val headers = mutableMapOf<String, String>()
            while (true) {
                val line = readLine(input) ?: break
                if (line.isEmpty()) break
                headers[line.substringBefore(":").trim().lowercase()] = line.substringAfter(":").trim()
            }
            return Triple(parts[0], parts[1].substringBefore("?"), headers)
        }

        private fun serve(input: InputStream, out: OutputStream) {
            val (method, path, headers) = readHttp(input) ?: return
            val contentLength = headers["content-length"]?.toIntOrNull() ?: 0
            val body = ByteArray(contentLength)
            var read = 0
            while (read < contentLength) {
                val next = input.read(body, read, contentLength - read)
                if (next < 0) break
                read += next
            }
            val (status, payload, extra, contentType) = route(method, path)
            val head = "HTTP/1.1 $status\r\nContent-Type: $contentType\r\n$extra" +
                "Content-Length: ${payload.size}\r\nConnection: close\r\n\r\n"
            out.write(head.toByteArray(StandardCharsets.UTF_8))
            out.write(payload)
            out.flush()
        }

        private fun route(method: String, path: String): Route {
            fun json(status: String, payload: String, headers: String = "") =
                Route(status, payload.toByteArray(StandardCharsets.UTF_8), headers, "application/json")
            if (method == "GET" && path == "/api/v1/system/identity") {
                return json(
                    "200 OK",
                    "\"\"{\"data\":{\"product\":\"tilecast\",\"installationId\":\"$installationId\",\"organizationName\":\"Test Org\",\"apiVersion\":\"1\",\"pairingEnabled\":true}}\"\"",
                )
            }
            if (method == "POST" && path == "/api/v1/player/pairing-sessions") {
                val expires = Instant.now().plusSeconds(600).toString()
                return json(
                    "200 OK",
                    "\"\"{\"data\":{\"id\":\"$sessionId\",\"code\":\"REN333\",\"pollSecret\":\"$pollSecret\",\"expiresAt\":\"$expires\",\"pollingIntervalSeconds\":1,\"approvalUrl\":\"$url/approve\",\"organizationName\":\"Test Org\"}}\"\"",
                )
            }
            if (method == "GET" && path == "/api/v1/player/pairing-sessions/$sessionId") {
                return if (pairingPolls.getAndIncrement() == 0) {
                    json("200 OK", "\"\"{\"data\":{\"status\":\"pending\"}}\"\"")
                } else {
                    json("200 OK", "\"\"{\"data\":{\"status\":\"claimed\",\"enrollmentToken\":\"$enrollmentToken\"}}\"\"")
                }
            }
            if (method == "POST" && path == "/api/v1/player/enroll") {
                return json(
                    "200 OK",
                    "\"\"{\"data\":{\"screenId\":\"$screenId\",\"screenName\":\"Widget Screen\",\"deviceCredential\":\"$credential\"}}\"\"",
                )
            }
            if (method == "GET" && path == "/api/v1/player/config") {
                return json(
                    "200 OK",
                    "\"\"{\"data\":{\"schemaVersion\":1,\"configRevision\":7,\"generatedAt\":\"2026-10-05T00:00:00Z\"}}\"\"",
                    "ETag: \"config-7\"\r\n",
                )
            }
            if (method == "GET" && path == "/api/v1/player/manifest") {
                return json("200 OK", "\"\"{\"data\":${manifestJson()}}\"\"", "ETag: \"manifest-v3\"\r\n")
            }
            if (method == "GET" && path == "/api/v1/player/packages/acme.athletics/widgets/scoreboard/frame") {
                frameHits.incrementAndGet()
                return Route("200 OK", frame, "", "text/html")
            }
            if (method == "GET" && path == "/api/v1/player/packages/acme.evil/widgets/probe/frame") {
                hostileHits.incrementAndGet()
                return Route("200 OK", hostile, "", "text/html")
            }
            if (method == "GET" && path.startsWith("/api/v1/player/assets/")) {
                assetHits.incrementAndGet()
                return Route("200 OK", payload, "", "image/png")
            }
            if (path == "/api/v1/player/probe-exfil") {
                exfilHits.incrementAndGet()
                return json("200 OK", "\"\"{\"data\":{}}\"\"")
            }
            if (method == "POST" && path == "/api/v1/player/heartbeat") {
                return json("200 OK", "\"\"{\"data\":{}}\"\"")
            }
            if (method == "GET" && path == "/api/v1/player/commands") {
                return json("200 OK", "\"\"{\"data\":{\"items\":[]}}\"\"")
            }
            return json("404 Not Found", "\"\"{\"error\":{\"code\":\"not_found\",\"message\":\"no such stub route\"}}\"\"")
        }

        private data class Route(
            val status: String,
            val payload: ByteArray,
            val headers: String,
            val contentType: String,
        )
    }

    private suspend fun awaitReports(
        reports: CopyOnWriteArrayList<JSONObject>,
        timeoutMs: Long = 120_000,
        fromIndex: Int = 0,
        match: (JSONObject) -> Boolean,
    ): JSONObject = try {
            withTimeout(timeoutMs) {
                while (true) {
                    reports.drop(fromIndex).lastOrNull { runCatching { match(it) }.getOrDefault(false) }
                        ?.let { return@withTimeout it }
                    delay(250)
                }
                error("unreachable")
            }
        } catch (_: kotlinx.coroutines.TimeoutCancellationException) {
            val seen = reports.map { it.optString("type") + ":" + it.optString("itemId") }
            throw AssertionError("timed out waiting for report; saw types=$seen")
        }

    /** The live document's text, including every shadow root. */
    private suspend fun pageText(view: android.webkit.WebView?): String? =
        withContext(Dispatchers.Main) {
            suspendCancellableCoroutine { cont ->
                if (view == null) {
                    cont.resume(null)
                } else {
                    view.evaluateJavascript(SHADOW_TEXT_JS) { raw -> cont.resume(raw) }
                }
            }
        }

    companion object {
        private const val SHADOW_TEXT_JS =
            "(function collect(root){var text=(root===document&&document.documentElement)?" +
                "document.documentElement.textContent:(root.textContent||'');" +
                "root.querySelectorAll('*').forEach(function(e){if(e.shadowRoot){text+=collect(e.shadowRoot);}});" +
                "return text;})(document)"

        private fun sha256Hex(bytes: ByteArray): String =
            MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    }

    @Test fun widgetFramesExecuteConfinedAndReport() = runBlocking {
        val assets = InstrumentationRegistry.getInstrumentation().context.assets
        val frame = assets.open("widget-fixture-frame.html").use { it.readBytes() }
        val hostile = assets.open("widget-hostile-frame.html").use { it.readBytes() }
        assertTrue("fixture frame is the SDK document", String(frame).contains("tilecast.widget.bridge/1"))
        CoreTestFixtures.resetCoreFiles(context)
        val stub = StubServer(frame, hostile)
        stub.start()
        val credentials = KeystoreCredentialStore(
            context,
            KeystoreCredentialStore.CORE_PREFS_NAME,
            KeystoreCredentialStore.CORE_KEY_ALIAS,
        )
        credentials.clear()
        val reports = CopyOnWriteArrayList<JSONObject>()
        val host = PlayerCoreHost.get(context)
        val renderer = WebViewCoreRenderer(
            context,
            "test-host",
            "test-engine",
            report = { json ->
                reports += JSONObject(json)
                host.rendererReport(json)
            },
        )
        val scenario = ActivityScenario.launch(RendererHarnessActivity::class.java)
        try {
            host.startDrivers()
            assertTrue(host.state.value is CoreHostState.Ready)
            host.attachRendererAdapter(renderer)
            assertTrue("renderer did not start", renderer.start())
            var content: ViewGroup? = null
            scenario.onActivity { activity ->
                content = activity.findViewById(android.R.id.content)
            }
            renderer.onViewRecreated = { fresh ->
                content?.removeAllViews()
                content?.addView(fresh)
            }
            scenario.onActivity { _ ->
                renderer.view?.let { view -> content?.addView(view) }
            }
            assertTrue(renderer.view?.isAttachedToWindow == true)

            val begin = host.beginPairing(stub.url)
            assertTrue("begin failed: $begin", begin.ok)
            withTimeout(30_000) {
                while (host.pairingState.value !is CorePairingState.Paired) delay(200)
            }
            val first = host.syncManifest()
            assertTrue("sync: $first", first.ok && first.version == 3L)
            // Both frames and the granted media download exactly once.
            assertEquals(1, stub.frameHits.get())
            assertEquals(1, stub.hostileHits.get())
            assertEquals(1, stub.assetHits.get())

            awaitReports(reports) { it.optString("type") == "connected" }
            awaitReports(reports) { it.optString("type") == "accepted" }
            // The scoreboard only signals ready when its config,
            // document, media grant, and clock all check out.
            awaitReports(reports) {
                it.optString("type") == "progress" && it.optString("itemId") == stub.scoreItem
            }
            val text = pageText(renderer.view)
            assertTrue("trusted page rendered", text != null && text.contains("tilecast"))
            assertTrue("credential stays out of the page", text == null || !text.contains(stub.credential))
            // The playlist rotates to the hostile Widget, which
            // completes its lifecycle without ever reaching out.
            awaitReports(reports) {
                it.optString("type") == "progress" && it.optString("itemId") == stub.hostileItem
            }
            assertEquals(0, stub.exfilHits.get())
            Unit
        } finally {
            scenario.close()
            host.stop()
            stub.stop()
            credentials.clear()
        }
    }
}
