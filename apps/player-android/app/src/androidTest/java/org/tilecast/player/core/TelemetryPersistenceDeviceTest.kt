package org.tilecast.player.core

import androidx.test.platform.app.InstrumentationRegistry
import java.io.BufferedReader
import java.io.OutputStream
import java.net.ServerSocket
import java.nio.charset.StandardCharsets
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
import org.junit.Assert.assertTrue
import org.junit.Test
import org.tilecast.player.security.KeystoreCredentialStore

/**
 * Qualifies telemetry persistence on-device: a minute sample observed
 * while the server is down survives a restart offline and uploads with
 * its original observation time once the server returns. The stub
 * rebinds the same port across the outage so the player's URL stays
 * valid. (Outbox bounds — 120 samples, oldest evicted, drops counted —
 * are proven by a host-side Rust test; two hours of samples cannot run
 * on-device.)
 */
class TelemetryPersistenceDeviceTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext

    private class StubServer {
        val installationId = UUID.randomUUID().toString()
        val sessionId = UUID.randomUUID().toString()
        val screenId = UUID.randomUUID().toString()
        val pollSecret = "s".repeat(43)
        val enrollmentToken = "e".repeat(43)
        val credential = "tc_device_" + "c".repeat(26) + "." + "d".repeat(43)
        val polls = AtomicInteger(0)
        val samples = CopyOnWriteArrayList<JSONObject>()
        @Volatile private var socket: ServerSocket? = null
        @Volatile var port: Int = 0
        val url: String get() = "http://127.0.0.1:$port"

        fun start() {
            val server = if (port == 0) ServerSocket(0) else ServerSocket(port)
            port = server.localPort
            socket = server
            val latch = CountDownLatch(1)
            thread(name = "stub-telemetry", isDaemon = true) {
                latch.countDown()
                while (!server.isClosed) {
                    try {
                        server.accept().use { client ->
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
            runCatching { socket?.close() }
            socket = null
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
                    """{"data":{"id":"$sessionId","code":"TLM777","pollSecret":"$pollSecret","expiresAt":"$expires","pollingIntervalSeconds":1,"approvalUrl":"$url/approve","organizationName":"Test Org"}}""",
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
                    """{"data":{"screenId":"$screenId","screenName":"Telemetry Screen","deviceCredential":"$credential"}}""",
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
                return json("404 Not Found", """{"error":{"code":"not_found","message":"no manifest"}}""")
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
            if (method == "POST" && path == "/api/v1/player/telemetry") {
                runCatching { samples += JSONObject(body) }
                return json("200 OK", """{"data":{}}""")
            }
            return json("404 Not Found", """{"error":{"code":"not_found","message":"no such stub route"}}""")
        }
    }

    @Test fun offlineSampleSurvivesRestartAndUploads() = runBlocking {
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
            val driverStarted = System.currentTimeMillis()
            host.startDrivers()
            assertTrue(host.state.value is CoreHostState.Ready)
            val begin = host.beginPairing(stub.url)
            assertTrue("begin failed: $begin", begin.ok)
            withTimeout(30_000) {
                while (host.pairingState.value !is CorePairingState.Paired) delay(200)
            }

            // The server goes down; the first minute sample is observed
            // and queued with nowhere to upload.
            stub.stop()
            val sampleDueAt = driverStarted + 75_000
            while (System.currentTimeMillis() < sampleDueAt) delay(1000)

            // Restart offline, then bring the server back: the queued
            // sample uploads with its original observation time.
            val restartAt = Instant.now().toString()
            host.stop()
            stub.start()
            host.startDrivers()
            assertTrue(host.state.value is CoreHostState.Ready)
            withTimeout(90_000) {
                while (stub.samples.isEmpty()) delay(500)
            }
            val sample = stub.samples.first()
            assertTrue("sample not from before the restart: $sample", sample.getString("observedAt") < restartAt)
            assertTrue(sample.getLong("deviceUptimeSeconds") > 0)
        } finally {
            host.stop()
            stub.stop()
            credentials.clear()
        }
    }
}
