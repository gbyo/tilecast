package org.tilecast.player.core

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertTrue
import org.tilecast.player.security.KeystoreCredentialStore
import org.junit.Test
import org.junit.runner.RunWith

/**
 * A corrupt Core state database must fail the open loudly (no crash,
 * no silent empty state), and deleting it must let the host rebuild
 * from scratch.
 */
@RunWith(AndroidJUnit4::class)
class StateIntegrityDeviceTest {
    @Test
    fun corruptStateFailsOpenAndDeleteRebuilds(): Unit = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val filesDir = File(context.filesDir, "core-state-integrity-${System.nanoTime()}").apply { mkdirs() }
        val host = PlayerCoreHost.forTesting(filesDir, JniCoreBridge(), { sink ->
            CoreBridgeHandler(
                KeystoreCredentialStore(
                    context.applicationContext,
                    KeystoreCredentialStore.CORE_PREFS_NAME,
                    KeystoreCredentialStore.CORE_KEY_ALIAS,
                ),
                File(filesDir, "player-core/pairing.json"),
                DeviceFacts.collect(context.applicationContext),
                sink,
            )
        })
        try {
            host.start()
            assertTrue("first open: ${host.state.value}", host.state.value is CoreHostState.Ready)
            host.stop()

            val stateDb = File(filesDir, "player-core/state.db")
            assertTrue(stateDb.isFile)
            stateDb.writeBytes("not a sqlite database".toByteArray())

            host.start()
            val failed = host.state.value
            assertTrue("corrupt open: $failed", failed is CoreHostState.Failed)
            host.stop()

            assertTrue(stateDb.delete())
            host.start()
            assertTrue("rebuilt open: ${host.state.value}", host.state.value is CoreHostState.Ready)
        } finally {
            runCatching { host.stop() }
            filesDir.deleteRecursively()
        }
    }
}
