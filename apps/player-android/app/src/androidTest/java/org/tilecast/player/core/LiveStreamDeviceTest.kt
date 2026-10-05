package org.tilecast.player.core

import android.util.Base64
import androidx.test.platform.app.InstrumentationRegistry
import java.io.InputStream
import java.io.OutputStream
import java.net.ServerSocket
import java.nio.ByteBuffer
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.time.Instant
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlin.concurrent.thread
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.tilecast.player.security.KeystoreCredentialStore

/**
 * Qualifies Studio Watch Live on-device with a scripted renderer: pair
 * and sync to a playing presentation, then publish a lease and push
 * `live_stream.session_changed`; prove the driver requests a capture
 * bounded by the lease; answer it; and prove the TCLS version 1 frame
 * arrives on the player socket with the lease session, dimensions,
 * and JPEG bytes intact.
 */
class LiveStreamDeviceTest {
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
        val leaseId = UUID.randomUUID().toString()
        val leaseActive = AtomicBoolean(false)
        val binaryFrames = CopyOnWriteArrayList<ByteArray>()
        val socketUp = CountDownLatch(1)
        private val socketOut = AtomicReference<OutputStream?>(null)
        private val pairingPolls = AtomicInteger(0)
        private val payload = "tilecast-live-bytes:".toByteArray(StandardCharsets.UTF_8) +
            ByteArray(100 - "tilecast-live-bytes:".length) { 0x5A }
        private val digest = MessageDigest.getInstance("SHA-256").digest(payload)
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

        private fun leaseJson(): String {
            val expires = Instant.now().plusSeconds(600).toString()
            return if (leaseActive.get()) {
                """{"data":{"active":true,"id":"$leaseId","expiresAt":"$expires","frameIntervalMillis":1000,"maxWidth":320,"maxHeight":180,"maxFrameBytes":100000}}"""
            } else {
                """{"data":{"active":false}}"""
            }
        }

