package org.tilecast.player.core

import java.io.File
import java.nio.file.Files
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.tilecast.player.security.CredentialStore

class PlayerCoreHostTest {
    private class FakeBridge(
        var handle: Long = 1L,
        var statusPayload: String? = """{"bridge":2,"ok":true,"stateDb":"/files/player-core/state.db","casDir":"/files/player-core/cas","paired":false}""",
        var versionPayload: String? = "0.1.0",
        var beginPayload: String? = """{"ok":true}""",
        var syncPayload: String? = """{"ok":true,"outcome":"unchanged","revision":7}""",
    ) : CoreBridge {
        var openedWith: String? = null
        var openedAgent: String? = null
        var closed = 0
        var coreStarts = 0
        var resets = 0
        var begins = mutableListOf<String>()
        var syncs = 0
        var openError: Throwable? = null
        override fun version(): String? = versionPayload
        override fun open(filesDir: String, userAgent: String, handler: CoreBridgeHandler): Long {
            openError?.let { throw it }
            openedWith = filesDir
            openedAgent = userAgent
            return handle
        }
        override fun statusJson(handle: Long): String? = statusPayload
        override fun startCore(handle: Long): Int {
            coreStarts++
            return 0
        }
        override fun beginPairing(handle: Long, url: String): String? {
            begins += url
            return beginPayload
        }
        override fun resetPairing(handle: Long): Int {
            resets++
            return 0
        }
        override fun syncConfig(handle: Long): String? {
            syncs++
            return syncPayload
        }
        override fun close(handle: Long): Int {
            closed++
            return 0
        }
    }

    private class FakeCredentials(var value: String? = null) : CredentialStore {
        override fun save(credential: String) {
            value = credential
        }
        override fun read(): String? = value
        override fun clear() {
            value = null
        }
    }

    private fun filesDir(): File = Files.createTempDirectory("tilecast-core-host").toFile()

    private fun facts() = DeviceFacts(
        platform = "android-tv",
        manufacturer = "test",
        model = "test",
        osRelease = "14",
        playerVersion = "0.25.0",
        screenWidth = 1920,
        screenHeight = 1080,
        locale = "en-US",
        timezone = "UTC",
    )

    private fun handlerFactory(dir: File, credentials: FakeCredentials = FakeCredentials()): CoreHandlerFactory =
        CoreHandlerFactory { sink ->
            CoreBridgeHandler(credentials, File(dir, "player-core/pairing.json"), facts(), sink)
        }

    @Test fun startsAndStopsThroughReady() = runTest {
        val bridge = FakeBridge()
        val dir = filesDir()
        val host = PlayerCoreHost.forTesting(dir, bridge, handlerFactory(dir))
        assertEquals(CoreHostState.Idle, host.state.value)
        host.start()
        val ready = host.state.value
        assertTrue(ready is CoreHostState.Ready)
        ready as CoreHostState.Ready
        assertEquals("0.1.0", ready.version)
        assertEquals(2, ready.status.bridge)
        assertTrue(ready.status.ok)
        assertFalse(ready.status.paired)
        assertFalse(ready.coreRunning)
        assertTrue(dir.absolutePath == bridge.openedWith)
        assertEquals("Tilecast-Player-Android/test", bridge.openedAgent)
        host.start()
        assertTrue(host.state.value is CoreHostState.Ready)
        host.stop()
        assertEquals(CoreHostState.Idle, host.state.value)
        assertEquals(1, bridge.closed)
        host.stop()
        assertEquals(CoreHostState.Idle, host.state.value)
    }

    @Test fun coreOnlyModeStartsDriversOnce() = runTest {
        val bridge = FakeBridge()
        val dir = filesDir()
        val host = PlayerCoreHost.forTesting(dir, bridge, handlerFactory(dir))
        host.startCoreOnly()
        val ready = host.state.value as CoreHostState.Ready
        assertTrue(ready.coreRunning)
        assertEquals(1, bridge.coreStarts)
        host.startCoreOnly()
        assertEquals(1, bridge.coreStarts)
        host.stop()
        assertEquals(CoreHostState.Idle, host.state.value)
    }

