package org.tilecast.player.core

import androidx.test.platform.app.InstrumentationRegistry
import java.io.BufferedReader
import java.io.OutputStream
import java.net.ServerSocket
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.time.Instant
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import kotlin.concurrent.thread
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.tilecast.player.security.KeystoreCredentialStore

/**
 * Qualifies manifest replacement during download on-device: v8 carries a
 * throttled multi-megabyte asset that the link starts preparing after
 * enrollment; while it is still in flight the server replaces v8 with a
 * small v9, and a sync must land on v9 prepared without getting stuck
 * behind the abandoned fetch. The stub serves every connection on its
 * own thread so the slow asset never blocks manifest or config routes.
 */
class ManifestReplaceDeviceTest {
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
        val manifestHits = AtomicInteger(0)
        val asset8Requested = CountDownLatch(1)
        val asset8Bytes = AtomicLong(0)
        val asset9Hits = AtomicInteger(0)
        val asset9Bytes = AtomicLong(0)
        private val slow = ByteArray(3 * 1024 * 1024) { 0x5A }
        private val slowDigest = MessageDigest.getInstance("SHA-256").digest(slow)
            .joinToString("") { "%02x".format(it) }
        private val fast = "tilecast-replacement-bytes:".toByteArray(StandardCharsets.UTF_8) +
            ByteArray(100 - "tilecast-replacement-bytes:".length) { 0x5A }
        private val fastDigest = MessageDigest.getInstance("SHA-256").digest(fast)
            .joinToString("") { "%02x".format(it) }
        private val socket = ServerSocket(0)
        val port: Int = socket.localPort
        val url: String get() = "http://127.0.0.1:$port"
        private val latch = CountDownLatch(1)

