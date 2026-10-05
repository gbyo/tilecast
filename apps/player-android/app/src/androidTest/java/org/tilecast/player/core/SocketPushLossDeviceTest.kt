package org.tilecast.player.core

import androidx.test.platform.app.InstrumentationRegistry
import java.io.InputStream
import java.io.OutputStream
import java.net.ServerSocket
import java.net.Socket
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.time.Instant
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlin.concurrent.thread
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.tilecast.player.security.KeystoreCredentialStore

/**
 * Qualifies socket push-loss recovery on-device: with the player socket
 * up and v8 prepared, the server drops the connection and replaces v8
 * with v9 without sending any push; the reconnect reconciles at once
 * and v9 ends prepared. The stub never sends a push in this test, so a
 * prepared v9 proves the reconcile path, not push handling.
 */
class SocketPushLossDeviceTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext

    private class StubServer {
        val installationId = UUID.randomUUID().toString()
        val sessionId = UUID.randomUUID().toString()
        val screenId = UUID.randomUUID().toString()
        val pollSecret = "s".repeat(43)
        val enrollmentToken = "e".repeat(43)
        val credential = "tc_device_" + "c".repeat(26) + "." + "d".repeat(43)
        val asset8 = UUID.randomUUID().toString()
        val variant8 = UUID.randomUUID().toString()
        val item8 = UUID.randomUUID().toString()
        val asset9 = UUID.randomUUID().toString()
        val variant9 = UUID.randomUUID().toString()
        val item9 = UUID.randomUUID().toString()
        val playlistId = UUID.randomUUID().toString()
        @Volatile var manifestVersion = 8
        val polls = AtomicInteger(0)
        val sockets = AtomicInteger(0)
        val asset9Hits = AtomicInteger(0)
        val pushesSent = AtomicInteger(0)
        private val connection = AtomicReference<Socket?>(null)
        private val bytes8 = "tilecast-pushloss-8:".toByteArray(StandardCharsets.UTF_8) +
            ByteArray(100 - "tilecast-pushloss-8:".length) { 0x5A }
        private val digest8 = MessageDigest.getInstance("SHA-256").digest(bytes8)
            .joinToString("") { "%02x".format(it) }
        private val bytes9 = "tilecast-pushloss-9:".toByteArray(StandardCharsets.UTF_8) +
            ByteArray(100 - "tilecast-pushloss-9:".length) { 0xA5.toByte() }
        private val digest9 = MessageDigest.getInstance("SHA-256").digest(bytes9)
            .joinToString("") { "%02x".format(it) }
        private val socket = ServerSocket(0)
        val port: Int = socket.localPort
        val url: String get() = "http://127.0.0.1:$port"
        private val latch = CountDownLatch(1)

        private fun manifestJson(version: Int): String {
            val (asset, variant, item, digest, size) = if (version == 8) {
                listOf(asset8, variant8, item8, digest8, bytes8.size.toString())
            } else {
                listOf(asset9, variant9, item9, digest9, bytes9.size.toString())
            }
            return """
                {"schemaVersion":11,"manifestVersion":$version,"screenId":"$screenId","mode":"presentation",
                "assets":[{"assetId":"$asset","variantId":"$variant","sha256":"$digest",
                "fileSize":$size,"mimeType":"image/png",
                "downloadPath":"/api/v1/player/assets/$asset/variants/$variant"}],
                "playlist":{"id":"$playlistId","items":[{"id":"$item","assetId":"$asset",
                "variantId":"$variant","assetType":"image","deliveryPolicy":"automatic",
                "durationMs":10000,"fitMode":"cover","transition":"fade",
                "audioEnabled":true,"volume":0.8}]},
                "playlists":[],"schedules":[],"websites":[],"widgets":[],"dataSources":[],
                "plugins":[],"layouts":[]}
            """.trimIndent().replace("\n", "")
        }

        fun start() {
            thread(name = "stub-pushloss", isDaemon = true) {
                latch.countDown()
                while (!socket.isClosed) {
                    try {
                        val client = socket.accept()
                        thread(name = "stub-pushloss-conn", isDaemon = true) {
                            try {
                                client.use { serve(client.getInputStream(), it.getOutputStream(), client) }
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

        fun dropSocket() {
            runCatching { connection.getAndSet(null)?.close() }
        }

        private fun serve(input: InputStream, out: OutputStream, client: Socket) {
            val (method, path, headers) = readHttp(input) ?: return
            if (path == "/api/v1/player/socket" && headers["upgrade"]?.lowercase() == "websocket") {
                serveSocket(input, out, headers["sec-websocket-key"] ?: return, client)
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
            val (status, payload, extra, contentType) =
                route(method, path, String(body, StandardCharsets.UTF_8))
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

        private fun route(method: String, path: String, body: String): Route {
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
                    """{"data":{"id":"$sessionId","code":"PLS888","pollSecret":"$pollSecret","expiresAt":"$expires","pollingIntervalSeconds":1,"approvalUrl":"$url/approve","organizationName":"Test Org"}}""",
                )
            }
            if (method == "GET" && path == "/api/v1/player/pairing-sessions/$sessionId") {
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
                    """{"data":{"screenId":"$screenId","screenName":"Push Loss Screen","deviceCredential":"$credential"}}""",
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
                val version = manifestVersion
                return json("200 OK", """{"data":${manifestJson(version)}}""", "ETag: \"manifest-v$version\"\r\n")
            }
            if (method == "GET" && path == "/api/v1/player/assets/$asset8/variants/$variant8") {
                return Route("200 OK", bytes8, "", "image/png")
            }
            if (method == "GET" && path == "/api/v1/player/assets/$asset9/variants/$variant9") {
                asset9Hits.incrementAndGet()
                return Route("200 OK", bytes9, "", "image/png")
            }
            if (method == "POST" && path == "/api/v1/player/heartbeat") {
                return json("200 OK", """{"data":{}}""")
            }
            if (method == "POST" && path == "/api/v1/player/activity-events") {
                val items = runCatching { JSONObject(body).getJSONArray("events") }.getOrNull() ?: JSONArray()
                val ids = JSONArray()
                for (i in 0 until items.length()) ids.put(items.getJSONObject(i).getString("id"))
                return json("200 OK", """{"data":{"acknowledgedEventIds":$ids}}""")
            }
            if (method == "GET" && path == "/api/v1/player/commands") {
                return json("200 OK", """{"data":{"items":[]}}""")
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

        private fun serveSocket(input: InputStream, out: OutputStream, key: String, client: Socket) {
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
            connection.set(client)
            sockets.incrementAndGet()
            try {
                // No pushes are ever sent here; the socket only stays
                // open until the test drops it.
                while (true) {
                    if (input.read() < 0) break
                }
            } catch (_: Exception) {
            } finally {
                connection.compareAndSet(client, null)
            }
        }
    }

    @Test fun droppedSocketReconnectReconcilesWithoutPush() = runBlocking {
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
            val begin = host.beginPairing(stub.url)
            assertTrue("begin failed: $begin", begin.ok)
            withTimeout(30_000) {
                while (host.pairingState.value !is CorePairingState.Paired) delay(200)
            }
            withTimeout(30_000) {
                while (stub.sockets.get() < 1) delay(200)
            }
            val first = host.syncManifest()
            assertTrue("first sync: $first", first.ok && first.version == 8L)

            // The outage: socket dropped and v8 replaced, with no push.
            stub.manifestVersion = 9
            stub.dropSocket()
            withTimeout(60_000) {
                while (stub.sockets.get() < 2) delay(200)
            }
            // The reconnect reconciles at once; v9 prepares with no push.
            val healed = withTimeout(60_000) {
                while (true) {
                    val sync = host.syncManifest()
                    if (sync.ok && sync.version == 9L) return@withTimeout sync
                    delay(1000)
                }
                error("unreachable")
            }
            assertTrue(healed.outcome == "prepared" || healed.outcome == "current")
            assertEquals(1, stub.asset9Hits.get())
            assertEquals(0, stub.pushesSent.get())
        } finally {
            host.stop()
            stub.stop()
            credentials.clear()
        }
    }
}
