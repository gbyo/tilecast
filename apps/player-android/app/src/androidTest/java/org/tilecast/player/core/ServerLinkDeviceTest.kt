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
import android.os.SystemClock
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
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.tilecast.player.security.KeystoreCredentialStore

/**
 * Qualifies the Core server link on-device: the link idles unbound,
 * enrollment wakes it, the first pass reports a heartbeat with real
 * device and profile fields over the fallback POST (the stub has no
 * socket), the same pass reconciles configuration and prepares the
 * manifest, and status publishes the connected link state.
 */
class ServerLinkDeviceTest {
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
        val fallbackPlaylistId = UUID.randomUUID().toString()
        val heartbeats = CopyOnWriteArrayList<String>()
        val livenessHits = AtomicInteger(0)
        val requests = CopyOnWriteArrayList<String>()
        private val t0 = SystemClock.elapsedRealtime()
        val assetHits = AtomicInteger(0)
        val polls = AtomicInteger(0)
        private val payload = "tilecast-link-bytes:".toByteArray(StandardCharsets.UTF_8) +
            ByteArray(100 - "tilecast-link-bytes:".length) { 0x5A }
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
            "directFallbackPlaylist":{"id":"$fallbackPlaylistId","items":[{"id":"${UUID.randomUUID()}",
            "assetId":"$assetId","variantId":"$variantId","assetType":"image",
            "deliveryPolicy":"automatic","durationMs":10000,"fitMode":"cover",
            "transition":"fade","audioEnabled":true,"volume":0.8}]},
            "playlists":[],"schedules":[],"websites":[],"widgets":[],"dataSources":[],
            "plugins":[],"layouts":[]}
        """.trimIndent().replace("\n", "")

        private fun configJson() = """
            {"schemaVersion":1,"configRevision":7,"generatedAt":"2026-10-05T00:00:00Z",
            "branding":{"backgroundColor":"#112233","footerText":"Hello"},
            "playback":{"defaultVolume":0.7},"cache":{"maximumBytes":1073741824,"concurrentDownloads":3},
            "sync":{"statusReportSeconds":5},"reliability":{"mode":"managed_kiosk","playbackStallSeconds":20},
            "power":{"keepScreenOn":false,"outsideActiveHoursDisplay":"custom_text","outsideActiveHoursText":"Closed"},
            "managedKiosk":{"lockTaskEnabled":true,"adminSessionMinutes":20},
            "accessibility":{"returnDelaySeconds":15,"allowedPackages":["com.example.kiosk"]},
            "updates":{"channel":"beta"},"website":{"clearOnRestart":true,"defaultReloadPolicy":"interval"}}
        """.trimIndent().replace("\n", "")

        fun start() {
            thread(name = "stub-link-server", isDaemon = true) {
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
            requests += "${SystemClock.elapsedRealtime() - t0} $method $path"
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
            val (status, contentType, payload, headers) = route(method, path, String(bodyChars, 0, read), authorization)
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
                    """{"data":{"id":"$sessionId","code":"LNK111","pollSecret":"$pollSecret","expiresAt":"$expires","pollingIntervalSeconds":1,"approvalUrl":"$url/approve","organizationName":"Test Org"}}""",
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
                    """{"data":{"screenId":"$screenId","screenName":"Link Screen","deviceCredential":"$credential"}}""",
                )
            }
            if (method == "GET" && path == "/api/v1/player/config") {
                return json("200 OK", """{"data":${configJson()}}""", "ETag: \"config-7\"\r\n")
            }
            if (method == "GET" && path == "/api/v1/player/manifest") {
                return json("200 OK", """{"data":${manifestJson()}}""", "ETag: \"manifest-v8\"\r\n")
            }
            if (method == "GET" && path.startsWith("/api/v1/player/assets/")) {
                assetHits.incrementAndGet()
                return Route("200 OK", "image/png", payload, "")
            }
            if (method == "POST" && path == "/api/v1/player/heartbeat") {
                heartbeats += body
                return json("200 OK", """{"data":{}}""")
            }
            if (method == "POST" && path == "/api/v1/player/liveness") {
                if (authorization != "Bearer $credential") {
                    return json("401 Unauthorized", """{"error":{"code":"device_credential_invalid","message":"bad credential"}}""")
                }
                livenessHits.incrementAndGet()
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

    private suspend fun awaitHeartbeats(stub: StubServer, count: Int, timeoutMs: Long = 30_000) {
        try {
            withTimeout(timeoutMs) {
                while (stub.heartbeats.size < count) delay(200)
            }
        } catch (_: kotlinx.coroutines.TimeoutCancellationException) {
            throw AssertionError(
                "timed out waiting for $count heartbeats; got ${stub.heartbeats.size}\n" +
                    stub.requests.joinToString("\n"),
            )
        }
    }

    private suspend fun awaitAsset(stub: StubServer, timeoutMs: Long = 30_000) {
        try {
            withTimeout(timeoutMs) {
                while (stub.assetHits.get() < 1) delay(200)
            }
        } catch (_: kotlinx.coroutines.TimeoutCancellationException) {
            throw AssertionError("timed out waiting for the link to download the manifest object")
        }
    }

    @Test fun serverLinkReportsReconcilesAndConnects() = runBlocking {
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
            val initial = host.state.value as CoreHostState.Ready
            assertEquals("unbound", initial.status.linkState)
            assertEquals("not_bound", initial.status.linkReason)

            // Platform observations reported before pairing ride the
            // first heartbeat; unknown fields never cross.
            assertEquals(
                2,
                host.reportObservations(
                    """{"updateState":"installing","foregroundState":"foreground","bogusField":1}""",
                ),
            )

            // Setup reads the public identity before pairing anything.
            val identity = host.fetchIdentity(stub.url)
            assertTrue("identity failed: $identity", identity.ok)
            assertEquals(stub.installationId, identity.installationId)
            assertEquals("Test Org", identity.organizationName)

            val begin = host.beginPairing(stub.url)
            assertTrue("begin failed: $begin", begin.ok)
            awaitPaired(host)

            // A bound player answers the background liveness ping.
            val liveness = host.backgroundLiveness()
            assertEquals("accepted", liveness.outcome)
            assertEquals(1, stub.livenessHits.get())

            // The enrollment wakes the link; its first pass reports.
            awaitHeartbeats(stub, 1)
            val first = JSONObject(stub.heartbeats.first())
            assertEquals("installing", first.getString("updateState"))
            assertEquals("foreground", first.getString("foregroundState"))
            assertFalse(first.has("bogusField"))
            assertEquals("android", first.getString("playerFamily"))
            assertTrue(first.getInt("screenWidth") > 0)
            assertTrue(first.getInt("screenHeight") > 0)
            assertTrue(first.getString("playerVersion").isNotEmpty())
            assertTrue(first.getInt("androidSdk") >= 23)
            assertEquals("idle", first.getString("playbackState"))
            assertEquals(0, first.getInt("webRuntimeVersion"))
            // No renderer connected on this pass: the fresh-process
            // fallback (schema 1, legacy table, no Widget components).
            val schemas = first.getJSONArray("presentationSchemaVersions")
            assertEquals(1, schemas.length())
            assertEquals(1, schemas.getInt(0))
            val native = first.getJSONObject("nativePresentationCapabilities")
            assertTrue(native.has("content.text"))
            assertTrue(native.has("web.remote"))
            assertFalse(native.has("widget.tilecast.clock"))
            // The first heartbeat precedes reconciliation in the pass, so
            // versions are honestly absent rather than guessed.
            assertFalse(first.has("activeManifestVersion"))
            assertFalse(first.has("pendingManifestVersion"))
            assertTrue(first.isNull("assignedPlaylistId"))
            assertFalse(first.getBoolean("cachedFallbackAvailable"))
            assertFalse(first.has("lastSuccessfulSyncAt"))

            // The same pass reconciles configuration and prepares content.
            awaitAsset(stub)
            val sync = host.syncConfig()
            assertTrue("link-accepted config: $sync", sync.ok && sync.revision == 7L)

            // The next heartbeat reports what preparation staged. The
            // first heartbeat scheduled the next one from the
            // pre-configuration default, so this waits out the natural
            // sixty-second cadence, with margin for a loaded emulator.
            awaitHeartbeats(stub, 2, timeoutMs = 120_000)
            val second = JSONObject(stub.heartbeats[1])
            assertEquals(stub.fallbackPlaylistId, second.getString("assignedPlaylistId"))
            assertTrue(second.getBoolean("cachedFallbackAvailable"))
            assertTrue(second.getString("lastSuccessfulSyncAt").isNotEmpty())

            // The accepted configuration is readable split by owner,
            // and the binding facts identify the enrolled screen.
            val config = host.effectiveConfig()
            assertEquals(7L, config.revision)

            host.refreshStatus()
            val connected = host.state.value as CoreHostState.Ready
            assertEquals("connected", connected.status.linkState)
            assertEquals(7L, connected.status.configRevision)
            assertNotNull(connected.status.lastServerContactAt)
            assertEquals(stub.url, connected.status.serverUrl)
            assertNotNull(connected.status.installationId)
            assertNotNull(connected.status.screenId)
            assertNotNull(connected.status.screenName)
            assertEquals("active", connected.status.activeHoursState)
            assertTrue(connected.status.cachedFallbackAvailable)
        } finally {
            host.stop()
            stub.stop()
            credentials.clear()
        }
    }
}
