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
 * Qualifies Core command delivery on-device: a stub server delivers a
 * pure-state command and a platform command, the coordinator
 * acknowledges, runs, and reports both, the platform command crosses
 * JNI to the executor, and a restart re-polls without re-executing
 * settled commands. Reports repeat while the stub keeps delivering
 * (the server deduplicates them); executions must not.
 */
class CommandsDeviceTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext

    private class StubServer {
        val installationId = UUID.randomUUID().toString()
        val sessionId = UUID.randomUUID().toString()
        val screenId = UUID.randomUUID().toString()
        val pollSecret = "s".repeat(43)
        val enrollmentToken = "e".repeat(43)
        val credential = "tc_device_" + "c".repeat(26) + "." + "d".repeat(43)
        val disableId = UUID.randomUUID().toString()
        val disableKey = UUID.randomUUID().toString()
        val identifyId = UUID.randomUUID().toString()
        val identifyKey = UUID.randomUUID().toString()
        val assetId = UUID.randomUUID().toString()
        val variantId = UUID.randomUUID().toString()
        val reports = CopyOnWriteArrayList<Pair<String, JSONObject>>()
        val polls = AtomicInteger(0)
        private val pairingPolls = AtomicInteger(0)
        private val payload = "tilecast-command-bytes:".toByteArray(StandardCharsets.UTF_8) +
            ByteArray(100 - "tilecast-command-bytes:".length) { 0x5A }
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
            thread(name = "stub-commands-server", isDaemon = true) {
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
            val (status, payload, headers) = route(method, path, String(bodyChars, 0, read), authorization)
            val head = "HTTP/1.1 $status\r\nContent-Type: application/json\r\n$headers" +
                "Content-Length: ${payload.size}\r\nConnection: close\r\n\r\n"
            out.write(head.toByteArray(StandardCharsets.UTF_8))
            out.write(payload)
            out.flush()
        }

        private data class Route(val status: String, val payload: ByteArray, val headers: String)

        private fun json(status: String, payload: String, headers: String = "") =
            Route(status, payload.toByteArray(StandardCharsets.UTF_8), headers)

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
                    """{"data":{"id":"$sessionId","code":"CMD222","pollSecret":"$pollSecret","expiresAt":"$expires","pollingIntervalSeconds":1,"approvalUrl":"$url/approve","organizationName":"Test Org"}}""",
                )
            }
            if (method == "GET" && path == "/api/v1/player/pairing-sessions/$sessionId") {
                if (authorization != "Pairing $pollSecret") {
                    return json("401 Unauthorized", """{"error":{"code":"unauthorized","message":"bad poll secret"}}""")
                }
                return if (pairingPolls.getAndIncrement() == 0) {
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
                    """{"data":{"screenId":"$screenId","screenName":"Command Screen","deviceCredential":"$credential"}}""",
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
                return Route("200 OK", payload, "")
            }
            if (method == "POST" && path == "/api/v1/player/heartbeat") {
                return json("200 OK", """{"data":{}}""")
            }
            if (method == "GET" && path == "/api/v1/player/commands") {
                polls.incrementAndGet()
                // The same deliveries keep coming; settled commands must
                // not run or report again.
                return json(
                    "200 OK",
                    """{"data":{"items":[
                        {"id":"$disableId","type":"disable_playback",
                         "idempotencyKey":"$disableKey","payload":{},"state":"delivered"},
                        {"id":"$identifyId","type":"identify_screen",
                         "idempotencyKey":"$identifyKey","payload":{"durationSeconds":30},
                         "state":"delivered"}]}}""",
                )
            }
            if (method == "POST" && path.endsWith("/acknowledge")) {
                return json("200 OK", """{"data":{"state":"acknowledged"}}""")
            }
            if (method == "POST" && path.endsWith("/result")) {
                val id = path.removePrefix("/api/v1/player/commands/").removeSuffix("/result")
                reports += id to JSONObject(body)
                return json("200 OK", """{"data":{}}""")
            }
            return json("404 Not Found", """{"error":{"code":"not_found","message":"no such stub route"}}""")
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

    private suspend fun awaitReports(stub: StubServer, count: Int, timeoutMs: Long = 60_000) {
        try {
            withTimeout(timeoutMs) {
                while (stub.reports.size < count) delay(200)
            }
        } catch (_: kotlinx.coroutines.TimeoutCancellationException) {
            throw AssertionError("timed out waiting for $count reports; got ${stub.reports.size}")
        }
    }

    @Test fun commandsRunOnceAndSurviveRestart() = runBlocking {
        CoreTestFixtures.resetCoreFiles(context)
        val stub = StubServer()
        stub.start()
        val credentials = KeystoreCredentialStore(
            context,
            KeystoreCredentialStore.CORE_PREFS_NAME,
            KeystoreCredentialStore.CORE_KEY_ALIAS,
        )
        credentials.clear()
        val executed = CopyOnWriteArrayList<String>()
        val host = PlayerCoreHost.get(context)
        try {
            host.startCoreOnly()
            host.setPlatformExecutorForTesting(PlatformCommandExecutor { request ->
                executed += request
                PlatformCommandExecutor.result(true, "screen_identified", "shown")
            })

            val begin = host.beginPairing(stub.url)
            assertTrue("begin failed: $begin", begin.ok)
            awaitPaired(host)

            awaitReports(stub, 2)
            val byId = stub.reports.associate { it.first to it.second }
            val disable = byId[stub.disableId] ?: throw AssertionError("missing disable report: ${stub.reports}")
            assertTrue(disable.getBoolean("success"))
            assertEquals("playback_disabled", disable.getString("code"))
            val identify = byId[stub.identifyId] ?: throw AssertionError("missing identify report")
            assertTrue(identify.getBoolean("success"))
            assertEquals("screen_identified", identify.getString("code"))
            assertEquals(1, executed.size)
            val request = JSONObject(executed.first())
            assertEquals("identify_screen", request.getString("type"))
            assertEquals(30, request.getJSONObject("payload").getInt("durationSeconds"))

            // A restart re-polls the same deliveries but executes nothing
            // twice. Reports repeat (stored results re-sent); the
            // platform executor must see exactly one call overall.
            host.stop()
            host.setPlatformExecutorForTesting(PlatformCommandExecutor { request ->
                executed += request
                PlatformCommandExecutor.result(true, "screen_identified", "shown")
            })
            val pollsBefore = stub.polls.get()
            host.startCoreOnly()
            withTimeout(60_000) {
                while (stub.polls.get() < pollsBefore + 2) delay(200)
            }
            delay(2_000)
            assertEquals(1, executed.size)
            assertTrue(stub.reports.size >= 2)
            for ((id, report) in stub.reports) {
                assertTrue("report for $id: $report", report.getBoolean("success"))
                val expected = if (id == stub.disableId) "playback_disabled" else "screen_identified"
                assertEquals(expected, report.getString("code"))
            }
        } finally {
            host.stop()
            stub.stop()
            credentials.clear()
        }
    }
}
