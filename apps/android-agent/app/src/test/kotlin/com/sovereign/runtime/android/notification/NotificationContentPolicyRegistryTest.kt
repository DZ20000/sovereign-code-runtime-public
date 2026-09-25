package com.sovereign.runtime.android.notification

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

internal class NotificationContentPolicyRegistryTest {
    @Test
    fun defaultPolicyRedactsUnknownPackages() {
        val registry = NotificationContentPolicyRegistry()
        val snapshot = registry.current()
        assertEquals(1L, snapshot.revision)
        assertEquals(
            NotificationSensitivity.SENSITIVE,
            registry.classify(snapshot, "com.example.chat", "msg"),
        )
    }

    @Test
    fun locallyAllowedNormalPackageCanExposeSanitizedContent() {
        val registry = NotificationContentPolicyRegistry()
        val snapshot = registry.replace(
            contentAllowedPackages = setOf("com.example.chat"),
            explicitlySensitivePackages = emptySet(),
        )
        assertEquals(2L, snapshot.revision)
        assertEquals(
            NotificationSensitivity.NORMAL,
            registry.classify(snapshot, "com.example.chat", "msg"),
        )
    }

    @Test
    fun hardSensitivePackageCannotBeContentAllowed() {
        val registry = NotificationContentPolicyRegistry()
        for (packageName in listOf(
            "com.example.authenticator",
            "com.bitwarden.app",
            "com.example.bank",
            "com.example.wallet",
        )) {
            val error = runCatching {
                registry.replace(
                    contentAllowedPackages = setOf(packageName),
                    explicitlySensitivePackages = emptySet(),
                )
            }.exceptionOrNull()
            assertTrue("Expected hard-sensitive rejection for $packageName", error is IllegalArgumentException)
        }
    }

    @Test
    fun explicitSensitiveEntryOverridesOrdinaryClassification() {
        val registry = NotificationContentPolicyRegistry()
        val snapshot = registry.replace(
            contentAllowedPackages = emptySet(),
            explicitlySensitivePackages = setOf("com.example.secret"),
        )
        assertEquals(
            NotificationSensitivity.SENSITIVE,
            registry.classify(snapshot, "com.example.secret", null),
        )
    }

    @Test
    fun stalePolicySnapshotCannotClassifyAfterReplacement() {
        val registry = NotificationContentPolicyRegistry()
        val stale = registry.current()
        registry.replace(
            contentAllowedPackages = setOf("com.example.chat"),
            explicitlySensitivePackages = emptySet(),
        )
        val error = runCatching {
            registry.classify(stale, "com.example.chat", "msg")
        }.exceptionOrNull()
        assertTrue(error is IllegalArgumentException)
    }

    @Test
    fun packageNamesAreNormalizedButDuplicatesFailClosed() {
        val registry = NotificationContentPolicyRegistry()
        val snapshot = registry.replace(
            contentAllowedPackages = setOf("Com.Example.Chat"),
            explicitlySensitivePackages = emptySet(),
        )
        assertTrue("com.example.chat" in snapshot.contentAllowedPackages)

        val duplicateError = runCatching {
            registry.replace(
                contentAllowedPackages = setOf("com.example.chat", "COM.EXAMPLE.CHAT"),
                explicitlySensitivePackages = emptySet(),
            )
        }.exceptionOrNull()
        assertTrue(duplicateError is IllegalArgumentException)
    }
}
