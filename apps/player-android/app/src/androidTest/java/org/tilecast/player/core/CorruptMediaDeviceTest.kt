package org.tilecast.player.core

import androidx.test.platform.app.InstrumentationRegistry
import java.io.BufferedReader
import java.io.File
import java.io.OutputStream
import java.net.ServerSocket
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.time.Instant
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.tilecast.player.security.KeystoreCredentialStore

/**
 * Qualifies corrupt-media handling on-device: bytes that do not match the
 * manifest digest fail the sync with a reason instead of poisoning the
 * store, and serving the true bytes then prepares; afterwards, tampering
 * with the committed CAS object is detected and repaired by refetch on
 * the next sync.
 */
class CorruptMediaDeviceTest {
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
        @Volatile var serveGoodBytes = false
        val polls = AtomicInteger(0)
        val assetHits = AtomicInteger(0)
        private val good = "tilecast-honest-bytes:".toByteArray(StandardCharsets.UTF_8) +
            ByteArray(100 - "tilecast-honest-bytes:".length) { 0x5A }
        private val bad = "tilecast-dishonest-bytes:".toByteArray(StandardCharsets.UTF_8) +
            ByteArray(100 - "tilecast-dishonest-bytes:".length) { 0xA5.toByte() }
        val digest = MessageDigest.getInstance("SHA-256").digest(good)
            .joinToString("") { "%02x".format(it) }
        private val socket = ServerSocket(0)
        val port: Int = socket.localPort
        val url: String get() = "http://127.0.0.1:$port"
        private val latch = CountDownLatch(1)

        private fun manifestJson() = """
            {"schemaVersion":11,"manifestVersion":8,"screenId":"$screenId","mode":"presentation",
            "assets":[{"assetId":"$assetId","variantId":"$variantId","sha256":"$digest",
            "fileSize":${good.size},"mimeType":"image/png",
            "downloadPath":"/api/v1/player/assets/$assetId/variants/$variantId"}],
            "playlist":{"id":"$playlistId","items":[{"id":"$itemId","assetId":"$assetId",
            "variantId":"$variantId","assetType":"image","deliveryPolicy":"automatic",
            "durationMs":10000,"fitMode":"cover","transition":"fade",
            "audioEnabled":true,"volume":0.8}]},
            "playlists":[],"schedules":[],"websites":[],"widgets":[],"dataSources":[],
            "plugins":[],"layouts":[]}
        """.trimIndent().replace("\n", "")

        fun start() {
            thread(name = "stub-corrupt-media", isDaemon = true) {
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
                    """{"data":{"id":"$sessionId","code":"CRP999","pollSecret":"$pollSecret","expiresAt":"$expires","pollingIntervalSeconds":1,"approvalUrl":"$url/approve","organizationName":"Test Org"}}""",
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
                    """{"data":{"screenId":"$screenId","screenName":"Corrupt Screen","deviceCredential":"$credential"}}""",
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
            if (method == "GET" && path == "/api/v1/player/assets/$assetId/variants/$variantId") {
                assetHits.incrementAndGet()
                return Route("200 OK", "image/png", if (serveGoodBytes) good else bad, "")
            }
            if (method == "POST" && path == "/api/v1/player/heartbeat") {
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

    @Test fun corruptDownloadFailsAndTamperedObjectRepairs() = runBlocking {
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
            awaitPaired(host)

            // Wrong bytes fail the sync with a reason; nothing poisons
            // the store, and the true bytes then prepare.
            val corrupt = host.syncManifest()
            assertTrue("corrupt sync: $corrupt", corrupt.ok && corrupt.outcome == "failed" && corrupt.version == 8L)
            assertNotNull(corrupt.reason)
            stub.serveGoodBytes = true
            val prepared = host.syncManifest()
            assertTrue(
                "healed sync: $prepared",
                prepared.ok && prepared.version == 8L &&
                    (prepared.outcome == "prepared" || prepared.outcome == "current"),
            )

            // Truncating the committed object is detected and repaired
            // by refetch on the next sync. (Same-size tampering is a
            // CAS trust question, not a sync question: verified objects
            // are re-hashed at commit and after a crash, and served by
            // record in between — Core-owned, identical on Edge.)
            val casObject = File(context.filesDir, "player-core/cas/sha256/${stub.digest.take(2)}/${stub.digest}")
            assertTrue(casObject.isFile)
            casObject.writeBytes(ByteArray(50) { 0x11 })
            val repaired = host.syncManifest()
            assertTrue(
                "repair sync: $repaired",
                repaired.ok && repaired.outcome == "repaired" && repaired.version == 8L,
            )
            assertTrue(stub.assetHits.get() >= 3)
            val settled = host.syncManifest()
            assertTrue(
                "settled sync: $settled",
                settled.ok && settled.outcome == "current" && settled.version == 8L,
            )
        } finally {
            host.stop()
            stub.stop()
            credentials.clear()
        }
    }
}
