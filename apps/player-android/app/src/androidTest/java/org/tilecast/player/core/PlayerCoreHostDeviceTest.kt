package org.tilecast.player.core

import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Proves the native Player Core host loads, initializes platform TLS trust,
 * opens Core state, starts its drivers, and answers pairing commands on a
 * real device. Production does not start the host yet; this test drives the
 * Core-only mode directly.
 */
class PlayerCoreHostDeviceTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext

    @Test fun nativeHostStartsAndStopsOnDevice() = runBlocking {
        CoreTestFixtures.resetCoreFiles(context)
        val host = PlayerCoreHost.get(context)
        try {
            host.startCoreOnly()
            val state = host.state.value
            assertTrue("expected Ready, was $state", state is CoreHostState.Ready)
            state as CoreHostState.Ready
            assertTrue(state.version.isNotEmpty())
            assertTrue(state.status.ok)
            assertEquals(2, state.status.bridge)
            assertTrue(state.coreRunning)
            assertFalse(state.status.paired)
            assertTrue(
                "stateDb ${state.status.stateDb}",
                state.status.stateDb?.endsWith("player-core/state.db") == true,
            )
            assertTrue(
                "casDir ${state.status.casDir}",
                state.status.casDir?.endsWith("player-core/cas") == true,
            )
            // The drivers report through the handler without a server: the
            // first pass finds no binding and projects setup.
            val pairing = host.pairingState.value
            assertTrue(
                "expected Setup (or Unknown if the first pass is still in flight), was $pairing",
                pairing is CorePairingState.Setup || pairing is CorePairingState.Unknown,
            )
            // Pairing commands cross the bridge and fail closed without a server.
            val begin = host.beginPairing("http://127.0.0.1:9")
            assertFalse("begin against a dead server must fail, was $begin", begin.ok)
            assertTrue(host.resetPairing())
        } finally {
            host.stop()
        }
        assertEquals(CoreHostState.Idle, host.state.value)
        assertEquals(CorePairingState.Unknown, host.pairingState.value)
    }
}
