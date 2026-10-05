package org.tilecast.player.core

import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.tilecast.player.data.CachedAsset
import org.tilecast.player.data.PlayerConfiguration
import org.tilecast.player.data.PlayerDatabase
import org.tilecast.player.data.StoredManifest
import org.tilecast.player.data.StoredPlayerConfig
import org.tilecast.player.security.KeystoreCredentialStore

/**
 * Qualifies the legacy Room/cache importer on-device with a real Room
 * database: seed an enrolled v5 database plus a verified cache file
 * through the production DAOs, then prove the import carries identity,
 * binding, configuration, manifest, and media into Core state, and
 * that the selection driver trial-activates the imported presentation
 * offline with no server ever started.
 */
class LegacyImportDeviceTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext

    private val installationId = UUID.randomUUID().toString()
    private val screenId = UUID.randomUUID().toString()
    private val playerId = UUID.randomUUID().toString()
    private val assetId = UUID.randomUUID().toString()
    private val variantId = UUID.randomUUID().toString()
    private val itemId = UUID.randomUUID().toString()
    private val playlistId = UUID.randomUUID().toString()
    private val serverUrl = "http://127.0.0.1:9"
    private val payload = "tilecast-legacy-import-bytes:".toByteArray(StandardCharsets.UTF_8) +
        ByteArray(100 - "tilecast-legacy-import-bytes:".length) { 0x5A }
    private val digest = MessageDigest.getInstance("SHA-256").digest(payload)
        .joinToString("") { "%02x".format(it) }

    private fun manifestJson() = """
        {"schemaVersion":11,"manifestVersion":12,"screenId":"$screenId","mode":"presentation",
        "assets":[{"assetId":"$assetId","variantId":"$variantId","sha256":"$digest",
        "fileSize":${payload.size},"mimeType":"image/png",
        "downloadPath":"/api/v1/player/assets/$assetId/variants/$variantId"}],
        "playlist":{"id":"$playlistId","items":[{"id":"$itemId","assetId":"$assetId",
        "variantId":"$variantId","assetType":"image","deliveryPolicy":"automatic",
        "durationMs":10000,"fitMode":"cover","transition":"fade",
        "audioEnabled":true,"volume":0.8}]},
        "playlists":[],"schedules":[],"websites":[],"widgets":[],"dataSources":[],
        "plugins":[],"layouts":[]}
    """.trimIndent().replace("\n", "")

    private class RecordingAdapter : CoreRendererAdapter {
        val requests = CopyOnWriteArrayList<JSONObject>()
        override fun handle(envelope: String): Int {
            runCatching { requests += JSONObject(envelope) }
            return CoreRendererRequestCode.QUEUED
        }
    }

    private suspend fun awaitActivate(
        requests: CopyOnWriteArrayList<JSONObject>,
        timeoutMs: Long = 60_000,
    ): JSONObject = try {
        withTimeout(timeoutMs) {
            while (true) {
                val found = requests.firstOrNull { it.optString("op") == "activate" }
                if (found != null) return@withTimeout found
                delay(200)
            }
            error("unreachable")
        }
    } catch (_: kotlinx.coroutines.TimeoutCancellationException) {
        val summary = requests.joinToString("; ") { it.toString().take(2000) }
        throw AssertionError("timed out waiting for a pushed activate; got ${requests.size} requests: $summary")
    }

    private suspend fun awaitRendererStatus(
        host: PlayerCoreHost,
        timeoutMs: Long = 60_000,
        match: (CoreRendererStatus) -> Boolean,
    ): CoreRendererStatus = try {
        withTimeout(timeoutMs) {
            while (true) {
                host.refreshStatus()
                val renderer = (host.state.value as? CoreHostState.Ready)?.status?.renderer
                if (renderer != null && runCatching { match(renderer) }.getOrDefault(false)) {
                    return@withTimeout renderer
                }
                delay(500)
            }
            error("unreachable")
        }
    } catch (_: kotlinx.coroutines.TimeoutCancellationException) {
        host.refreshStatus()
        val last = (host.state.value as? CoreHostState.Ready)?.status?.renderer
        throw AssertionError("timed out waiting for renderer status; last=$last")
    }

    @Test fun legacyRoomAndCacheImportThenPlayOffline() = runBlocking {
        CoreTestFixtures.resetCoreFiles(context)
        val database = PlayerDatabase.get(context)
        database.configuration().reset()
        database.manifests().clear()
        database.cachedAssets().clear()
        database.playerConfigs().clear()
        File(context.filesDir, "media-cache").deleteRecursively()

        // The legacy cache file, exactly as the old player left it.
        val cacheDir = File(context.filesDir, "media-cache")
        cacheDir.mkdirs()
        val mediaFile = File(cacheDir, "$variantId.png")
        mediaFile.writeBytes(payload)

        // The enrolled v5 Room database, written through the real DAOs.
        database.configuration().save(
            PlayerConfiguration(
                playerInstallationId = playerId,
                serverUrl = serverUrl,
                serverInstallationId = installationId,
                organizationName = "Import Org",
                screenId = screenId,
                screenName = "Import Screen",
            ),
        )
        database.manifests().save(
            StoredManifest(
                manifestVersion = 12,
                schemaVersion = 11,
                rawJson = manifestJson(),
                etag = "etag-12",
                state = "active",
                receivedAt = 1,
                readyAt = 2,
                activatedAt = 3,
                installationId = installationId,
                screenId = screenId,
                normalizedServerUrl = serverUrl,
            ),
        )
        database.cachedAssets().save(
            CachedAsset(
                variantId = variantId,
                assetId = assetId,
                sha256 = digest,
                expectedFileSize = payload.size.toLong(),
                localPath = mediaFile.absolutePath,
                downloadStatus = "ready",
                downloadedBytes = payload.size.toLong(),
                requiredByActiveManifest = true,
                installationId = installationId,
                screenId = screenId,
                normalizedServerUrl = serverUrl,
            ),
        )
        database.playerConfigs().save(
            StoredPlayerConfig(
                configRevision = 7,
                schemaVersion = 1,
                rawJson = """{"schemaVersion":1,"configRevision":7,"generatedAt":"2026-09-24T00:00:00Z"}""",
                etag = "etag-7",
                state = "active",
                receivedAt = 1,
                activatedAt = 2,
                installationId = installationId,
                screenId = screenId,
                normalizedServerUrl = serverUrl,
            ),
        )
        // A real upgrade keeps its Keystore credential; the import marks
        // the binding stored only when one is present.
        val credentials = KeystoreCredentialStore(context)
        credentials.clear()
        credentials.save("tc_device_" + "c".repeat(26) + "." + "d".repeat(43))

        val host = PlayerCoreHost.get(context)
        val adapter = RecordingAdapter()
        try {
            host.start()
            assertTrue(host.state.value is CoreHostState.Ready)

            val result = host.importLegacy()
            assertTrue("import failed: $result", result.ok)
            assertEquals("complete", result.status)
            assertEquals(5L, result.roomVersion)
            assertEquals(true, result.identityImported)
            assertEquals(true, result.bindingImported)
            assertEquals(7L, result.configRevision)
            assertEquals(12L, result.manifestVersion)
            assertEquals(1, result.mediaImported)
            assertEquals(0, result.mediaSkipped)

            // The marker and the verified object are on disk.
            val marker = File(context.filesDir, "player-core/legacy-import.json")
            assertTrue(marker.isFile)
            assertTrue(marker.readText().contains("\"complete\""))
            val casObject = File(context.filesDir, "player-core/cas/sha256/${digest.take(2)}/$digest")
            assertTrue(casObject.isFile)
            assertEquals(payload.size.toLong(), casObject.length())

            // A second import replays the marker instead of redoing work.
            val replay = host.importLegacy()
            assertTrue("replay failed: $replay", replay.ok)
            assertTrue(replay.notes.any { it.contains("already imported") })

            // The imported configuration is installed and live.
            host.refreshStatus()
            val status = (host.state.value as? CoreHostState.Ready)?.status
            assertEquals(7L, status?.configRevision)

            // No server is ever started: the selection driver picks up
            // the imported pending manifest and trial-activates it.
            host.startCoreOnly()
            assertTrue(host.state.value is CoreHostState.Ready)
            host.setRendererAdapterForTesting(adapter)
            assertEquals(
                CoreReportCode.APPLIED,
                host.rendererReport("""{"type":"connected","generation":1}"""),
            )
            assertEquals(
                CoreReportCode.APPLIED,
                host.rendererReport(
                    """{"type":"ready","generation":1,"report":{"features":["status-surfaces-v1","image"],""" +
                        """"support":{"presentationSchemas":[1,2]}}}""",
                ),
            )
            val pushed = awaitActivate(adapter.requests)
            val items = pushed.getJSONObject("presentation").getJSONArray("items")
            assertEquals(1, items.length())
            assertEquals(itemId, items.getJSONObject(0).getString("id"))
            assertEquals(
                "tcmedia://variant/$assetId/$variantId",
                items.getJSONObject(0).getString("src"),
            )
            val activationId = pushed.getString("activationId")
            val activationGeneration = pushed.getLong("generation")
            assertEquals(
                CoreReportCode.APPLIED,
                host.rendererReport(
                    """{"type":"accepted","generation":1,"activationId":"$activationId",""" +
                        """"activationGeneration":$activationGeneration}""",
                ),
            )
            assertEquals(
                CoreReportCode.APPLIED,
                host.rendererReport(
                    """{"type":"progress","generation":1,"activationId":"$activationId",""" +
                        """"activationGeneration":$activationGeneration,"kind":"image-shown",""" +
                        """"itemId":"$itemId"}""",
                ),
            )
            val evidenced = awaitRendererStatus(host) { it.accepted && it.evidence }
            assertTrue(evidenced.playing)
        } finally {
            host.stop()
            credentials.clear()
            database.configuration().reset()
            database.manifests().clear()
            database.cachedAssets().clear()
            database.playerConfigs().clear()
            File(context.filesDir, "media-cache").deleteRecursively()
        }
    }
}
