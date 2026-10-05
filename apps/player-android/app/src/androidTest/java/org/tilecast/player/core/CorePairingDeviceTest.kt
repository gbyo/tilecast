package org.tilecast.player.core

import androidx.test.platform.app.InstrumentationRegistry
import java.io.BufferedReader
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
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.tilecast.player.security.KeystoreCredentialStore

/**
 * Drives a complete Core pairing session on-device against a stub Tilecast
 * server: session creation, private polling, one-time enrollment, Keystore
 * credential storage, and reset. The stub speaks the exact wire shapes from
 * `player-client`; anything Core rejects fails the test.
 */
class CorePairingDeviceTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext

    private class StubServer {
        val installationId = UUID.randomUUID().toString()
        val sessionId = UUID.randomUUID().toString()
        val screenId = UUID.randomUUID().toString()
        val pollSecret = "s".repeat(43)
        val enrollmentToken = "e".repeat(43)
        val credential = "tc_device_" + "a".repeat(26) + "." + "b".repeat(43)
        val requests = CopyOnWriteArrayList<Pair<String, String>>()
        val polls = AtomicInteger(0)
        var pairingBodies = CopyOnWriteArrayList<String>()
        private val socket = ServerSocket(0)
        val port: Int = socket.localPort
        val url: String get() = "http://127.0.0.1:$port"
        private val latch = CountDownLatch(1)

        fun start() {
            thread(name = "stub-tilecast-server", isDaemon = true) {
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

        private fun handle(reader: BufferedReader, out: java.io.OutputStream) {
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
            requests += "$method $path" to (authorization ?: "")
            val payload = route(method, path, body, authorization)
            val bytes = payload.second.toByteArray(StandardCharsets.UTF_8)
            val head = "HTTP/1.1 ${payload.first}\r\nContent-Type: application/json\r\nContent-Length: ${bytes.size}\r\nConnection: close\r\n\r\n"
            out.write(head.toByteArray(StandardCharsets.UTF_8))
            out.write(bytes)
            out.flush()
        }

        private fun route(method: String, path: String, body: String, authorization: String?): Pair<String, String> {
            if (method == "GET" && path == "/api/v1/system/identity") {
                return "200 OK" to """{"data":{"product":"tilecast","installationId":"$installationId","organizationName":"Test Org","apiVersion":"1","pairingEnabled":true}}"""
            }
            if (method == "POST" && path == "/api/v1/player/pairing-sessions") {
                pairingBodies += body
                val expires = Instant.now().plusSeconds(600).toString()
                return "200 OK" to """{"data":{"id":"$sessionId","code":"ABC123","pollSecret":"$pollSecret","expiresAt":"$expires","pollingIntervalSeconds":2,"approvalUrl":"$url/approve","organizationName":"Test Org"}}"""
            }
            if (method == "GET" && path == "/api/v1/player/pairing-sessions/$sessionId") {
                if (authorization != "Pairing $pollSecret") {
                    return "401 Unauthorized" to """{"error":{"code":"unauthorized","message":"bad poll secret"}}"""
                }
                return if (polls.getAndIncrement() == 0) {
                    "200 OK" to """{"data":{"status":"pending"}}"""
                } else {
                    "200 OK" to """{"data":{"status":"claimed","enrollmentToken":"$enrollmentToken"}}"""
                }
            }
            if (method == "POST" && path == "/api/v1/player/enroll") {
                if (!body.contains(enrollmentToken)) {
                    return "400 Bad Request" to """{"error":{"code":"bad_token","message":"wrong token"}}"""
                }
                return "200 OK" to """{"data":{"screenId":"$screenId","screenName":"Test Screen","deviceCredential":"$credential"}}"""
            }
            return "404 Not Found" to """{"error":{"code":"not_found","message":"no such stub route"}}"""
        }
    }

    private suspend fun awaitPairing(
        host: PlayerCoreHost,
        stub: StubServer,
        timeoutMs: Long = 30_000,
        want: (CorePairingState) -> Boolean,
    ): CorePairingState = coroutineScope {
        try {
            withTimeout(timeoutMs) {
                while (true) {
                    val state = host.pairingState.value
                    if (want(state)) return@withTimeout state
                    delay(200)
                }
                error("unreachable")
            }
        } catch (_: kotlinx.coroutines.TimeoutCancellationException) {
            throw AssertionError(
                "timed out waiting for pairing state; last=${host.pairingState.value} " +
                    "stubRequests=${stub.requests.map { it.first }}",
            )
        }
    }

    @Test fun corePairingEnrollsAndResetsOnDevice() = runBlocking {
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
            val waiting = awaitPairing(host, stub) { it is CorePairingState.Waiting } as CorePairingState.Waiting
            assertEquals("ABC123", waiting.code)

            // The stub saw well-formed device metadata with the legacy platform tag.
            assertTrue(stub.pairingBodies.isNotEmpty())
            val metadata = stub.pairingBodies.first()
            assertTrue("metadata: $metadata", metadata.contains("\"platform\":\"android-tv\""))
            assertTrue("metadata: $metadata", metadata.contains("\"installationId\":\"${stub.installationId}\""))

            // The driver polls with the private secret, enrolls once, and stores the credential.
            awaitPairing(host, stub) { it is CorePairingState.Paired }
            val stored = credentials.read()
            assertNotNull(stored)
            assertTrue("stored: $stored", stored!!.startsWith("tc_device_"))
            assertTrue(stub.polls.get() >= 2)

            // Reset abandons the pairing attempt and clears the session file, but
            // preserves an enrolled credential by design: unpairing is a
            // separate revocation flow, not a reset side effect.
            assertTrue(host.resetPairing())
            val sessionFile = java.io.File(context.filesDir, "player-core/pairing.json")
            assertTrue("pairing.json survives reset", !sessionFile.exists())
            assertNotNull("reset must preserve the enrolled credential", credentials.read())
        } finally {
            host.stop()
            stub.stop()
            credentials.clear()
        }
    }
}
