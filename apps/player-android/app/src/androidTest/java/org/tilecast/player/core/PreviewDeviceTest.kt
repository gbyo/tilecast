package org.tilecast.player.core

import androidx.test.platform.app.InstrumentationRegistry
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
 * Qualifies periodic preview on-device with a scripted renderer: pair and
 * sync to a playing presentation, then prove an active preview session
 * uploads the answered JPEG as multipart; a safe-mode presentation
 * refuses capture and uploads Unavailable instead; and a renderer
 * capture fault uploads Unavailable without suspending the loop.
 */
class PreviewDeviceTest {
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
        @Volatile var previewActive = false
        val polls = AtomicInteger(0)
        val previews = CopyOnWriteArrayList<ByteArray>()
        private val payload = "tilecast-preview-bytes:".toByteArray(StandardCharsets.UTF_8) +
            ByteArray(100 - "tilecast-preview-bytes:".length) { 0x5A }
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
            "durationMs":600000,"fitMode":"cover","transition":"fade",
            "audioEnabled":true,"volume":0.8}]},
            "playlists":[],"schedules":[],"websites":[],"widgets":[],"dataSources":[],
            "plugins":[],"layouts":[]}
        """.trimIndent().replace("\n", "")

        fun start() {
            thread(name = "stub-preview", isDaemon = true) {
                latch.countDown()
                while (!socket.isClosed) {
                    try {
                        socket.accept().use { client ->
                            handle(client.getInputStream(), client.getOutputStream())
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

        private fun handle(raw: java.io.InputStream, out: OutputStream) {
            // Binary-safe body read: previews arrive as multipart bytes,
            // so headers are scanned byte-by-byte off the raw stream and
            // the body is never decoded as text.
            val headerBytes = mutableListOf<Byte>()
            val window = ArrayDeque<Byte>()
            while (true) {
                val next = raw.read()
                if (next < 0) return
                val byte = next.toByte()
                headerBytes.add(byte)
                window.addLast(byte)
                if (window.size > 4) window.removeFirst()
                if (window.size == 4 && window[0] == '\r'.code.toByte() && window[1] == '\n'.code.toByte() &&
                    window[2] == '\r'.code.toByte() && window[3] == '\n'.code.toByte()
                ) {
                    break
                }
                if (headerBytes.size > 32 * 1024) return
            }
            val headerText = String(headerBytes.toByteArray(), StandardCharsets.US_ASCII)
            val lines = headerText.split("\r\n")
            val requestLine = lines.firstOrNull() ?: return
            val parts = requestLine.split(" ")
            if (parts.size < 2) return
            val method = parts[0]
            val path = parts[1].substringBefore("?")
            var contentLength = 0
            var authorization: String? = null
            for (line in lines.drop(1)) {
                if (line.startsWith("Content-Length:", ignoreCase = true)) {
                    contentLength = line.substringAfter(":").trim().toIntOrNull() ?: 0
                }
                if (line.startsWith("Authorization:", ignoreCase = true)) {
                    authorization = line.substringAfter(":").trim()
                }
            }
            val body = ByteArray(contentLength)
            var read = 0
            while (read < contentLength) {
                val next = raw.read(body, read, contentLength - read)
                if (next < 0) break
                read += next
            }
            val bodyText = String(body, 0, read, StandardCharsets.UTF_8)
            val (status, contentType, payload, headers) = route(method, path, bodyText, body, authorization)
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

        private fun route(
            method: String,
            path: String,
            bodyText: String,
            body: ByteArray,
            authorization: String?,
        ): Route {
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
                    """{"data":{"id":"$sessionId","code":"PRV555","pollSecret":"$pollSecret","expiresAt":"$expires","pollingIntervalSeconds":1,"approvalUrl":"$url/approve","organizationName":"Test Org"}}""",
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
                if (!bodyText.contains(enrollmentToken)) {
                    return json("400 Bad Request", """{"error":{"code":"bad_token","message":"wrong token"}}""")
                }
                return json(
                    "200 OK",
                    """{"data":{"screenId":"$screenId","screenName":"Preview Screen","deviceCredential":"$credential"}}""",
                )
            }
            if (method == "GET" && path == "/api/v1/player/config") {
                return json(
                    "200 OK",
                    """{"data":{"schemaVersion":1,"configRevision":7,"generatedAt":"2026-09-24T00:00:00Z"}}""",
                    "ETag: \"config-7\"\r\n",
                )
            }
            if (method == "GET" && path == "/api/v1/player/manifest") {
                return json("200 OK", """{"data":${manifestJson()}}""", "ETag: \"manifest-v8\"\r\n")
            }
            if (method == "GET" && path.startsWith("/api/v1/player/assets/")) {
                return Route("200 OK", "image/png", payload, "")
            }
            if (method == "POST" && path == "/api/v1/player/heartbeat") {
                return json("200 OK", """{"data":{}}""")
            }
            if (method == "GET" && path == "/api/v1/player/preview-session") {
                return if (previewActive) {
                    json(
                        "200 OK",
                        """{"data":{"active":true,"captureNow":true,"captureIntervalSeconds":3600}}""",
                    )
                } else {
                    json("200 OK", """{"data":{"active":false}}""")
                }
            }
            if (method == "POST" && path == "/api/v1/player/preview") {
                previews += body
                return json("200 OK", """{"data":{}}""")
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
        skip: Int = 0,
        timeoutMs: Long = 60_000,
    ): JSONObject = try {
        withTimeout(timeoutMs) {
            while (true) {
                val found = requests.filter { it.optString("op") == "activate" }.drop(skip).firstOrNull()
                if (found != null) return@withTimeout found
                delay(200)
            }
            error("unreachable")
        }
    } catch (_: kotlinx.coroutines.TimeoutCancellationException) {
        throw AssertionError("timed out waiting for activate #$skip; got ${requests.size} requests")
    }

    private suspend fun awaitCapture(
        requests: CopyOnWriteArrayList<JSONObject>,
        skip: Int = 0,
        timeoutMs: Long = 90_000,
    ): JSONObject = try {
        withTimeout(timeoutMs) {
            while (true) {
                val found = requests.filter { it.optString("op") == "capture" }.drop(skip).firstOrNull()
                if (found != null) return@withTimeout found
                delay(200)
            }
            error("unreachable")
        }
    } catch (_: kotlinx.coroutines.TimeoutCancellationException) {
        throw AssertionError("timed out waiting for capture #$skip; got ${requests.size} requests")
    }

    private suspend fun awaitPreview(stub: StubServer, skip: Int = 0, timeoutMs: Long = 90_000): ByteArray =
        try {
            withTimeout(timeoutMs) {
                while (true) {
                    val found = stub.previews.drop(skip).firstOrNull()
                    if (found != null) return@withTimeout found
                    delay(200)
                }
                error("unreachable")
            }
        } catch (_: kotlinx.coroutines.TimeoutCancellationException) {
            throw AssertionError("timed out waiting for preview #$skip; got ${stub.previews.size} uploads")
        }

    @Test fun previewUploadsImageRefusesProtectedAndSurvivesFault() = runBlocking {
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
            val begin = host.beginPairing(stub.url)
            assertTrue("begin failed: $begin", begin.ok)
            awaitPaired(host)
            val first = host.syncManifest()
            assertTrue("first sync: $first", first.ok && first.version == 8L)
            val pushed = awaitActivate(adapter.requests)
            val activationId = pushed.getString("activationId")
            val activationGeneration = pushed.getLong("generation")
            assertEquals(
                CoreReportCode.APPLIED,
                host.rendererReport(
                    """{"type":"accepted","generation":1,"activationId":"$activationId",""" +
                        """"activationGeneration":$activationGeneration}""",
                ),
            )

            // The active session captures within the preview bounds and
            // uploads the answered JPEG as multipart.
            stub.previewActive = true
            val capture = awaitCapture(adapter.requests)
            assertEquals(960, capture.getInt("maxWidth"))
            assertEquals(540, capture.getInt("maxHeight"))
            assertEquals(500 * 1024, capture.getInt("maxBytes"))
            val requestId = capture.getString("requestId")
            assertTrue(requestId.isNotEmpty())
            val jpeg = byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 0x01, 0x02, 0xFF.toByte(), 0xD9.toByte())
            assertEquals(
                CoreReportCode.APPLIED,
                host.rendererReport(
                    JSONObject()
                        .put("type", "capture")
                        .put("requestId", requestId)
                        .put("jpegBase64", android.util.Base64.encodeToString(jpeg, android.util.Base64.NO_WRAP))
                        .put("width", 320)
                        .put("height", 180)
                        .toString(),
                ),
            )
            val image = awaitPreview(stub)
            val imageText = String(image, Charsets.ISO_8859_1)
            assertTrue(imageText.contains("name=\"preview\""))
            assertTrue(imageText.contains("width\"\r\n\r\n320"))
            assertTrue(imageText.contains("height\"\r\n\r\n180"))
            assertTrue(imageText.contains(String(jpeg, Charsets.ISO_8859_1)))

            // Safe mode refuses capture: no new capture request, and the
            // next upload reports Unavailable. The selection driver may
            // re-push playing first (10-minute items make that slow);
            // retry the safe-mode activation until protection wins.
            var protected = false
            repeat(3) {
                if (protected) return@repeat
                val safe = host.activatePresentation(
                    """{"envelope":{"presentation":{"state":"safe-mode","reason":"preview protection"}},""" +
                        """"content":[],"source":"safe_mode","clockOffsetMs":0}""",
                )
                assertTrue("safe-mode activate: $safe", safe.ok)
                // Baseline after the push: the safe-mode activation
                // itself is an activate op, not a driver re-push.
                delay(500)
                val activates = adapter.requests.count { it.optString("op") == "activate" }
                val captures = adapter.requests.count { it.optString("op") == "capture" }
                val uploads = stub.previews.size
                val deadline = System.currentTimeMillis() + 25_000
                while (System.currentTimeMillis() < deadline) {
                    if (stub.previews.size > uploads) {
                        val unavailable = stub.previews.last()
                        val text = String(unavailable, Charsets.ISO_8859_1)
                        if (text.contains("failureStatus") && !text.contains("name=\"preview\"")) {
                            assertEquals(captures, adapter.requests.count { it.optString("op") == "capture" })
                            protected = true
                            return@repeat
                        }
                    }
                    if (adapter.requests.count { it.optString("op") == "activate" } > activates) {
                        break
                    }
                    delay(200)
                }
            }
            assertTrue("safe mode never refused a capture", protected)

            // Back to playing, a renderer capture fault uploads
            // Unavailable without suspending the loop: the upload after
            // it carries an image again.
            val playing = host.activatePresentation(
                """{"envelope":{"presentation":{"state":"playing","items":[{"id":"${stub.itemId}","kind":"image","src":"tcmedia:${stub.assetId}/${stub.variantId}"}]}},""" +
                    """"content":[{"assetId":"${stub.assetId}","variantId":"${stub.variantId}","digest":"${stub.digest}","sizeBytes":${100},"mimeType":"image/png"}],""" +
                    """"source":"server_manifest","clockOffsetMs":0}""",
            )
            assertTrue("playing activate: $playing", playing.ok)
            val faultCapture = awaitCapture(adapter.requests, skip = adapter.requests.count { it.optString("op") == "capture" })
            assertEquals(
                CoreReportCode.APPLIED,
                host.rendererReport(
                    JSONObject()
                        .put("type", "capture")
                        .put("requestId", faultCapture.getString("requestId"))
                        .put("unavailable", true)
                        .put("code", "camera_busy")
                        .toString(),
                ),
            )
            val faulted = awaitPreview(stub, skip = stub.previews.size)
            val faultedText = String(faulted, Charsets.ISO_8859_1)
            assertTrue(faultedText.contains("failureStatus"))
            val recoveryCapture = awaitCapture(adapter.requests, skip = adapter.requests.count { it.optString("op") == "capture" })
            assertEquals(
                CoreReportCode.APPLIED,
                host.rendererReport(
                    JSONObject()
                        .put("type", "capture")
                        .put("requestId", recoveryCapture.getString("requestId"))
                        .put("jpegBase64", android.util.Base64.encodeToString(jpeg, android.util.Base64.NO_WRAP))
                        .put("width", 320)
                        .put("height", 180)
                        .toString(),
                ),
            )
            val recovered = awaitPreview(stub, skip = stub.previews.size)
            assertTrue(String(recovered, Charsets.ISO_8859_1).contains("name=\"preview\""))
        } finally {
            host.stop()
            stub.stop()
            credentials.clear()
        }
    }
}
