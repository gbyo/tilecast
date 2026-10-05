package org.tilecast.player.security

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class MigratingCredentialStoreTest {
    private class FakeStore(var value: String? = null) : CredentialStore {
        var saves = 0
        var clears = 0

        override fun save(credential: String) {
            saves++
            value = credential
        }

        override fun read(): String? = value

        override fun clear() {
            clears++
            value = null
        }
    }

    @Test fun coreValueWinsWithoutTouchingLegacy() {
        val core = FakeStore("core-secret")
        val legacy = FakeStore("legacy-secret")
        val store = MigratingCredentialStore(core, legacy)
        assertEquals("core-secret", store.read())
        assertEquals(0, core.saves)
        assertEquals("legacy-secret", legacy.value)
    }

    @Test fun legacyValueCopiesForwardOnce() {
        val core = FakeStore()
        val legacy = FakeStore("legacy-secret")
        val store = MigratingCredentialStore(core, legacy)
        assertEquals("legacy-secret", store.read())
        assertEquals("legacy-secret", core.value)
        assertEquals(1, core.saves)
        assertEquals("legacy-secret", store.read())
        assertEquals(1, core.saves)
    }

    @Test fun emptyStoresReadNull() {
        assertNull(MigratingCredentialStore(FakeStore(), FakeStore()).read())
    }

    @Test fun saveAndClearAffectCoreOnly() {
        val core = FakeStore()
        val legacy = FakeStore("legacy-secret")
        val store = MigratingCredentialStore(core, legacy)
        store.save("core-secret")
        assertEquals("core-secret", core.value)
        assertEquals("legacy-secret", legacy.value)
        store.clear()
        assertNull(core.value)
        assertEquals("legacy-secret", legacy.value)
        assertEquals(0, legacy.clears)
    }
}
