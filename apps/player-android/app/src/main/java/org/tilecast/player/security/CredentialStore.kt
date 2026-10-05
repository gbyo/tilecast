package org.tilecast.player.security

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

interface CredentialStore {
    fun save(credential: String)
    fun read(): String?
    fun clear()
}

class KeystoreCredentialStore(
    context: Context,
    prefsName: String = LEGACY_PREFS_NAME,
    private val alias: String = LEGACY_KEY_ALIAS,
) : CredentialStore {
    companion object {
        /** Legacy slot. Unchanged so enrolled players keep working. */
        const val LEGACY_PREFS_NAME = "tilecast_secure_device"
        const val LEGACY_KEY_ALIAS = "tilecast_device_credential_key"

        /** Player Core slot. Separate so Core never disturbs legacy state. */
        const val CORE_PREFS_NAME = "tilecast_core_secure_device"
        const val CORE_KEY_ALIAS = "tilecast_core_device_credential_key"
    }

    private val preferences = context.getSharedPreferences(prefsName, Context.MODE_PRIVATE)

    override fun save(credential: String) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        preferences.edit()
            .putString("value", Base64.encodeToString(cipher.doFinal(credential.toByteArray(Charsets.UTF_8)), Base64.NO_WRAP))
            .putString("iv", Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
            .commit()
    }

    override fun read(): String? = runCatching {
        val encrypted = preferences.getString("value", null) ?: return null
        val iv = preferences.getString("iv", null) ?: return null
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)))
        String(cipher.doFinal(Base64.decode(encrypted, Base64.NO_WRAP)), Charsets.UTF_8)
    }.getOrNull()

    override fun clear() { preferences.edit().clear().apply() }

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .build())
        }.generateKey()
    }
}

/**
 * Production Core credential storage. Reads and writes the Core slot,
 * copying the legacy slot forward once on first read so enrolled players
 * keep their credential across the cutover. Never writes the legacy slot.
 */
class MigratingCredentialStore(
    private val core: CredentialStore,
    private val legacy: CredentialStore,
) : CredentialStore {
    companion object {
        /** Production Core storage: the Core slot with legacy copy-forward. */
        fun forProduction(context: Context): CredentialStore = MigratingCredentialStore(
            KeystoreCredentialStore(
                context,
                KeystoreCredentialStore.CORE_PREFS_NAME,
                KeystoreCredentialStore.CORE_KEY_ALIAS,
            ),
            KeystoreCredentialStore(context),
        )
    }

    override fun save(credential: String) = core.save(credential)

    override fun read(): String? = core.read() ?: legacy.read()?.also { core.save(it) }

    override fun clear() = core.clear()
}
