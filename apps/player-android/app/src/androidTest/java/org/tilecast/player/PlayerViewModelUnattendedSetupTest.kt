package org.tilecast.player

import android.app.Application
import androidx.lifecycle.viewModelScope
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestCoroutineScheduler
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.tilecast.player.content.PlayerUpdateManager
import org.tilecast.player.core.CoreBeginResult
import org.tilecast.player.core.CoreHostState
import org.tilecast.player.core.CoreHostStatus
import org.tilecast.player.core.CoreIdentity
import org.tilecast.player.core.CoreManifestResult
import org.tilecast.player.core.CorePairingState
import org.tilecast.player.core.CorePlayerConfig
import org.tilecast.player.core.CoreRecoveryResult
import org.tilecast.player.core.DiscoveredServer

@OptIn(ExperimentalCoroutinesApi::class)
class PlayerViewModelUnattendedSetupTest {
    private lateinit var scheduler: TestCoroutineScheduler
    private val models = mutableListOf<PlayerViewModel>()

    @Before
    fun setUp() {
        scheduler = TestCoroutineScheduler()
        Dispatchers.setMain(StandardTestDispatcher(scheduler))
    }

    @After
    fun tearDown() {
        models.forEach { it.viewModelScope.cancel() }
        Dispatchers.resetMain()
    }

    @Test
    fun oneDiscoveredServerBeginsPairingWithItsUrl() {
        val server = DiscoveredServer("Tilecast", "http://192.168.1.50:8080", "installation-1")
        val host = FakePlayerCoreHost(scheduler)

        newViewModel(host, FakeLanDiscovery(server))
        scheduler.runCurrent()

        assertEquals(listOf(server.baseUrl), host.beginPairingUrls)
    }

    @Test
    fun automaticConnectionFailuresRetryWithIncreasingDelays() {
        val server = DiscoveredServer("Tilecast", "http://192.168.1.50:8080", "installation-1")
        val unreachable = CoreIdentity(false, null, null, null, null, false, "unreachable")
        val host = FakePlayerCoreHost(
            scheduler,
            identityResults = mutableListOf(unreachable, unreachable, goodIdentity()),
        )

        newViewModel(host, FakeLanDiscovery(server))
        scheduler.runCurrent()
        assertEquals(1, host.identityCalls.size)

        scheduler.advanceTimeBy(20_000)
        scheduler.runCurrent()

        assertEquals(3, host.identityCalls.size)
        val firstDelay = host.identityCalls[1].first - host.identityCalls[0].first
        val secondDelay = host.identityCalls[2].first - host.identityCalls[1].first
        assertTrue("first retry should use the attempt-2 backoff", firstDelay >= 4_000)
        assertTrue("second retry should use the attempt-3 backoff", secondDelay >= 8_000)
        assertTrue("retry delay should grow", secondDelay > firstDelay)
        assertEquals(listOf(server.baseUrl), host.beginPairingUrls)
    }

    @Test
    fun revokedCredentialResetsPairingBeforeReconnectingToRetainedServer() {
        val serverUrl = "http://192.168.1.50:8080"
        val host = FakePlayerCoreHost(
            scheduler,
            initialStatus = readyStatus(
                linkReason = "device_credential_rejected",
                retainedServerUrl = serverUrl,
            ),
        )

        newViewModel(host, FakeLanDiscovery())
        scheduler.runCurrent()

        assertEquals(
            listOf(
                "resetPairing",
                "fetchIdentity:$serverUrl",
                "beginPairing:$serverUrl",
            ),
            host.events.take(3),
        )
    }

    private fun newViewModel(
        host: FakePlayerCoreHost,
        discovery: LanDiscoverySource,
    ): PlayerViewModel {
        val app = InstrumentationRegistry.getInstrumentation().targetContext.applicationContext as Application
        return PlayerViewModel(app, host, discovery).also(models::add)
    }

    private class FakeLanDiscovery(
        vararg servers: DiscoveredServer,
    ) : LanDiscoverySource {
        private val servers = servers.toList()

        override fun discover(): Flow<DiscoveredServer> = flowOf(*servers.toTypedArray())
    }

    private class FakePlayerCoreHost(
        private val scheduler: TestCoroutineScheduler,
        initialStatus: CoreHostStatus = readyStatus(),
        private val identityResults: MutableList<CoreIdentity> = mutableListOf(goodIdentity()),
    ) : PlayerViewModelHost {
        private val mutableState = MutableStateFlow<CoreHostState>(
            CoreHostState.Ready("test", initialStatus, coreRunning = true),
        )
        private val mutablePairingState = MutableStateFlow<CorePairingState>(CorePairingState.Unknown)

        override val state: StateFlow<CoreHostState> = mutableState
        override val pairingState: StateFlow<CorePairingState> = mutablePairingState
        override val updateManager: PlayerUpdateManager? = null

        val beginPairingUrls = mutableListOf<String>()
        val identityCalls = mutableListOf<Pair<Long, String>>()
        val events = mutableListOf<String>()

        override suspend fun startDrivers() = Unit

        override suspend fun refreshStatus() = Unit

        override suspend fun fetchIdentity(url: String): CoreIdentity {
            identityCalls += scheduler.currentTime to url
            events += "fetchIdentity:$url"
            return if (identityResults.isNotEmpty()) identityResults.removeAt(0) else goodIdentity()
        }

        override suspend fun beginPairing(url: String): CoreBeginResult {
            beginPairingUrls += url
            events += "beginPairing:$url"
            return CoreBeginResult(true, null)
        }

        override suspend fun resetPairing(): Boolean {
            events += "resetPairing"
            mutablePairingState.value = CorePairingState.Unknown
            return true
        }

        override suspend fun resetServer(): Boolean = true

        override suspend fun syncManifest(): CoreManifestResult =
            CoreManifestResult(true, "unchanged", null)

        override suspend fun rendererRecovery(json: String): CoreRecoveryResult =
            error("renderer recovery is not used by unattended setup tests")

        override suspend fun effectiveConfig(): CorePlayerConfig = CorePlayerConfig(null)

        override suspend fun reportObservations(json: String): Int = 0
    }

    private companion object {
        fun goodIdentity() = CoreIdentity(
            ok = true,
            product = "tilecast",
            installationId = "installation-1",
            organizationName = "Tilecast",
            apiVersion = "v1",
            pairingEnabled = true,
        )

        fun readyStatus(
            linkReason: String? = null,
            retainedServerUrl: String? = null,
        ) = CoreHostStatus(
            ok = true,
            bridge = 3,
            stateDb = null,
            casDir = null,
            paired = false,
            code = null,
            linkReason = linkReason,
            retainedServerUrl = retainedServerUrl,
        )
    }
}