        fun start() {
            thread(name = "stub-live-server", isDaemon = true) {
                latch.countDown()
                while (!socket.isClosed) {
                    try {
                        val client = socket.accept()
                        // One thread per connection: the socket holds its
                        // connection open while HTTP keeps flowing.
                        thread(name = "stub-live-conn", isDaemon = true) {
                            try {
                                client.use { serve(it.getInputStream(), it.getOutputStream()) }
                            } catch (_: Exception) {
                            }
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

        fun pushSessionChanged() {
            val out = socketOut.get() ?: error("socket not connected")
            synchronized(out) {
                writeFrame(out, 0x81, """{"type":"live_stream.session_changed"}""".toByteArray(StandardCharsets.UTF_8))
                out.flush()
            }
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
                    """{"data":{"id":"$sessionId","code":"LIV333","pollSecret":"$pollSecret","expiresAt":"$expires","pollingIntervalSeconds":1,"approvalUrl":"$url/approve","organizationName":"Test Org"}}""",
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
                    """{"data":{"screenId":"$screenId","screenName":"Live Screen","deviceCredential":"$credential"}}""",
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
                return Route("200 OK", payload, "", "image/png")
            }
            if (method == "POST" && path == "/api/v1/player/heartbeat") {
                return json("200 OK", """{"data":{}}""")
            }
            if (method == "GET" && path == "/api/v1/player/commands") {
                return json("200 OK", """{"data":{"items":[]}}""")
            }
            if (method == "GET" && path == "/api/v1/player/live-stream-session") {
                return json("200 OK", leaseJson())
            }
            return json("404 Not Found", """{"error":{"code":"not_found","message":"no such stub route"}}""")
        }

        private data class Route(
            val status: String,
            val payload: ByteArray,
            val headers: String,
            val contentType: String,
        )

        private fun readHttp(input: InputStream): Triple<String, String, Map<String, String>>? {
            val head = StringBuilder()
            val byte = ByteArray(1)
            while (true) {
                if (input.read(byte) < 0) return null
                head.append(byte[0].toInt().toChar())
                if (head.endsWith("\r\n\r\n")) break
                if (head.length > 16_384) return null
            }
            val lines = head.toString().split("\r\n")
            val parts = lines.first().split(" ")
            if (parts.size < 2) return null
            val headers = mutableMapOf<String, String>()
            for (line in lines.drop(1)) {
                if (line.isEmpty()) continue
                val name = line.substringBefore(":").trim().lowercase()
                headers[name] = line.substringAfter(":").trim()
            }
            return Triple(parts[0], parts[1].substringBefore("?"), headers)
        }

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
            socketOut.set(out)
            socketUp.countDown()
            try {
                while (true) {
                    val (opcode, payload) = readRawFrame(input) ?: break
                    if (opcode == 0x2) binaryFrames += payload
                }
            } catch (_: Exception) {
            } finally {
                socketOut.compareAndSet(out, null)
            }
        }

        private fun readRawFrame(input: InputStream): Pair<Int, ByteArray>? {
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
            return (first and 0x0F) to payload
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

    private suspend fun awaitActivate(requests: CopyOnWriteArrayList<JSONObject>): JSONObject =
        withTimeout(60_000) {
            while (true) {
                val found = requests.firstOrNull { it.optString("op") == "activate" }
                if (found != null) return@withTimeout found
                delay(200)
            }
            error("unreachable")
        }

    private suspend fun awaitCapture(requests: CopyOnWriteArrayList<JSONObject>): JSONObject =
        withTimeout(60_000) {
            while (true) {
                // Lease bounds select the Watch Live capture; any other
                // capture policy answers for itself.
                val found = requests.firstOrNull {
                    it.optString("op") == "capture" &&
                        it.optInt("maxWidth") == 320 &&
                        it.optInt("maxHeight") == 180 &&
                        it.optInt("maxBytes") == 100000
                }
                if (found != null) return@withTimeout found
                delay(200)
            }
            error("unreachable")
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

    @Test fun watchLiveStreamsLeasedFramesToStudio() = runBlocking {
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
            assertTrue("socket never connected", stub.socketUp.await(30, TimeUnit.SECONDS))

            // The driver seats the playing presentation first, so the
            // leased capture sees real output rather than nothing.
            val first = host.syncManifest()
            assertTrue("first sync: $first", first.ok && first.version == 8L)
            val pushed = awaitActivate(adapter.requests)
            val activationId = pushed.getString("activationId")
            val activationGeneration = pushed.getLong("generation")
            host.rendererReport(
                """{"type":"accepted","generation":1,"activationId":"$activationId",""" +
                    """"activationGeneration":$activationGeneration}""",
            )
            host.rendererReport(
                """{"type":"progress","generation":1,"activationId":"$activationId",""" +
                    """"activationGeneration":$activationGeneration,"kind":"image-shown",""" +
                    """"itemId":"${stub.itemId}"}""",
            )
            awaitRendererStatus(host) { it.accepted && it.evidence }
            adapter.requests.clear()

            // Studio takes the lease; the push wakes an immediate
            // reconcile instead of waiting out the idle cadence.
            stub.leaseActive.set(true)
            stub.pushSessionChanged()
            val capture = awaitCapture(adapter.requests)
            assertEquals(320, capture.getInt("maxWidth"))
            assertEquals(180, capture.getInt("maxHeight"))
            assertEquals(100000, capture.getInt("maxBytes"))
            val requestId = capture.getString("requestId")
            assertTrue(requestId.isNotEmpty())

            // A complete 2x2 JPEG answers the bounded capture.
            val jpeg = byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 0x01, 0x02, 0xFF.toByte(), 0xD9.toByte())
            val answer = JSONObject()
                .put("type", "capture")
                .put("requestId", requestId)
                .put("jpegBase64", Base64.encodeToString(jpeg, Base64.NO_WRAP))
                .put("width", 2)
                .put("height", 2)
                .toString()
            assertEquals(CoreReportCode.APPLIED, host.rendererReport(answer))

            // The TCLS version 1 frame arrives on the player socket.
            val frame = withTimeout(30_000) {
                while (true) {
                    val found = stub.binaryFrames.firstOrNull()
                    if (found != null) return@withTimeout found
                    delay(200)
                }
                error("unreachable")
            }
            assertTrue(frame.size == 33 + jpeg.size)
            assertEquals("TCLS", String(frame, 0, 4, StandardCharsets.UTF_8))
            assertEquals(1, frame[4].toInt())
            val sessionBytes = ByteBuffer.wrap(frame, 5, 16)
            val high = sessionBytes.long
            val low = sessionBytes.long
            assertEquals(UUID(high, low).toString(), stub.leaseId)
            val capturedAt = ByteBuffer.wrap(frame, 21, 8).long
            assertTrue(capturedAt > 0)
            assertEquals(2, ByteBuffer.wrap(frame, 29, 2).short.toInt())
            assertEquals(2, ByteBuffer.wrap(frame, 31, 2).short.toInt())
            assertArrayEquals(jpeg, frame.copyOfRange(33, frame.size))
            Unit
        } finally {
            host.stop()
            stub.stop()
            credentials.clear()
        }
    }
}
