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
import kotlinx.coroutines.coroutineScope
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
 * Qualifies the Core renderer loop on-device: pairing, manifest sync,
 * and CAS download seed one real PNG; Core activation pushes grants
 * through JNI into the trusted WebView runtime; the page's ready,
 * acceptance, and evidence reports return through the adapter; a
 * restart recreates the renderer and re-presents; reload reboots
 * the page in place; safe mode shows its surface while Core keeps
 * its activation; and capture answers flow back with their bytes.
 */
class RendererDeviceTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext

    private class StubServer {
        val installationId = UUID.randomUUID().toString()
        val sessionId = UUID.randomUUID().toString()
        val screenId = UUID.randomUUID().toString()
        val pollSecret = "s".repeat(43)
        val enrollmentToken = "e".repeat(43)
        val credential = "tc_device_" + "c".repeat(26) + "." + "d".repeat(43)
        val assetId = UUID.randomUUID().toString()
        val variantId = UUID.randomUUID().toString()
        val itemId = UUID.randomUUID().toString()
        val playlistId = UUID.randomUUID().toString()
        val assetHits = AtomicInteger(0)
        private val pairingPolls = AtomicInteger(0)
        val payload = Base64.decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
            Base64.DEFAULT,
        )
        val digest = MessageDigest.getInstance("SHA-256").digest(payload)
            .joinToString("") { "%02x".format(it) }
        private val socket = ServerSocket(0)
        val port: Int = socket.localPort
        val url: String get() = "http://127.0.0.1:$port"
        private val latch = CountDownLatch(1)

        private fun manifestJson() = """
            {"schemaVersion":11,"manifestVersion":8,"screenId":"$screenId","mode":"presentation",
            "assets":[{"assetId":"$assetId","variantId":"$variantId","sha256":"$digest",
            "fileSize":${payload.size},"mimeType":"image/png",
            "downloadPath":"/api/v1/player/assets/$assetId/variants/$variantId"}],
            "playlist":{"id":"$playlistId","items":[{"id":"$itemId","assetId":"$assetId",
            "variantId":"$variantId","assetType":"image","deliveryPolicy":"automatic",
            "durationMs":10000,"fitMode":"cover","transition":"fade",
            "audioEnabled":true,"volume":0.8}]},
            "playlists":[],"schedules":[],"websites":[],"widgets":[],"dataSources":[],
            "plugins":[],"layouts":[]}
        """.trimIndent().replace("\n", "")

        fun start() {
            thread(name = "stub-renderer-server", isDaemon = true) {
                latch.countDown()
                while (!socket.isClosed) {
                    try {
                        val client = socket.accept()
                        thread(name = "stub-renderer-conn", isDaemon = true) {
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
            if (path == "/api/v1/player/socket" && headers["upgrade"]?.lowercase() == "websocket") {
                serveSocket(input, out, headers["sec-websocket-key"] ?: return)
                return
            }
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
                    """{"data":{"product":"tilecast","installationId":"$installationId","organizationName":"Test Org","apiVersion":"1","pairingEnabled":true}}""",
                )
            }
            if (method == "POST" && path == "/api/v1/player/pairing-sessions") {
                val expires = Instant.now().plusSeconds(600).toString()
                return json(
                    "200 OK",
                    """{"data":{"id":"$sessionId","code":"REN333","pollSecret":"$pollSecret","expiresAt":"$expires","pollingIntervalSeconds":1,"approvalUrl":"$url/approve","organizationName":"Test Org"}}""",
                )
            }
            if (method == "GET" && path == "/api/v1/player/pairing-sessions/$sessionId") {
                return if (pairingPolls.getAndIncrement() == 0) {
                    json("200 OK", """{"data":{"status":"pending"}}""")
                } else {
                    json("200 OK", """{"data":{"status":"claimed","enrollmentToken":"$enrollmentToken"}}""")
                }
            }
            if (method == "POST" && path == "/api/v1/player/enroll") {
                return json(
                    "200 OK",
                    """{"data":{"screenId":"$screenId","screenName":"Renderer Screen","deviceCredential":"$credential"}}""",
                )
            }
            if (method == "GET" && path == "/api/v1/player/config") {
                return json(
                    "200 OK",
                    """{"data":{"schemaVersion":1,"configRevision":7,"generatedAt":"2026-10-05T00:00:00Z"}}""",
                    "ETag: \"config-7\"\r\n",
                )
            }
            if (method == "GET" && path == "/api/v1/player/manifest") {
                return json("200 OK", """{"data":${manifestJson()}}""", "ETag: \"manifest-v8\"\r\n")
            }
            if (method == "GET" && path.startsWith("/api/v1/player/assets/")) {
                assetHits.incrementAndGet()
                return Route("200 OK", payload, "", "image/png")
            }
            if (method == "POST" && path == "/api/v1/player/heartbeat") {
                return json("200 OK", """{"data":{}}""")
            }
            if (method == "GET" && path == "/api/v1/player/commands") {
                return json("200 OK", """{"data":{"items":[]}}""")
            }
            return json("404 Not Found", """{"error":{"code":"not_found","message":"no such stub route"}}""")
        }

        private data class Route(
            val status: String,
            val payload: ByteArray,
            val headers: String,
            val contentType: String,
        )

        private fun serveSocket(input: InputStream, out: OutputStream, key: String) {
            val accept = String(
                java.util.Base64.getEncoder().encode(
                    MessageDigest.getInstance("SHA-1")
                        .digest((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").toByteArray(StandardCharsets.UTF_8)),
                ),
                StandardCharsets.UTF_8,
            )
            out.write(
                ("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
                    "Sec-WebSocket-Accept: $accept\r\n\r\n").toByteArray(StandardCharsets.UTF_8),
            )
            out.flush()
            val reader = thread(name = "stub-renderer-socket-read", isDaemon = true) {
                try {
                    while (readFrame(input) != null) {
                        // Consumed; the link stays up for the whole test.
                    }
                } catch (_: Exception) {
                }
            }
            try {
                repeat(30) {
                    val ping = """{"type":"server.ping","timestamp":"${Instant.now()}"}"""
                    writeFrame(out, 0x81, ping.toByteArray(StandardCharsets.UTF_8))
                    out.flush()
                    Thread.sleep(20_000)
                }
            } catch (_: Exception) {
            } finally {
                runCatching { reader.interrupt() }
            }
        }

        private fun readFrame(input: InputStream): String? {
            val first = input.read()
            if (first < 0) return null
            val second = input.read()
            if (second < 0) return null
            var length = second and 0x7F
            if (length == 126) {
                length = input.read() shl 8 or input.read()
            } else if (length == 127) {
                input.skip(4)
                length = (input.read() shl 24) or (input.read() shl 16) or (input.read() shl 8) or input.read()
            }
            val mask = ByteArray(4)
            if (second and 0x80 != 0) {
                var got = 0
                while (got < 4) {
                    val next = input.read(mask, got, 4 - got)
                    if (next < 0) return null
                    got += next
                }
            }
            val payload = ByteArray(length)
            var got = 0
            while (got < length) {
                val next = input.read(payload, got, length - got)
                if (next < 0) return null
                got += next
            }
            if (second and 0x80 != 0) {
                for (i in payload.indices) payload[i] = (payload[i].toInt() xor mask[i % 4].toInt()).toByte()
            }
            if (first and 0x0F == 0x8) return null
            return String(payload, StandardCharsets.UTF_8)
        }

        private fun writeFrame(out: OutputStream, opcode: Int, payload: ByteArray) {
            out.write(opcode)
            if (payload.size < 126) {
                out.write(payload.size)
            } else {
                out.write(126)
                out.write(payload.size shr 8)
                out.write(payload.size and 0xFF)
            }
            out.write(payload)
        }
    }

    private suspend fun awaitPaired(host: PlayerCoreHost, timeoutMs: Long = 30_000) = coroutineScope {
        try {
            withTimeout(timeoutMs) {
                while (true) {
                    if (host.pairingState.value is CorePairingState.Paired) return@withTimeout
                    delay(200)
                }
                error("unreachable")
            }
        } catch (_: kotlinx.coroutines.TimeoutCancellationException) {
            throw AssertionError("timed out waiting for Paired; last=${host.pairingState.value}")
        }
    }

    private suspend fun awaitReports(
        reports: CopyOnWriteArrayList<JSONObject>,
        timeoutMs: Long = 90_000,
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
            val seen = reports.map { it.optString("type") }
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
        // Light-DOM text plus every shadow root. Script source comes
        // along, so only the unique reason discriminates the surface.
        private const val SHADOW_TEXT_JS =
            "(function collect(root){var text=(root===document&&document.documentElement)?" +
                "document.documentElement.textContent:(root.textContent||'');" +
                "root.querySelectorAll('*').forEach(function(e){if(e.shadowRoot){text+=collect(e.shadowRoot);}});" +
                "return text;})(document)"
    }

    private suspend fun awaitRendererStatus(
        host: PlayerCoreHost,
        timeoutMs: Long = 90_000,
        match: (CoreRendererStatus) -> Boolean,
    ): CoreRendererStatus = try {
            withTimeout(timeoutMs) {
                while (true) {
                    host.refreshStatus()
                    val renderer = (host.state.value as? CoreHostState.Ready)?.status?.renderer
                    if (renderer != null && runCatching { match(renderer) }.getOrDefault(false)) {
                        return@withTimeout renderer
                    }
                    delay(500)
                }
                error("unreachable")
            }
        } catch (_: kotlinx.coroutines.TimeoutCancellationException) {
            host.refreshStatus()
            val last = (host.state.value as? CoreHostState.Ready)?.status?.renderer
            throw AssertionError("timed out waiting for renderer status; last=$last")
        }

    @Test fun parseLevelRejectionsNeedNoRenderer() = runBlocking {
        val renderer = WebViewCoreRenderer(
            context,
            "test-host",
            "test-engine",
            report = { 0 },
        )
        assertEquals(CoreRendererRequestCode.INVALID_ACTIVATION, renderer.handle(""))
        assertEquals(CoreRendererRequestCode.INVALID_ACTIVATION, renderer.handle("   "))
        assertEquals(CoreRendererRequestCode.INVALID_ACTIVATION, renderer.handle("{not json"))
        assertEquals(CoreRendererRequestCode.INVALID_ACTIVATION, renderer.handle("{}"))
        assertEquals(CoreRendererRequestCode.INVALID_ACTIVATION, renderer.handle("""{"op":"frobnicate"}"""))
        assertEquals(CoreRendererRequestCode.INVALID_ACTIVATION, renderer.handle("x".repeat(9 * 1024 * 1024)))
        // Well-formed operations with no live session refuse honestly.
        assertEquals(CoreRendererRequestCode.NOT_READY, renderer.handle("""{"op":"activate"}"""))
        assertEquals(CoreRendererRequestCode.NOT_READY, renderer.handle("""{"op":"clear"}"""))
        assertEquals(CoreRendererRequestCode.NOT_READY, renderer.handle("""{"op":"command"}"""))
        assertEquals(CoreRendererRequestCode.NOT_READY, renderer.handle("""{"op":"capture"}"""))
        assertEquals(CoreRendererRequestCode.NOT_READY, renderer.handle("""{"op":"restart"}"""))
        assertEquals(CoreRendererRequestCode.NOT_READY, renderer.handle("""{"op":"show_unavailable"}"""))
        assertEquals(CoreRendererRequestCode.NOT_READY, renderer.handle("""{"op":"show_safe_mode"}"""))
        renderer.close()
    }

    @Test fun explicitActivateCallAdmitsOneVerifiedPresentation() = runBlocking {
        CoreTestFixtures.resetCoreFiles(context)
        val stub = StubServer()
        stub.start()
        val credentials = KeystoreCredentialStore(
            context,
            KeystoreCredentialStore.CORE_PREFS_NAME,
            KeystoreCredentialStore.CORE_KEY_ALIAS,
        )
        credentials.clear()
        val host = PlayerCoreHost.get(context)
        try {
            host.startCoreOnly()
            assertTrue(host.state.value is CoreHostState.Ready)
            // A scripted link is enough: this test asserts the call's
            // synchronous answer, not any steady state. The selection
            // driver may replace the activation right after; the
            // returned outcome already proves the JNI path admitted it.
            assertEquals(
                CoreReportCode.APPLIED,
                host.rendererReport("""{"type":"connected","generation":1}"""),
            )
            assertEquals(
                CoreReportCode.APPLIED,
                host.rendererReport(
                    """{"type":"ready","generation":1,"report":{"features":["status-surfaces-v1","image"],""" +
                        """"support":{"presentationSchemas":[1,2]}}}""",
                ),
            )
            val begin = host.beginPairing(stub.url)
            assertTrue("begin failed: $begin", begin.ok)
            awaitPaired(host)
            val first = host.syncManifest()
            assertTrue("first sync: $first", first.ok && first.version == 8L)
            val activationJson = """
                {"envelope":{"presentation":{"state":"playing",
                "items":[{"id":"${stub.itemId}","kind":"image",
                "src":"tcmedia:${stub.assetId}/${stub.variantId}"}]}},
                "content":[{"assetId":"${stub.assetId}","variantId":"${stub.variantId}",
                "digest":"${stub.digest}","sizeBytes":${stub.payload.size},"mimeType":"image/png"}],
                "source":"server_manifest","clockOffsetMs":0}
            """.trimIndent().replace("\n", "")
            val activated = host.activatePresentation(activationJson)
            assertTrue("activate: $activated", activated.ok && activated.activationId != null)
            assertTrue("activate queued: $activated", activated.queued)
            Unit
        } finally {
            host.stop()
            stub.stop()
            credentials.clear()
        }
    }

    @Test fun rendererLoopActivatesRecoversAndCaptures() = runBlocking {
        CoreTestFixtures.resetCoreFiles(context)
        val stub = StubServer()
        stub.start()
        val credentials = KeystoreCredentialStore(
            context,
            KeystoreCredentialStore.CORE_PREFS_NAME,
            KeystoreCredentialStore.CORE_KEY_ALIAS,
        )
        credentials.clear()
        val reports = CopyOnWriteArrayList<JSONObject>()
        val reportCodes = CopyOnWriteArrayList<Int>()
        val host = PlayerCoreHost.get(context)
        val jpegBytes = "renderer-device-test-frame".toByteArray(StandardCharsets.UTF_8)
        val renderer = WebViewCoreRenderer(
            context,
            "test-host",
            "test-engine",
            report = { json ->
                reports += JSONObject(json)
                host.rendererReport(json).also { reportCodes += it }
            },
            captureFrame = { _, _ -> WebViewCoreRenderer.CapturedImage(jpegBytes, 2, 2) },
        )
        val scenario = ActivityScenario.launch(RendererHarnessActivity::class.java)
        try {
            host.startCoreOnly()
            assertTrue(host.state.value is CoreHostState.Ready)
            host.setRendererAdapterForTesting(renderer)
            assertTrue("renderer did not start", renderer.start())
            // Production attaches the trusted view to the player UI;
            // view-posted work only runs on an attached view.
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
            awaitPaired(host)

            // The link may auto-sync first; either way version 8 ends
            // prepared with exactly one download.
            val first = host.syncManifest()
            assertTrue(
                "first sync: $first",
                first.ok && first.version == 8L &&
                    (first.outcome == "prepared" || first.outcome == "current"),
            )
            assertEquals(1, stub.assetHits.get())
            val second = host.syncManifest()
            assertTrue("second sync: $second", second.ok && second.outcome == "current" && second.version == 8L)
            assertEquals(1, stub.assetHits.get())

            // The live page announces itself and becomes ready.
            val connected = awaitReports(reports) { it.optString("type") == "connected" }
            val firstGeneration = connected.getLong("generation")
            assertTrue(firstGeneration > 0)
            // The first ready precedes the component probe; the probe
            // passing re-reports readiness with schema 2 unlocked.
            awaitReports(reports) {
                if (it.optString("type") != "ready") return@awaitReports false
                val schemas = it.getJSONObject("report").getJSONObject("support")
                    .getJSONArray("presentationSchemas")
                (0 until schemas.length()).map { index -> schemas.getInt(index) }.contains(2)
            }
            awaitRendererStatus(host) { it.connected && it.ready }

            // The selection driver owns activation: nobody calls
            // activate here. The pushed presentation carries CAS grants
            // through JNI; the page accepts and reports evidence for
            // the rendered item.
            val accepted = awaitReports(reports) { it.optString("type") == "accepted" }
            val activationId = accepted.optString("activationId")
            val activationGeneration = accepted.optLong("activationGeneration")
            assertTrue(activationId.isNotEmpty())
            assertTrue(activationGeneration > 0)
            awaitReports(reports) {
                it.optString("type") == "progress" && it.optString("itemId") == stub.itemId
            }
            val evidenced = awaitRendererStatus(host) { it.accepted && it.evidence }
            assertEquals(stub.itemId, evidenced.currentItemId)
            assertTrue(evidenced.playing)

            // Capture answers carry their bytes back to Core, which has
            // no lease waiting and honestly ignores the orphan answer.
            assertEquals(
                CoreRendererRequestCode.QUEUED,
                renderer.handle(
                    """{"op":"capture","requestId":"cap-1","maxWidth":320,"maxHeight":180,"maxBytes":100000}""",
                ),
            )
            val capture = awaitReports(reports) {
                it.optString("type") == "capture" && it.optString("requestId") == "cap-1"
            }
            assertEquals(
                jpegBytes.toList(),
                Base64.decode(capture.getString("jpegBase64"), Base64.NO_WRAP).toList(),
            )
            assertEquals(2, capture.getInt("width"))
            assertEquals(2, capture.getInt("height"))
            // The adapter lane is ordered, so each report's answer code
            // sits at the same index as the report itself.
            val captureIndex = reports.indexOfFirst {
                it.optString("type") == "capture" && it.optString("requestId") == "cap-1"
            }
            assertEquals(CoreReportCode.IGNORED, reportCodes[captureIndex])

            // The reload rung reboots the page in place: the same
            // generation re-readies (capabilities stay proven) and
            // the current activation re-presents.
            run {
                val mark = reports.size
                assertEquals(
                    CoreRendererRequestCode.QUEUED,
                    renderer.handle("""{"op":"command","command":"reload"}"""),
                )
                awaitReports(reports, fromIndex = mark) {
                    it.optString("type") == "ready" && it.optLong("generation") == firstGeneration
                }
                awaitReports(reports, fromIndex = mark) {
                    it.optString("type") == "accepted" &&
                        it.optString("activationId") == activationId
                }
                awaitRendererStatus(host) { it.accepted && it.evidence }
            }

            // A restart recreates the renderer, re-links Core, and
            // re-presents the same activation on the new generation.
            assertEquals(CoreRendererRequestCode.QUEUED, renderer.handle("""{"op":"restart"}"""))
            awaitReports(reports) {
                it.optString("type") == "disconnected" && it.optLong("generation") == firstGeneration
            }
            val reconnected = awaitReports(reports) {
                it.optString("type") == "connected" && it.optLong("generation") != firstGeneration
            }
            val secondGeneration = reconnected.getLong("generation")
            assertTrue(secondGeneration > firstGeneration)
            // The probe re-reports readiness with schema 2 unlocked;
            // only then can the re-pushed activation dispatch.
            awaitReports(reports) {
                if (it.optString("type") != "ready" || it.optLong("generation") != secondGeneration) {
                    return@awaitReports false
                }
                val schemas = it.getJSONObject("report").getJSONObject("support")
                    .getJSONArray("presentationSchemas")
                (0 until schemas.length()).map { index -> schemas.getInt(index) }.contains(2)
            }
            awaitReports(reports) {
                it.optString("type") == "accepted" &&
                    it.optString("activationId") == activationId &&
                    it.optLong("generation") == secondGeneration
            }
            // Status generation is the activation generation; the
            // accepted-on-second-generation report above is the
            // re-link proof.
            val relinked = awaitRendererStatus(host) {
                it.connected && it.accepted && it.evidence
            }
            assertEquals(stub.itemId, relinked.currentItemId)
            assertTrue(renderer.view?.isAttachedToWindow == true)

            // Safe mode shows its surface through the port while Core
            // keeps its current activation; the ladder itself never
            // engages here. The reason is unique to this run: absent
            // before, rendered after.
            val safeReason = "ladder gave up ${UUID.randomUUID()}"
            assertTrue(pageText(renderer.view)?.contains(safeReason) != true)
            assertEquals(
                CoreRendererRequestCode.QUEUED,
                renderer.handle("""{"op":"show_safe_mode","reason":"$safeReason"}"""),
            )
            var lastText: String? = null
            try {
                withTimeout(30_000) {
                    while (true) {
                        lastText = pageText(renderer.view)
                        if (lastText?.contains(safeReason) == true) break
                        delay(500)
                    }
                }
            } catch (_: kotlinx.coroutines.TimeoutCancellationException) {
                val timeline = reports.map { it.optString("type") + ":" + it.optLong("generation") }
                throw AssertionError(
                    "surface never rendered; last DOM text=${lastText?.take(400)} timeline=$timeline",
                )
            }
            val surfaced = awaitRendererStatus(host) { it.accepted && it.evidence && !it.safeMode }
            assertEquals(stub.itemId, surfaced.currentItemId)
            // Clearing safe mode is an honest no-op: the ladder never
            // engaged, so there is nothing to leave.
            val clearedSafeMode = host.rendererRecovery("""{"action":"clear_safe_mode"}""")
            assertTrue(
                "clear safe mode: $clearedSafeMode",
                clearedSafeMode.ok && clearedSafeMode.wasActive == false,
            )

            // Clearing withdraws the activation; the page goes unavailable.
            val cleared = host.rendererRecovery("""{"action":"clear","reason":"test done"}""")
            assertTrue("clear: $cleared", cleared.ok)
            awaitRendererStatus(host) { !it.accepted && !it.safeMode }
            Unit
        } finally {
            runCatching {
                scenario.onActivity { (renderer.view?.parent as? ViewGroup)?.removeView(renderer.view) }
            }
            runCatching { scenario.close() }
            runCatching { renderer.close() }
            runCatching { host.setRendererAdapterForTesting(CoreRendererAdapterRefusing) }
            host.stop()
            stub.stop()
            credentials.clear()
        }
    }
}