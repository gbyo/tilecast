package org.tilecast.player.core

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
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.tilecast.player.security.KeystoreCredentialStore

/**
 * Qualifies Studio Watch Live lease replacement and expiry on-device: a
 * playing presentation streams frames under lease A, a pushed replacement
 * lease B restarts capture under the new bounds with no straggler A
 * frames, and an ended lease silences captures and frames alike.
 */
class WatchLiveReplaceDeviceTest {
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
        @Volatile var leaseId = UUID.randomUUID().toString()
        @Volatile var leaseWidth = 320
        @Volatile var leaseHeight = 180
        val leaseActive = AtomicBoolean(false)
        val binaryFrames = CopyOnWriteArrayList<ByteArray>()
        val socketUp = CountDownLatch(1)
        private val socketOut = AtomicReference<OutputStream?>(null)
        private val pairingPolls = AtomicInteger(0)
        private val payload = "tilecast-live-replace:".toByteArray(StandardCharsets.UTF_8) +
            ByteArray(100 - "tilecast-live-replace:".length) { 0x5A }
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
                """{"data":{"active":true,"id":"$leaseId","expiresAt":"$expires","frameIntervalMillis":1000,"maxWidth":$leaseWidth,"maxHeight":$leaseHeight,"maxFrameBytes":100000}}"""
            } else {
                """{"data":{"active":false}}"""
            }
        }

        fun start() {
            thread(name = "stub-live-replace", isDaemon = true) {
                latch.countDown()
                while (!socket.isClosed) {
                    try {
                        val client = socket.accept()
                        thread(name = "stub-live-replace-conn", isDaemon = true) {
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

        private data class Route(
            val status: String,
            val payload: ByteArray,
            val headers: String,
            val contentType: String,
        )

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
                    """{"data":{"id":"$sessionId","code":"RPL666","pollSecret":"$pollSecret","expiresAt":"$expires","pollingIntervalSeconds":1,"approvalUrl":"$url/approve","organizationName":"Test Org"}}""",
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
                    """{"data":{"screenId":"$screenId","screenName":"Replace Screen","deviceCredential":"$credential"}}""",
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

        private fun readHttp(input: InputStream): Triple<String, String, Map<String, String>>? {
            val headerBytes = mutableListOf<Byte>()
            val window = ArrayDeque<Byte>()
            while (true) {
                val next = input.read()
                if (next < 0) return null
                val byte = next.toByte()
                headerBytes.add(byte)
                window.addLast(byte)
                if (window.size > 4) window.removeFirst()
                if (window.size == 4 && window[0] == '\r'.code.toByte() && window[1] == '\n'.code.toByte() &&
                    window[2] == '\r'.code.toByte() && window[3] == '\n'.code.toByte()
                ) {
                    break
                }
                if (headerBytes.size > 32 * 1024) return null
            }
            val lines = String(headerBytes.toByteArray(), StandardCharsets.US_ASCII).split("\r\n")
            val parts = (lines.firstOrNull() ?: return null).split(" ")
            if (parts.size < 2) return null
            val headers = mutableMapOf<String, String>()
            for (line in lines.drop(1)) {
                val name = line.substringBefore(":").trim().lowercase()
                if (name.isNotEmpty()) headers[name] = line.substringAfter(":").trim()
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

    private fun sessionOf(frame: ByteArray): String {
        val sessionBytes = ByteBuffer.wrap(frame, 5, 16)
        return UUID(sessionBytes.long, sessionBytes.long).toString()
    }

    @Test fun watchLiveReplacementRestartsAndExpirySilences() = runBlocking {
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
        val jpeg = byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 0x01, 0x02, 0xFF.toByte(), 0xD9.toByte())
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
            val begin = host.beginPairing(stub.url)
            assertTrue("begin failed: $begin", begin.ok)
            withTimeout(30_000) {
                while (host.pairingState.value !is CorePairingState.Paired) delay(200)
            }
            assertTrue("socket never connected", stub.socketUp.await(30, TimeUnit.SECONDS))
            val first = host.syncManifest()
            assertTrue("first sync: $first", first.ok && first.version == 8L)
            val pushed = withTimeout(60_000) {
                while (true) {
                    val found = adapter.requests.firstOrNull { it.optString("op") == "activate" }
                    if (found != null) return@withTimeout found
                    delay(200)
                }
                error("unreachable")
            }
            host.rendererReport(
                """{"type":"accepted","generation":1,"activationId":"${pushed.getString("activationId")}",""" +
                    """"activationGeneration":${pushed.getLong("generation")}}""",
            )
            adapter.requests.clear()

            // Every capture is answered while the test runs, so frames
            // flow whenever a lease is live.
            var answered = 0
            val answerer = launch {
                while (isActive) {
                    val pending = adapter.requests.filter { it.optString("op") == "capture" }.drop(answered)
                    for (capture in pending) {
                        host.rendererReport(
                            JSONObject()
                                .put("type", "capture")
                                .put("requestId", capture.getString("requestId"))
                                .put("jpegBase64", android.util.Base64.encodeToString(jpeg, android.util.Base64.NO_WRAP))
                                .put("width", 2)
                                .put("height", 2)
                                .toString(),
                        )
                        answered++
                    }
                    delay(100)
                }
            }
            try {
                // Lease A streams.
                val leaseA = stub.leaseId
                stub.leaseActive.set(true)
                stub.pushSessionChanged()
                withTimeout(30_000) {
                    while (stub.binaryFrames.isEmpty()) delay(200)
                }
                assertEquals(leaseA, sessionOf(stub.binaryFrames.first()))

                // A pushed replacement restarts capture under the new
                // bounds; no straggler A frame may follow the first B.
                val leaseB = UUID.randomUUID().toString()
                stub.leaseId = leaseB
                stub.leaseWidth = 640
                stub.leaseHeight = 360
                val framesBeforeReplace = stub.binaryFrames.size
                stub.pushSessionChanged()
                withTimeout(30_000) {
                    while (stub.binaryFrames.size <= framesBeforeReplace) delay(200)
                }
                val replaced = stub.binaryFrames.drop(framesBeforeReplace)
                assertTrue(replaced.isNotEmpty())
                assertEquals(leaseB, sessionOf(replaced.first()))
                delay(3000)
                val afterFirstB = stub.binaryFrames.drop(framesBeforeReplace)
                assertTrue(afterFirstB.size >= 2)
                assertTrue(
                    "straggler frames: ${afterFirstB.map(::sessionOf)}",
                    afterFirstB.all { sessionOf(it) == leaseB },
                )
                assertTrue(
                    "new bounds never requested",
                    adapter.requests.any {
                        it.optString("op") == "capture" && it.optInt("maxWidth") == 640 && it.optInt("maxHeight") == 360
                    },
                )

                // An ended lease silences captures and frames alike.
                stub.leaseActive.set(false)
                stub.pushSessionChanged()
                val capturesAtEnd = adapter.requests.count { it.optString("op") == "capture" }
                val framesAtEnd = stub.binaryFrames.size
                delay(3500)
                assertEquals(capturesAtEnd, adapter.requests.count { it.optString("op") == "capture" })
                assertEquals(framesAtEnd, stub.binaryFrames.size)
            } finally {
                answerer.cancel()
            }
            Unit
        } finally {
            host.stop()
            stub.stop()
            credentials.clear()
        }
    }
}