    @Test fun beginPairingNeedsAReadyHost() = runTest {
        val bridge = FakeBridge()
        val dir = filesDir()
        val host = PlayerCoreHost.forTesting(dir, bridge, handlerFactory(dir))
        assertEquals(CoreBeginResult(false, "host_not_ready"), host.beginPairing("https://signs.example"))
        host.start()
        assertEquals(CoreBeginResult(true, null), host.beginPairing("https://signs.example"))
        assertEquals(listOf("https://signs.example"), bridge.begins)
        host.stop()
    }

    @Test fun resetPairingClearsProjectedState() = runTest {
        val bridge = FakeBridge()
        val dir = filesDir()
        var sink: ((String) -> Unit)? = null
        val factory = CoreHandlerFactory { found ->
            sink = found
            CoreBridgeHandler(FakeCredentials(), File(dir, "pairing.json"), facts(), found)
        }
        val host = PlayerCoreHost.forTesting(dir, bridge, factory)
        host.start()
        sink!!("""{"state":"waiting","code":"ABC123","approvalUrl":"https://signs.example/s"}""")
        val waiting = host.pairingState.value as CorePairingState.Waiting
        assertEquals("ABC123", waiting.code)
        assertTrue(host.resetPairing())
        assertEquals(1, bridge.resets)
        assertEquals(CorePairingState.Unknown, host.pairingState.value)
        host.stop()
    }

    @Test fun failedTlsInitFailsTheStart() = runTest {
        val dir = filesDir()
        val host = PlayerCoreHost.forTesting(dir, FakeBridge(), handlerFactory(dir), tlsInit = { PlayerCoreHost.TLS_FAILED })
        host.start()
        assertEquals(CoreHostState.Failed("tls_init_failed"), host.state.value)
    }

    @Test fun failedOpenFailsTheStart() = runTest {
        val dir = filesDir()
        val host = PlayerCoreHost.forTesting(dir, FakeBridge(handle = 0L), handlerFactory(dir))
        host.start()
        assertEquals(CoreHostState.Failed("open_failed"), host.state.value)
    }

    @Test fun linkageErrorDuringTlsInitFailsTheStart() = runTest {
        val dir = filesDir()
        val host = PlayerCoreHost.forTesting(
            dir,
            FakeBridge(),
            handlerFactory(dir),
            tlsInit = { throw UnsatisfiedLinkError("missing native library") },
        )
        host.start()
        assertEquals(CoreHostState.Failed("tls_init_failed"), host.state.value)
    }

    @Test fun linkageErrorDuringOpenFailsTheStart() = runTest {
        val dir = filesDir()
        val bridge = FakeBridge().apply { openError = UnsatisfiedLinkError("missing native library") }
        val host = PlayerCoreHost.forTesting(dir, bridge, handlerFactory(dir))
        host.start()
        assertEquals(CoreHostState.Failed("open_failed"), host.state.value)
    }

    @Test fun failedStatusClosesAndReportsTheNativeCode() = runTest {
        val bridge = FakeBridge(statusPayload = """{"bridge":2,"ok":false,"code":"bad_handle"}""")
        val dir = filesDir()
        val host = PlayerCoreHost.forTesting(dir, bridge, handlerFactory(dir))
        host.start()
        assertEquals(CoreHostState.Failed("bad_handle"), host.state.value)
        assertEquals(1, bridge.closed)
    }

    @Test fun statusParsingIsLenient() {
        assertEquals("null_status", CoreHostStatus.parse(null).code)
        assertEquals("status_unparseable", CoreHostStatus.parse("not json").code)
        assertEquals("status_unparseable", CoreHostStatus.parse("[1,2]").code)
        val ok = CoreHostStatus.parse("""{"bridge":2,"ok":true,"stateDb":"a","casDir":"b","paired":true}""")
        assertTrue(ok.ok)
        assertTrue(ok.paired)
        val sparse = CoreHostStatus.parse("""{"ok":false}""")
        assertTrue(!sparse.ok)
        assertFalse(sparse.paired)
    }

