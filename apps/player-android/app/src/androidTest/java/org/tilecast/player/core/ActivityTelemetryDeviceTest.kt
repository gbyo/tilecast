package org.tilecast.player.core

import androidx.test.platform.app.InstrumentationRegistry
import java.io.BufferedReader
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
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.tilecast.player.security.KeystoreCredentialStore

/**
 * Qualifies Core Activity and telemetry on-device. A stub WebSocket
 * drops the first connection of each process and holds the next one
 * with server pings, so the link records connection loss and
 * recovery. The Activity driver uploads the events with envelope,
 * sequence, and timezone; a restart keeps the sequence moving; and
 * the telemetry driver uploads a minute sample with real gauges and
 * no invented renderer fields.
 */
class ActivityTelemetryDeviceTest {
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
        val events = CopyOnWriteArrayList<JSONObject>()
        val samples = CopyOnWriteArrayList<JSONObject>()
        val pongs = AtomicInteger(0)
        val sockets = AtomicInteger(0)
        private val pairingPolls = AtomicInteger(0)
        private val payload = "tilecast-activity-bytes:".toByteArray(StandardCharsets.UTF_8) +
            ByteArray(100 - "tilecast-activity-bytes:".length) { 0x5A }
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
            "playlist":{"id":"${UUID.randomUUID()}","items":[{"id":"${UUID.randomUUID()}",
            "assetId":"$assetId","variantId":"$variantId","assetType":"image",
            "deliveryPolicy":"automatic","durationMs":10000,"fitMode":"cover",
            "transition":"fade","audioEnabled":true,"volume":0.8}]},
            "playlists":[],"schedules":[],"websites":[],"widgets":[],"dataSources":[],
            "plugins":[],"layouts":[]}
        """.trimIndent().replace("\n", "")

        fun start() {
            thread(name = "stub-activity-server", isDaemon = true) {
                latch.countDown()
                while (!socket.isClosed) {
                    try {
                        val client = socket.accept()
                        thread(name = "stub-activity-conn", isDaemon = true) {
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
                val name = line.substringBefore(":").trim().lowercase()
                headers[name] = line.substringAfter(":").trim()
            }
            return Triple(parts[0], parts[1].substringBefore("?"), headers)
        }

        private fun serve(input: InputStream, out: OutputStream) {
            val (method, path, headers) = readHttp(input) ?: return
            if (path == "/api/v1/player/socket" && headers["upgrade"]?.lowercase() == "websocket") {
                serveSocket(input, out, headers["sec-websocket-key"] ?: return)
                return
            }
            var contentLength = headers["content-length"]?.toIntOrNull() ?: 0
            val body = ByteArray(contentLength)
            var read = 0
            while (read < contentLength) {
                val next = input.read(body, read, contentLength - read)
                if (next < 0) break
                read += next
            }
            val (status, payload, extra) = route(method, path, String(body, StandardCharsets.UTF_8))
            val head = "HTTP/1.1 $status\r\nContent-Type: application/json\r\n$extra" +
                "Content-Length: ${payload.size}\r\nConnection: close\r\n\r\n"
            out.write(head.toByteArray(StandardCharsets.UTF_8))
            out.write(payload)
            out.flush()
        }

        private fun route(method: String, path: String, body: String): Triple<String, ByteArray, String> {
            fun json(status: String, payload: String, headers: String = "") =
                Triple(status, payload.toByteArray(StandardCharsets.UTF_8), headers)
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
                    """{"data":{"id":"$sessionId","code":"ACT333","pollSecret":"$pollSecret","expiresAt":"$expires","pollingIntervalSeconds":1,"approvalUrl":"$url/approve","organizationName":"Test Org"}}""",
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
                    """{"data":{"screenId":"$screenId","screenName":"Activity Screen","deviceCredential":"$credential"}}""",
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
                return Triple("200 OK", payload, "")
            }
            if (method == "POST" && path == "/api/v1/player/heartbeat") {
                return json("200 OK", """{"data":{}}""")
            }
            if (method == "GET" && path == "/api/v1/player/commands") {
                return json("200 OK", """{"data":{"items":[]}}""")
            }
            if (method == "POST" && path == "/api/v1/player/activity-events") {
                val items = runCatching { JSONObject(body).getJSONArray("events") }.getOrNull() ?: JSONArray()
                val ids = JSONArray()
                for (i in 0 until items.length()) {
                    val event = items.getJSONObject(i)
                    events += event
                    ids.put(event.getString("id"))
                }
                return json("200 OK", """{"data":{"acknowledgedEventIds":$ids}}""")
            }
            if (method == "POST" && path == "/api/v1/player/telemetry") {
                runCatching { samples += JSONObject(body) }
                return json("200 OK", """{"data":{}}""")
            }
            return json("404 Not Found", """{"error":{"code":"not_found","message":"no such stub route"}}""")
        }

        private fun serveSocket(input: InputStream, out: OutputStream, key: String) {
            val number = sockets.incrementAndGet()
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
            // Odd connections drop after the hello; even ones stay up with
            // server pings. Each process therefore records one loss and one
            // recovery.
            val held = number % 2 == 0
            val reader = thread(name = "stub-socket-read", isDaemon = true) {
                try {
                    while (true) {
                        val text = readFrame(input) ?: break
                        if (text.contains("player.pong")) pongs.incrementAndGet()
                    }
                } catch (_: Exception) {
                }
            }
            try {
                Thread.sleep(1_000)
                if (!held) {
                    writeFrame(out, 0x88, ByteArray(0))
                    out.flush()
                    Thread.sleep(500)
                    return
                }
                repeat(12) {
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
            val opcode = first and 0x0F
            if (opcode == 0x8) return null
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

    private suspend fun awaitEvents(stub: StubServer, count: Int, timeoutMs: Long = 90_000) {
        try {
            withTimeout(timeoutMs) {
                while (stub.events.size < count) delay(500)
            }
        } catch (_: kotlinx.coroutines.TimeoutCancellationException) {
            throw AssertionError("timed out waiting for $count events; got ${stub.events.size}")
        }
    }

    @Test fun activityUploadsConnectivityAndTelemetrySamples() = runBlocking {
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
            val begin = host.beginPairing(stub.url)
            assertTrue("begin failed: $begin", begin.ok)
            awaitPaired(host)

            // The dropped socket and its recovery upload as events.
            awaitEvents(stub, 2)
            val names = stub.events.map { it.getString("eventType") }
            assertTrue("events: $names", names.contains("connection.lost"))
            assertTrue("events: $names", names.contains("connection.restored"))
            for (event in stub.events) {
                assertTrue(event.getString("id").isNotEmpty())
                assertTrue(event.getInt("sequence") > 0)
                assertEquals("connectivity", event.getString("category"))
                assertTrue(event.getString("occurredAt").isNotEmpty())
                assertTrue(event.getString("playerTimezone").isNotEmpty())
            }
            val lost = stub.events.first { it.getString("eventType") == "connection.lost" }
            val restored = stub.events.first { it.getString("eventType") == "connection.restored" }
            assertTrue(restored.getInt("sequence") > lost.getInt("sequence"))

            // The first minute sample carries real gauges and no
            // invented renderer fields.
            withTimeout(120_000) {
                while (stub.samples.isEmpty()) delay(500)
            }
            val sample = stub.samples.first()
            assertTrue(sample.getLong("cacheUsedBytes") >= 0)
            assertTrue(sample.getLong("cacheLimitBytes") > 0)
            assertTrue(sample.getLong("freeStorageBytes") > 0)
            assertTrue(sample.getLong("deviceUptimeSeconds") > 0)
            assertTrue(sample.getString("displayResolution").matches(Regex("\\d+x\\d+")))
            // No renderer is attached in this test, and the sample
            // says exactly that; item fields stay absent without
            // an activation to report on.
            assertEquals("disconnected", sample.getString("rendererState"))
            assertFalse(sample.has("currentItemId"))
            assertFalse(sample.has("lastMeaningfulProgressAt"))

            // A restart keeps the sequence moving across the boundary.
            val maxBefore = stub.events.maxOf { it.getInt("sequence") }
            host.stop()
            host.startCoreOnly()
            awaitEvents(stub, stub.events.size + 2)
            val after = stub.events.filter { it.getInt("sequence") > maxBefore }
            assertTrue("post-restart events: ${after.size}", after.size >= 2)
            val postNames = after.map { it.getString("eventType") }
            assertTrue("post-restart: $postNames", postNames.contains("connection.lost"))
            assertTrue("post-restart: $postNames", postNames.contains("connection.restored"))
        } finally {
            host.stop()
            stub.stop()
            credentials.clear()
        }
    }
}
