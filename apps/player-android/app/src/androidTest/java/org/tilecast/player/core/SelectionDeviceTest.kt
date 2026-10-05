package org.tilecast.player.core

import androidx.test.platform.app.InstrumentationRegistry
import java.io.BufferedReader
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
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.tilecast.player.security.KeystoreCredentialStore

/**
 * Qualifies Core selection on-device with a scripted renderer: pair and
 * sync against a stub server, then prove the selection driver projects
 * the prepared manifest and activates it without any manual call; feed
 * acceptance and evidence back through the report path; restart with
 * the server gone and prove the committed presentation returns offline
 * with no further network use. The pending-to-active promotion itself
 * is Core logic covered by Core's own coordinator tests; this test
 * proves the host side that feeds it: projection, activation, and
 * evidence reporting from real on-device state.
 */
class SelectionDeviceTest {
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
        val manifestHits = AtomicInteger(0)
        val assetHits = AtomicInteger(0)
        val polls = AtomicInteger(0)
        private val payload = "tilecast-selection-bytes:".toByteArray(StandardCharsets.UTF_8) +
            ByteArray(100 - "tilecast-selection-bytes:".length) { 0x5A }
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
            thread(name = "stub-selection-server", isDaemon = true) {
                latch.countDown()
                while (!socket.isClosed) {
                    try {
                        socket.accept().use { client ->
                            handle(client.getInputStream().bufferedReader(), client.getOutputStream())
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

        private fun handle(reader: BufferedReader, out: OutputStream) {
            val requestLine = reader.readLine() ?: return
            val parts = requestLine.split(" ")
            if (parts.size < 2) return
            val method = parts[0]
            val path = parts[1].substringBefore("?")
            var contentLength = 0
            var authorization: String? = null
            while (true) {
                val line = reader.readLine() ?: break
                if (line.isEmpty()) break
                if (line.startsWith("Content-Length:", ignoreCase = true)) {
                    contentLength = line.substringAfter(":").trim().toIntOrNull() ?: 0
                }
                if (line.startsWith("Authorization:", ignoreCase = true)) {
                    authorization = line.substringAfter(":").trim()
                }
            }
            val bodyChars = CharArray(contentLength)
            var read = 0
            while (read < contentLength) {
                val next = reader.read(bodyChars, read, contentLength - read)
                if (next < 0) break
                read += next
            }
            val body = String(bodyChars, 0, read)
            val (status, contentType, payload, headers) = route(method, path, body, authorization)
            val head = "HTTP/1.1 $status\r\nContent-Type: $contentType\r\n$headers" +
                "Content-Length: ${payload.size}\r\nConnection: close\r\n\r\n"
            out.write(head.toByteArray(StandardCharsets.UTF_8))
            out.write(payload)
            out.flush()
        }

        private data class Route(
            val status: String,
            val contentType: String,
            val payload: ByteArray,
            val headers: String,
        )

        private fun json(status: String, payload: String, headers: String = "") =
            Route(status, "application/json", payload.toByteArray(StandardCharsets.UTF_8), headers)

        private fun route(method: String, path: String, body: String, authorization: String?): Route {
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
                    """{"data":{"id":"$sessionId","code":"SEL888","pollSecret":"$pollSecret","expiresAt":"$expires","pollingIntervalSeconds":1,"approvalUrl":"$url/approve","organizationName":"Test Org"}}""",
                )
            }
            if (method == "GET" && path == "/api/v1/player/pairing-sessions/$sessionId") {
                if (authorization != "Pairing $pollSecret") {
                    return json("401 Unauthorized", """{"error":{"code":"unauthorized","message":"bad poll secret"}}""")
                }
                return if (polls.getAndIncrement() == 0) {
                    json("200 OK", """{"data":{"status":"pending"}}""")
                } else {
                    json("200 OK", """{"data":{"status":"claimed","enrollmentToken":"$enrollmentToken"}}""")
                }
            }
            if (method == "POST" && path == "/api/v1/player/enroll") {
                if (!body.contains(enrollmentToken)) {
                    return json("400 Bad Request", """{"error":{"code":"bad_token","message":"wrong token"}}""")
                }
                return json(
                    "200 OK",
                    """{"data":{"screenId":"$screenId","screenName":"Selection Screen","deviceCredential":"$credential"}}""",
                )
            }
            if (method == "GET" && path == "/api/v1/player/manifest") {
                manifestHits.incrementAndGet()
                return json("200 OK", """{"data":${manifestJson()}}""", "ETag: \"manifest-v8\"\r\n")
            }
            if (method == "GET" && path.startsWith("/api/v1/player/assets/")) {
                assetHits.incrementAndGet()
                return Route("200 OK", "image/png", payload, "")
            }
            return json("404 Not Found", """{"error":{"code":"not_found","message":"no such stub route"}}""")
        }
    }

    private class RecordingAdapter : CoreRendererAdapter {
        val requests = CopyOnWriteArrayList<JSONObject>()
        override fun handle(envelope: String): Int {
            runCatching { requests += JSONObject(envelope) }
            return CoreRendererRequestCode.QUEUED
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

    private suspend fun awaitActivate(
        requests: CopyOnWriteArrayList<JSONObject>,
        timeoutMs: Long = 60_000,
    ): JSONObject = try {
        withTimeout(timeoutMs) {
            while (true) {
                val found = requests.firstOrNull { it.optString("op") == "activate" }
                if (found != null) return@withTimeout found
                delay(200)
            }
            error("unreachable")
        }
    } catch (_: kotlinx.coroutines.TimeoutCancellationException) {
        val summary = requests.joinToString("; ") { it.toString().take(2000) }
        throw AssertionError("timed out waiting for a pushed activate; got ${requests.size} requests: $summary")
    }

    private suspend fun awaitRendererStatus(
        host: PlayerCoreHost,
        timeoutMs: Long = 60_000,
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

    @Test fun selectionDriverProjectsActivatesAndReturnsOffline() = runBlocking {
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
        val adapter = RecordingAdapter()
        try {
            host.startDrivers()
            assertTrue(host.state.value is CoreHostState.Ready)
            host.attachRendererAdapter(adapter)
            // The scripted renderer links with the packaged image profile.
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
            awaitRendererStatus(host) { it.connected && it.ready }

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

            // Nobody calls activate: the driver projects the prepared
            // manifest and pushes it once the scripted renderer is ready.
            val pushed = awaitActivate(adapter.requests)
            val presentation = pushed.getJSONObject("presentation")
            assertEquals("playing", presentation.getString("state"))
            assertEquals(8, presentation.getInt("generation"))
            val items = presentation.getJSONArray("items")
            assertEquals(1, items.length())
            assertEquals(stub.itemId, items.getJSONObject(0).getString("id"))
            assertEquals("image", items.getJSONObject(0).getString("kind"))
            assertEquals(
                "tcmedia://variant/${stub.assetId}/${stub.variantId}",
                items.getJSONObject(0).getString("src"),
            )
            assertEquals("cover", items.getJSONObject(0).getString("fitMode"))
            assertEquals("fade", items.getJSONObject(0).getString("transition"))
            val content = pushed.getJSONArray("content")
            assertEquals(1, content.length())
            assertEquals(stub.digest, content.getJSONObject(0).getString("digest"))
            val activationId = pushed.getString("activationId")
            val activationGeneration = pushed.getLong("generation")

            // Acceptance plus meaningful evidence promotes the trial.
            assertEquals(
                CoreReportCode.APPLIED,
                host.rendererReport(
                    """{"type":"accepted","generation":1,"activationId":"$activationId",""" +
                        """"activationGeneration":$activationGeneration}""",
                ),
            )
            assertEquals(
                CoreReportCode.APPLIED,
                host.rendererReport(
                    """{"type":"progress","generation":1,"activationId":"$activationId",""" +
                        """"activationGeneration":$activationGeneration,"kind":"image-shown",""" +
                        """"itemId":"${stub.itemId}"}""",
                ),
            )
            val evidenced = awaitRendererStatus(host) { it.accepted && it.evidence }
            assertTrue(evidenced.playing)

            // Restart with the server gone: the committed presentation
            // returns offline, fetching no further bytes.
            val manifestHitsBefore = stub.manifestHits.get()
            host.stop()
            stub.stop()
            adapter.requests.clear()
            host.startDrivers()
            assertTrue(host.state.value is CoreHostState.Ready)
            host.attachRendererAdapter(adapter)
            assertEquals(
                CoreReportCode.APPLIED,
                host.rendererReport("""{"type":"connected","generation":2}"""),
            )
            assertEquals(
                CoreReportCode.APPLIED,
                host.rendererReport(
                    """{"type":"ready","generation":2,"report":{"features":["status-surfaces-v1","image"],""" +
                        """"support":{"presentationSchemas":[1,2]}}}""",
                ),
            )
            val offline = awaitActivate(adapter.requests)
            assertEquals(
                stub.itemId,
                offline.getJSONObject("presentation").getJSONArray("items").getJSONObject(0).getString("id"),
            )
            assertEquals(manifestHitsBefore, stub.manifestHits.get())
            assertEquals(1, stub.assetHits.get())
        } finally {
            host.stop()
            stub.stop()
            credentials.clear()
        }
    }
}
