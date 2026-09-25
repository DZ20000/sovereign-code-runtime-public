package com.sovereign.runtime.android.gateway

import android.annotation.SuppressLint
import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

private const val KEYSTORE_PROVIDER = "AndroidKeyStore"
private const val KEY_ALIAS = "sovereign.android.gateway.bearer.v1"
private const val PREFERENCES_NAME = "sovereign_android_gateway_credentials_v1"
private const val PREFERENCE_VERSION = "version"
private const val PREFERENCE_IV = "iv"
private const val PREFERENCE_CIPHERTEXT = "ciphertext"
private const val STORAGE_VERSION = 1
private const val GCM_TAG_BITS = 128
private const val MAX_ENCODED_VALUE_CHARACTERS = 4_096

internal data class GatewayBearerCredential(
    val token: String,
    val newlyCreated: Boolean,
    val recoveredFromInvalidStorage: Boolean,
)

internal class GatewayCredentialStore(
    context: Context,
) {
    private val preferences = context.getSharedPreferences(
        PREFERENCES_NAME,
        Context.MODE_PRIVATE,
    )
    private val lock = Any()

    fun getOrCreate(): GatewayBearerCredential = synchronized(lock) {
        val stored = loadStored()
        if (stored != null) {
            return@synchronized GatewayBearerCredential(
                token = stored,
                newlyCreated = false,
                recoveredFromInvalidStorage = false,
            )
        }
        val hadStoredMaterial = preferences.contains(PREFERENCE_IV) ||
            preferences.contains(PREFERENCE_CIPHERTEXT) ||
            preferences.contains(PREFERENCE_VERSION)
        if (hadStoredMaterial) {
            clearStoredMaterial(deleteKey = true)
        }
        createAndStore(
            recoveredFromInvalidStorage = hadStoredMaterial,
        )
    }

    fun rotate(): GatewayBearerCredential = synchronized(lock) {
        clearStoredMaterial(deleteKey = true)
        createAndStore(recoveredFromInvalidStorage = false)
    }

    private fun loadStored(): String? {
        if (preferences.getInt(PREFERENCE_VERSION, -1) != STORAGE_VERSION) return null
        val ivText = preferences.getString(PREFERENCE_IV, null) ?: return null
        val ciphertextText = preferences.getString(PREFERENCE_CIPHERTEXT, null) ?: return null
        if (
            ivText.length !in 1..MAX_ENCODED_VALUE_CHARACTERS ||
            ciphertextText.length !in 1..MAX_ENCODED_VALUE_CHARACTERS
        ) {
            return null
        }
        return runCatching {
            val iv = Base64.decode(ivText, Base64.NO_WRAP)
            val ciphertext = Base64.decode(ciphertextText, Base64.NO_WRAP)
            require(iv.size in 12..32) { "Stored gateway credential IV has an invalid size." }
            require(ciphertext.size in 32..256) {
                "Stored gateway credential ciphertext has an invalid size."
            }
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(
                Cipher.DECRYPT_MODE,
                requireKey(),
                GCMParameterSpec(GCM_TAG_BITS, iv),
            )
            val token = cipher.doFinal(ciphertext).toString(Charsets.UTF_8)
            require(isValidGatewayBearerToken(token)) {
                "Stored gateway bearer token has an invalid shape."
            }
            token
        }.getOrNull()
    }

    private fun createAndStore(
        recoveredFromInvalidStorage: Boolean,
    ): GatewayBearerCredential {
        val token = generateGatewayBearerToken()
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, requireKey())
        val ciphertext = cipher.doFinal(token.toByteArray(Charsets.UTF_8))
        val ivText = Base64.encodeToString(cipher.iv, Base64.NO_WRAP)
        val ciphertextText = Base64.encodeToString(ciphertext, Base64.NO_WRAP)
        check(ivText.length <= MAX_ENCODED_VALUE_CHARACTERS)
        check(ciphertextText.length <= MAX_ENCODED_VALUE_CHARACTERS)
        val committed = preferences.edit()
            .clear()
            .putInt(PREFERENCE_VERSION, STORAGE_VERSION)
            .putString(PREFERENCE_IV, ivText)
            .putString(PREFERENCE_CIPHERTEXT, ciphertextText)
            .commit()
        check(committed) { "Could not persist the encrypted gateway bearer credential." }
        return GatewayBearerCredential(
            token = token,
            newlyCreated = true,
            recoveredFromInvalidStorage = recoveredFromInvalidStorage,
        )
    }

    private fun requireKey(): SecretKey {
        val keyStore = KeyStore.getInstance(KEYSTORE_PROVIDER).apply { load(null) }
        val existing = keyStore.getKey(KEY_ALIAS, null)
        if (existing is SecretKey) return existing
        val keyGenerator = KeyGenerator.getInstance(
            KeyProperties.KEY_ALGORITHM_AES,
            KEYSTORE_PROVIDER,
        )
        keyGenerator.init(
            KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setRandomizedEncryptionRequired(true)
                .build(),
        )
        return keyGenerator.generateKey()
    }

    @SuppressLint("UseKtx") // Synchronous commit failure must remain observable for credential deletion.
    private fun clearStoredMaterial(deleteKey: Boolean) {
        check(preferences.edit().clear().commit()) {
            "Could not clear the encrypted gateway bearer credential."
        }
        if (deleteKey) {
            runCatching {
                val keyStore = KeyStore.getInstance(KEYSTORE_PROVIDER).apply { load(null) }
                if (keyStore.containsAlias(KEY_ALIAS)) {
                    keyStore.deleteEntry(KEY_ALIAS)
                }
            }
        }
    }
}