    @Test fun syncConfigNeedsAReadyHostAndRefreshesStatus() = runTest {
        val bridge = FakeBridge()
        val dir = filesDir()
        val host = PlayerCoreHost.forTesting(dir, bridge, handlerFactory(dir))
        assertEquals(CoreSyncResult(false, null, null, code = "host_not_ready"), host.syncConfig())
        assertEquals(0, bridge.syncs)
        host.start()
        assertEquals(CoreSyncResult(true, "unchanged", 7L), host.syncConfig())
        assertEquals(1, bridge.syncs)
        host.stop()
    }

    @Test fun syncParsingIsLenient() {
        assertEquals(CoreSyncResult(false, null, null, code = "null_result"), CoreSyncResult.parse(null))
        assertEquals(CoreSyncResult(false, null, null, code = "result_unparseable"), CoreSyncResult.parse("nope"))
        assertEquals(
            CoreSyncResult(true, "accepted", 9L),
            CoreSyncResult.parse("""{"ok":true,"outcome":"accepted","revision":9}"""),
        )
        assertEquals(
            CoreSyncResult(true, "refused", 9L, reason = "config_revision_stale"),
            CoreSyncResult.parse("""{"ok":true,"outcome":"refused","reason":"config_revision_stale","revision":9}"""),
        )
        assertEquals(
            CoreSyncResult(false, null, null, code = "not_paired"),
            CoreSyncResult.parse("""{"ok":false,"code":"not_paired"}"""),
        )
        val status = CoreHostStatus.parse("""{"bridge":2,"ok":true,"paired":true,"configRevision":9}""")
        assertEquals(9L, status.configRevision)
        assertEquals(null, CoreHostStatus.parse("""{"bridge":2,"ok":true}""").configRevision)
    }

    @Test fun pairingParsingIsLenient() {
        assertEquals(CorePairingState.Unknown, CorePairingState.parse(null))
        assertEquals(CorePairingState.Unknown, CorePairingState.parse("nope"))
        assertEquals(CorePairingState.Paired, CorePairingState.parse("""{"state":"paired"}"""))
        assertEquals(CorePairingState.Setup, CorePairingState.parse("""{"state":"setup"}"""))
        assertEquals(
            CorePairingState.Waiting("C", "U", null),
            CorePairingState.parse("""{"state":"waiting","code":"C","approvalUrl":"U"}"""),
        )
        assertEquals(CorePairingState.Unknown, CorePairingState.parse("""{"state":"waiting"}"""))
    }

    @Test fun handlerRoundTripsStores() {
        val dir = filesDir()
        val credentials = FakeCredentials()
        val seen = mutableListOf<String>()
        val handler = CoreBridgeHandler(credentials, File(dir, "pairing.json"), facts(), seen::add)
        assertEquals(null, handler.credentialLoad())
        assertEquals(0, handler.credentialSave("secret"))
        assertEquals("secret", handler.credentialLoad())
        assertEquals(0, handler.credentialRemove())
        assertEquals(null, handler.credentialLoad())
        assertEquals(null, handler.pairingSessionLoad())
        assertEquals(0, handler.pairingSessionSave("""{"a":1}"""))
        assertEquals("""{"a":1}""", handler.pairingSessionLoad())
        assertEquals(0, handler.pairingSessionRemove())
        assertEquals(null, handler.pairingSessionLoad())
        val metadata = handler.deviceMetadata()
        assertTrue(metadata.contains("\"platform\":\"android-tv\""))
        assertTrue(metadata.contains("\"screenWidth\":1920"))
        handler.onPairingStatus("""{"state":"paired"}""")
        assertEquals(listOf("""{"state":"paired"}"""), seen)
    }
}