        private fun manifestJson(version: Int): String {
            val (asset, variant, item, digest, size) = if (version == 8) {
                listOf(asset8, variant8, item8, slowDigest, slow.size.toString())
            } else {
                listOf(asset9, variant9, item9, fastDigest, fast.size.toString())
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
            thread(name = "stub-manifest-replace", isDaemon = true) {
                latch.countDown()
                while (!socket.isClosed) {
                    try {
                        val client = socket.accept()
                        thread(name = "stub-conn", isDaemon = true) {
                            try {
                                client.use {
                                    handle(it.getInputStream().bufferedReader(), it.getOutputStream())
                                }
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

        private fun handle(reader: BufferedReader, out: OutputStream) {
            val requestLine = reader.readLine() ?: return
            val parts = requestLine.split(" ")
            if (parts.size < 2) return
            val method = parts[0]
            val path = parts[1].substringBefore("?")
            var contentLength = 0
            var authorization: String? = null
            var ifNoneMatch: String? = null
            while (true) {
                val line = reader.readLine() ?: break
                if (line.isEmpty()) break
                if (line.startsWith("Content-Length:", ignoreCase = true)) {
                    contentLength = line.substringAfter(":").trim().toIntOrNull() ?: 0
                }
                if (line.startsWith("Authorization:", ignoreCase = true)) {
                    authorization = line.substringAfter(":").trim()
                }
                if (line.startsWith("If-None-Match:", ignoreCase = true)) {
                    ifNoneMatch = line.substringAfter(":").trim()
                }
            }
            val bodyChars = CharArray(contentLength)
            var read = 0
            while (read < contentLength) {
                val next = reader.read(bodyChars, read, contentLength - read)
                if (next < 0) break
                read += next
            }
            route(method, path, String(bodyChars, 0, read), authorization, ifNoneMatch, out)
        }

        private fun send(out: OutputStream, status: String, contentType: String, payload: ByteArray, headers: String = "") {
            val head = "HTTP/1.1 $status\r\nContent-Type: $contentType\r\n$headers" +
                "Content-Length: ${payload.size}\r\nConnection: close\r\n\r\n"
            out.write(head.toByteArray(StandardCharsets.UTF_8))
            out.write(payload)
            out.flush()
        }

        private fun sendJson(out: OutputStream, status: String, payload: String, headers: String = "") =
            send(out, status, "application/json", payload.toByteArray(StandardCharsets.UTF_8), headers)

        private fun route(
            method: String,
            path: String,
            body: String,
            authorization: String?,
            ifNoneMatch: String?,
            out: OutputStream,
        ) {
            if (method == "GET" && path == "/api/v1/system/identity") {
                sendJson(
                    out,
                    "200 OK",
                    """{"data":{"product":"tilecast","installationId":"$installationId","organizationName":"Test Org","apiVersion":"1","pairingEnabled":true}}""",
                )
                return
            }
            if (method == "POST" && path == "/api/v1/player/pairing-sessions") {
                val expires = Instant.now().plusSeconds(600).toString()
                sendJson(
                    out,
                    "200 OK",
                    """{"data":{"id":"$sessionId","code":"RPL333","pollSecret":"$pollSecret","expiresAt":"$expires","pollingIntervalSeconds":1,"approvalUrl":"$url/approve","organizationName":"Test Org"}}""",
                )
                return
            }
            if (method == "GET" && path == "/api/v1/player/pairing-sessions/$sessionId") {
                if (authorization != "Pairing $pollSecret") {
                    sendJson(out, "401 Unauthorized", """{"error":{"code":"unauthorized","message":"bad poll secret"}}""")
                    return
                }
                if (polls.getAndIncrement() == 0) {
                    sendJson(out, "200 OK", """{"data":{"status":"pending"}}""")
                } else {
                    sendJson(out, "200 OK", """{"data":{"status":"claimed","enrollmentToken":"$enrollmentToken"}}""")
                }
                return
            }
            if (method == "POST" && path == "/api/v1/player/enroll") {
                if (!body.contains(enrollmentToken)) {
                    sendJson(out, "400 Bad Request", """{"error":{"code":"bad_token","message":"wrong token"}}""")
                    return
                }
                sendJson(
                    out,
                    "200 OK",
                    """{"data":{"screenId":"$screenId","screenName":"Replace Screen","deviceCredential":"$credential"}}""",
                )
                return
            }
            if (method == "GET" && path == "/api/v1/player/config") {
                sendJson(
                    out,
                    "200 OK",
                    """{"data":{"schemaVersion":1,"configRevision":7,"generatedAt":"2026-09-24T00:00:00Z"}}""",
                    "ETag: \"config-7\"\r\n",
                )
                return
            }
            if (method == "GET" && path == "/api/v1/player/manifest") {
                manifestHits.incrementAndGet()
                val version = manifestVersion
                if (ifNoneMatch == "\"manifest-v$version\"") {
                    send(out, "304 Not Modified", "application/json", ByteArray(0))
                    return
                }
                sendJson(out, "200 OK", """{"data":${manifestJson(version)}}""", "ETag: \"manifest-v$version\"\r\n")
                return
            }
            if (method == "GET" && path == "/api/v1/player/assets/$asset8/variants/$variant8") {
                asset8Requested.countDown()
                val head = "HTTP/1.1 200 OK\r\nContent-Type: image/png\r\n" +
                    "Content-Length: ${slow.size}\r\nConnection: close\r\n\r\n"
                out.write(head.toByteArray(StandardCharsets.UTF_8))
                out.flush()
                // Throttled past any test timeout margin: whoever fetches
                // v8 is still mid-download when v9 replaces it.
                var offset = 0
                while (offset < slow.size) {
                    val end = minOf(offset + 32 * 1024, slow.size)
                    try {
                        out.write(slow, offset, end - offset)
                        out.flush()
                    } catch (_: Exception) {
                        break
                    }
                    asset8Bytes.addAndGet((end - offset).toLong())
                    offset = end
                    Thread.sleep(100)
                }
                return
            }
            if (method == "GET" && path == "/api/v1/player/assets/$asset9/variants/$variant9") {
                asset9Hits.incrementAndGet()
                asset9Bytes.addAndGet(fast.size.toLong())
                send(out, "200 OK", "image/png", fast)
                return
            }
            if (method == "POST" && path == "/api/v1/player/heartbeat") {
                sendJson(out, "200 OK", """{"data":{}}""")
                return
            }
            sendJson(out, "404 Not Found", """{"error":{"code":"not_found","message":"no such stub route"}}""")
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

    @Test fun manifestReplacementWinsWhileOldDownloadIsInFlight() = runBlocking {
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
            host.startDrivers()
            assertTrue(host.state.value is CoreHostState.Ready)
            val begin = host.beginPairing(stub.url)
            assertTrue("begin failed: $begin", begin.ok)
            awaitPaired(host)

            // The link's own prepare starts the slow v8 fetch in the
            // background; the replacement lands while it is in flight.
            assertTrue("v8 fetch never started", stub.asset8Requested.await(60, TimeUnit.SECONDS))
            stub.manifestVersion = 9
            val replaced = withTimeout(60_000) { host.syncManifest() }
            assertTrue(
                "replacement sync: $replaced",
                replaced.ok && replaced.version == 9L &&
                    (replaced.outcome == "prepared" || replaced.outcome == "current"),
            )
            assertEquals(1, stub.asset9Hits.get())
            assertEquals(100, stub.asset9Bytes.get())

            // The end state is stable: v9 is current and stays current.
            val settled = host.syncManifest()
            assertTrue(
                "settled sync: $settled",
                settled.ok && settled.outcome == "current" && settled.version == 9L,
            )
        } finally {
            host.stop()
            stub.stop()
            credentials.clear()
        }
    }
}
