package org.tilecast.player.core

import android.content.Context
import java.io.File
import org.tilecast.player.security.KeystoreCredentialStore

/** Hermetic Core state for device tests: Core persists across host restarts by design. */
internal object CoreTestFixtures {
    fun resetCoreFiles(context: Context) {
        File(context.filesDir, "player-core").deleteRecursively()
        runCatching {
            KeystoreCredentialStore(
                context,
                KeystoreCredentialStore.CORE_PREFS_NAME,
                KeystoreCredentialStore.CORE_KEY_ALIAS,
            ).clear()
        }
    }
}
