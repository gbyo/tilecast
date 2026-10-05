package org.tilecast.player.core

import androidx.test.platform.app.InstrumentationRegistry
import java.io.BufferedReader
import java.io.File
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
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.tilecast.player.security.KeystoreCredentialStore

/**
 * Qualifies Core configuration sync on-device: enroll against a stub
 * server, accept a configuration revision, prove the conditional second
 * sync is a no-op, prove a restart applies the accepted document without
 * network access, and prove sync before pairing fails closed.
 */
class ConfigSyncDeviceTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext

    private class StubServer {
        val installationId = UUID.randomUUID().toString()
        val sessionId = UUID.randomUUID().toString()
        val screenId = UUID.randomUUID().toString()
        val pollSecret = "s".repeat(43)
        val enrollmentToken = "e".repeat(43)
        val credential = "tc_device_" + "c".repeat(26) + "." + "d".repeat(43)
        val configValidators = CopyOnWriteArrayList<String?>()
        val polls = AtomicInteger(0)
        private val socket = ServerSocket(0)
        val port: Int = socket.localPort
        val url: String get() = "http://127.0.0.1:$port"
        private val latch = CountDownLatch(1)

        fun start() {
            thread(name = "stub-config-server", isDaemon = true) {
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
            val body = String(bodyChars, 0, read)
            val (status, payload, headers) = route(method, path, body, authorization, ifNoneMatch)
            val bytes = payload.toByteArray(StandardCharsets.UTF_8)
            val head = "HTTP/1.1 $status\r\nContent-Type: application/json\r\n$headers" +
                "Content-Length: ${bytes.size}\r\nConnection: close\r\n\r\n"
            out.write(head.toByteArray(StandardCharsets.UTF_8))
            out.write(bytes)
            out.flush()
        }

        private fun route(
            method: String,
            path: String,
            body: String,
            authorization: String?,
            ifNoneMatch: String?,
        ): Triple<String, String, String> {
            if (method == "GET" && path == "/api/v1/system/identity") {
                return Triple(
                    "200 OK",
                    """{"data":{"product":"tilecast","installationId":"$installationId","organizationName":"Test Org","apiVersion":"1","pairingEnabled":true}}""",
                    "",
                )
            }
            if (method == "POST" && path == "/api/v1/player/pairing-sessions") {
                val expires = Instant.now().plusSeconds(600).toString()
                return Triple(
                    "200 OK",
                    """{"data":{"id":"$sessionId","code":"CFG777","pollSecret":"$pollSecret","expiresAt":"$expires","pollingIntervalSeconds":1,"approvalUrl":"$url/approve","organizationName":"Test Org"}}""",
                    "",
                )
            }
            if (method == "GET" && path == "/api/v1/player/pairing-sessions/$sessionId") {
                if (authorization != "Pairing $pollSecret") {
                    return Triple("401 Unauthorized", """{"error":{"code":"unauthorized","message":"bad poll secret"}}""", "")
                }
                return if (polls.getAndIncrement() == 0) {
                    Triple("200 OK", """{"data":{"status":"pending"}}""", "")
                } else {
                    Triple("200 OK", """{"data":{"status":"claimed","enrollmentToken":"$enrollmentToken"}}""", "")
                }
            }
            if (method == "POST" && path == "/api/v1/player/enroll") {
                if (!body.contains(enrollmentToken)) {
                    return Triple("400 Bad Request", """{"error":{"code":"bad_token","message":"wrong token"}}""", "")
                }
                return Triple(
                    "200 OK",
                    """{"data":{"screenId":"$screenId","screenName":"Config Screen","deviceCredential":"$credential"}}""",
                    "",
                )
            }
            if (method == "GET" && path == "/api/v1/player/config") {
                configValidators += ifNoneMatch
                if (ifNoneMatch == "\"config-7\"") {
                    return Triple("304 Not Modified", "", "")
                }
                return Triple(
                    "200 OK",
                    """{"data":{"schemaVersion":1,"configRevision":7,"generatedAt":"2026-10-05T00:00:00Z","branding":{"backgroundColor":"#112233","footerText":"Hello"},"playback":{"defaultVolume":0.7},"cache":{"maximumBytes":1073741824,"concurrentDownloads":3},"sync":{"statusReportSeconds":30},"reliability":{"mode":"managed_kiosk","playbackStallSeconds":20},"power":{"keepScreenOn":false,"outsideActiveHoursDisplay":"custom_text","outsideActiveHoursText":"Closed"},"managedKiosk":{"lockTaskEnabled":true,"adminSessionMinutes":20},"accessibility":{"returnDelaySeconds":15,"allowedPackages":["com.example.kiosk"]},"updates":{"channel":"beta"},"website":{"clearOnRestart":true,"defaultReloadPolicy":"interval"}}}""",
                    "ETag: \"config-7\"\r\n",
                )
            }
            return Triple("404 Not Found", """{"error":{"code":"not_found","message":"no such stub route"}}""", "")
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

    @Test fun configSyncAcceptsRevisitsAndSurvivesRestart() = runBlocking {
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

            // Sync before pairing fails closed with a stable code.
            val early = host.syncConfig()
            assertTrue("early sync: $early", !early.ok && early.code == "not_paired")

            val begin = host.beginPairing(stub.url)
            assertTrue("begin failed: $begin", begin.ok)
            awaitPaired(host)

            // First sync accepts revision 7 and installs the projection.
            val first = host.syncConfig()
            assertTrue("first sync: $first", first.ok && first.outcome == "accepted" && first.revision == 7L)
            val ready = host.state.value as CoreHostState.Ready
            assertEquals(7L, ready.status.configRevision)
            val installed = JSONObject(File(context.filesDir, "player-core/installed-config.json").readText())
            assertEquals(7, installed.getLong("configRevision"))
            assertEquals("beta", installed.getJSONObject("platform").getJSONObject("updates").getString("channel"))
            assertTrue(installed.getJSONObject("platform").getJSONObject("managedKiosk").getBoolean("lockTaskEnabled"))
            assertEquals(
                15,
                installed.getJSONObject("platform").getJSONObject("accessibility").getLong("returnDelaySeconds"),
            )
            assertEquals(
                "interval",
                installed.getJSONObject("runtime").getJSONObject("website").getString("defaultReloadPolicy"),
            )
            assertEquals(
                "custom_text",
                installed.getJSONObject("runtime").getJSONObject("power").getString("outsideDisplay"),
            )

            // Second sync sends the validator and changes nothing.
            val second = host.syncConfig()
            assertTrue("second sync: $second", second.ok && second.outcome == "unchanged" && second.revision == 7L)
            assertEquals(listOf(null, "\"config-7\""), stub.configValidators.toList())

            // A restart applies the accepted document with no server access.
            host.stop()
            stub.stop()
            host.startCoreOnly()
            val restarted = host.state.value as CoreHostState.Ready
            assertEquals(7L, restarted.status.configRevision)
        } finally {
            host.stop()
            stub.stop()
            credentials.clear()
        }
    }
}
