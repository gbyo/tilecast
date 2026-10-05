package org.tilecast.player.core

import androidx.test.platform.app.InstrumentationRegistry
import java.io.BufferedReader
import java.io.OutputStream
import java.net.ServerSocket
import java.nio.charset.StandardCharsets
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
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.tilecast.player.security.KeystoreCredentialStore

/**
 * Qualifies Core server-link resilience on-device: enroll against a stub
 * server, then prove credential revocation stops the link with its reason
 * and re-pairing restores it, a changed installation ID stops the link
 * with a mismatch without ever sending the stored credential, and a
 * disabled screen keeps the link retrying until the server re-enables
 * it. Phases restart the host because the steady-state contact interval
 * is a minute and every restart runs an immediate first pass.
 *
 * Mismatch recovery is deliberately not covered: Core has no unpair API
 * (reset preserves the enrolled credential by design, on Edge too), so
 * a reinstalled server needs fresh setup. This test proves the safety
 * half: stop, report, and never send the credential.
 */
class LinkResilienceDeviceTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext

    private class StubServer {
        @Volatile var installationId = UUID.randomUUID().toString()
        @Volatile var heartbeatMode = "ok"
        @Volatile var installationFlipped = false
        val authedAfterFlip = AtomicInteger(0)
        val screenId = UUID.randomUUID().toString()
        val sessions = AtomicInteger(0)
        private val polls = mutableMapOf<String, AtomicInteger>()
        private val tokens = mutableMapOf<String, String>()
        private val numbers = mutableMapOf<String, Int>()
        val heartbeats = AtomicInteger(0)
        private val socket = ServerSocket(0)
        val port: Int = socket.localPort
        val url: String get() = "http://127.0.0.1:$port"
        private val latch = CountDownLatch(1)

        fun credentialFor(session: Int) = "tc_device_" + "c$session".padEnd(26, 'c') + "." + "d".repeat(43)

        fun start() {
            thread(name = "stub-link-resilience", isDaemon = true) {
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
            if (installationFlipped && !authorization.isNullOrEmpty()) {
                authedAfterFlip.incrementAndGet()
            }
            val bodyChars = CharArray(contentLength)
            var read = 0
            while (read < contentLength) {
                val next = reader.read(bodyChars, read, contentLength - read)
                if (next < 0) break
                read += next
            }
            val body = String(bodyChars, 0, read)
            val (status, contentType, payload, headers) = route(method, path, body)
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

        private fun configJson() =
            """{"schemaVersion":1,"configRevision":7,"generatedAt":"2026-09-24T00:00:00Z"}"""

        private fun route(method: String, path: String, body: String): Route {
            if (method == "GET" && path == "/api/v1/system/identity") {
                return json(
                    "200 OK",
                    """{"data":{"product":"tilecast","installationId":"$installationId","organizationName":"Test Org","apiVersion":"1","pairingEnabled":true}}""",
                )
            }
            if (method == "POST" && path == "/api/v1/player/pairing-sessions") {
                val number = sessions.incrementAndGet()
                val id = UUID.randomUUID().toString()
                val secret = "s$number".padEnd(43, 's')
                polls[id] = AtomicInteger(0)
                tokens[id] = "e$number".padEnd(43, 'e')
                numbers[id] = number
                val expires = Instant.now().plusSeconds(600).toString()
                return json(
                    "200 OK",
                    """{"data":{"id":"$id","code":"RS$number","pollSecret":"$secret","expiresAt":"$expires","pollingIntervalSeconds":1,"approvalUrl":"$url/approve","organizationName":"Test Org"}}""",
                )
            }
            if (method == "GET" && path.startsWith("/api/v1/player/pairing-sessions/")) {
                val id = path.substringAfterLast("/")
                val count = polls[id]?.getAndIncrement() ?: return json(
                    "404 Not Found",
                    """{"error":{"code":"not_found","message":"no such session"}}""",
                )
                return if (count == 0) {
                    json("200 OK", """{"data":{"status":"pending"}}""")
                } else {
                    json("200 OK", """{"data":{"status":"claimed","enrollmentToken":"${tokens[id]}"}}""")
                }
            }
            if (method == "POST" && path == "/api/v1/player/enroll") {
                val id = tokens.entries.firstOrNull { body.contains(it.value) }?.key
                    ?: return json("400 Bad Request", """{"error":{"code":"bad_token","message":"wrong token"}}""")
                return json(
                    "200 OK",
                    """{"data":{"screenId":"$screenId","screenName":"Resilient Screen","deviceCredential":"${credentialFor(numbers[id] ?: 1)}"}}""",
                )
            }
            if (method == "GET" && path == "/api/v1/player/config") {
                return json("200 OK", """{"data":${configJson()}}""", "ETag: \"config-7\"\r\n")
            }
            if (method == "GET" && path == "/api/v1/player/manifest") {
                return json("404 Not Found", """{"error":{"code":"not_found","message":"no manifest"}}""")
            }
            if (method == "POST" && path == "/api/v1/player/heartbeat") {
                heartbeats.incrementAndGet()
                return when (heartbeatMode) {
                    "revoked" -> json(
                        "401 Unauthorized",
                        """{"error":{"code":"device_credential_revoked","message":"credential revoked"}}""",
                    )
                    "disabled" -> json(
                        "403 Forbidden",
                        """{"error":{"code":"screen_disabled","message":"screen disabled"}}""",
                    )
                    else -> json("200 OK", """{"data":{}}""")
                }
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

    private suspend fun awaitLink(
        host: PlayerCoreHost,
        state: String,
        reason: String? = null,
        timeoutMs: Long = 60_000,
    ) {
        try {
            withTimeout(timeoutMs) {
                while (true) {
                    host.refreshStatus()
                    val status = (host.state.value as? CoreHostState.Ready)?.status
                    if (status?.linkState == state && (reason == null || status.linkReason == reason)) {
                        return@withTimeout
                    }
                    delay(500)
                }
                error("unreachable")
            }
        } catch (_: kotlinx.coroutines.TimeoutCancellationException) {
            host.refreshStatus()
            val last = (host.state.value as? CoreHostState.Ready)?.status
            throw AssertionError(
                "timed out waiting for link=$state reason=$reason; last=${last?.linkState}/${last?.linkReason}",
            )
        }
    }

    @Test fun linkSurvivesRevocationMismatchAndDisable() = runBlocking {
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
            awaitLink(host, "connected")
            val firstCredential = credentials.read()
            assertNotNull(firstCredential)

            // Revocation stops the link with its reason and drops the
            // dead credential; re-pairing stores a fresh one and
            // restores the link.
            stub.heartbeatMode = "revoked"
            host.stop()
            host.startDrivers()
            awaitLink(host, "stopped", "device_credential_rejected")
            assertEquals(null, credentials.read())
            val repair = host.beginPairing(stub.url)
            assertTrue("re-pair begin failed: $repair", repair.ok)
            stub.heartbeatMode = "ok"
            awaitPaired(host)
            awaitLink(host, "connected")
            assertEquals(2, stub.sessions.get())
            assertNotEquals(firstCredential, credentials.read())

            // A disabled screen keeps the link retrying; re-enabling it
            // reconnects without any re-pairing.
            stub.heartbeatMode = "disabled"
            host.stop()
            host.startDrivers()
            awaitLink(host, "retrying")
            stub.heartbeatMode = "ok"
            host.stop()
            host.startDrivers()
            awaitLink(host, "connected")
            assertEquals(2, stub.sessions.get())

            // A changed installation ID stops the link with a mismatch.
            // The stored credential is never sent: identity is public,
            // everything else stays unsent. This phase runs last because
            // nothing short of fresh setup recovers from it.
            stub.installationId = UUID.randomUUID().toString()
            stub.installationFlipped = true
            host.stop()
            host.startDrivers()
            awaitLink(host, "stopped", "installation_identity_mismatch")
            delay(2000)
            assertEquals(0, stub.authedAfterFlip.get())
            assertEquals(2, stub.sessions.get())
        } finally {
            host.stop()
            stub.stop()
            credentials.clear()
        }
    }
}
