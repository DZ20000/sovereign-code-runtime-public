package com.sovereign.runtime.android.surface

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SensitiveSurfacePolicyTest {
    @Test
    fun explicitOverridesWinAndCanBeReplaced() {
        val policy = SensitiveSurfacePolicy(
            mapOf("com.example.wallet" to SensitiveSurfaceCategory.PAYMENT),
        )
        assertEquals(
            SensitiveSurfaceCategory.PAYMENT,
            policy.classify("com.example.wallet"),
        )
        policy.replaceOverrides(
            mapOf("com.example.wallet" to SensitiveSurfaceCategory.NORMAL),
        )
        assertEquals(
            SensitiveSurfaceCategory.NORMAL,
            policy.classify("COM.EXAMPLE.WALLET"),
        )
    }

    @Test
    fun secretAndFinancialSurfacesDenyScreenshots() {
        val policy = SensitiveSurfacePolicy(
            mapOf(
                "com.example.bank" to SensitiveSurfaceCategory.BANKING,
                "com.example.auth" to SensitiveSurfaceCategory.AUTHENTICATOR,
                "com.example.password" to SensitiveSurfaceCategory.PASSWORD_MANAGER,
            ),
        )
        for (packageName in listOf(
            "com.example.bank",
            "com.example.auth",
            "com.example.password",
        )) {
            val decision = policy.decide(packageName)
            assertFalse(decision.screenshotAllowed)
            assertFalse(decision.notificationInteractionAllowed)
        }
        assertEquals(
            NotificationExposure.METADATA_ONLY,
            policy.decide("com.example.auth").notificationExposure,
        )
    }

    @Test
    fun unknownSurfaceDoesNotSilentlyBecomeSensitiveOrTrusted() {
        val decision = SensitiveSurfacePolicy().decide("com.example.ordinary")
        assertEquals(SensitiveSurfaceCategory.UNKNOWN, decision.category)
        assertTrue(decision.uiTextAllowed)
        assertTrue(decision.screenshotAllowed)
        assertTrue(decision.notificationInteractionAllowed)
        assertEquals("unclassified_application", decision.reasonCode)
    }
}

class SurfaceTextRedactorTest {
    private val redactor = SurfaceTextRedactor()

    @Test
    fun metadataOnlySurfaceReturnsNoRawText() {
        val result = redactor.redact(
            value = "Your verification code is 123456",
            metadataOnly = true,
        )
        assertNull(result.value)
        assertTrue(result.redacted)
        assertEquals("metadata_only_surface", result.reasonCode)
    }

    @Test
    fun passwordAndOtpAreRedactedButOrdinaryNumbersRemain() {
        assertEquals(
            "[REDACTED_PASSWORD]",
            redactor.redact("secret", metadataOnly = false, password = true).value,
        )
        assertEquals(
            "Use [REDACTED_OTP] now",
            redactor.redact(
                "Use 123456 now",
                metadataOnly = false,
                contextualLabel = "Verification code",
            ).value,
        )
        val ordinary = redactor.redact(
            "Order 123456",
            metadataOnly = false,
            contextualLabel = "Order number",
        )
        assertEquals("Order 123456", ordinary.value)
        assertFalse(ordinary.redacted)
    }
}

class ActiveSurfaceRegistryTest {
    @Test
    fun revisionsAdvanceAndInvalidationClearsCurrentSurface() {
        var now = 100L
        val registry = ActiveSurfaceRegistry(SurfaceElapsedClock { now })
        val first = registry.observe("com.example.app", 1)
        now += 1
        val second = registry.observe("com.example.app", 2)
        assertTrue(second.revision > first.revision)
        assertEquals(2, registry.current()?.windowId)
        registry.invalidate()
        assertNull(registry.current())
    }
}
