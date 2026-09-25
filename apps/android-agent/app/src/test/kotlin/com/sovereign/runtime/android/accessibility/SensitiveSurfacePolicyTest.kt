package com.sovereign.runtime.android.accessibility

import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SensitiveSurfacePolicyTest {
    @Test
    fun passwordNodeIsRedactedAndNonInteractive() {
        val decision = SensitiveSurfacePolicy().evaluate(
            packageName = "example.app",
            password = true,
        )
        assertFalse(decision.interactionAllowed)
        assertTrue(decision.redactText)
        assertTrue(decision.reason.orEmpty().contains("Password"))
    }

    @Test
    fun protectedAndroidAndSovereignPackagesAreDenied() {
        val policy = SensitiveSurfacePolicy()
        for (packageName in listOf(
            "com.android.permissioncontroller",
            "com.google.android.permissioncontroller.module",
            "com.android.systemui",
            "com.sovereign.runtime.android.debug",
        )) {
            val decision = policy.evaluate(packageName, password = false)
            assertFalse("Expected $packageName to be denied", decision.interactionAllowed)
            assertTrue("Expected $packageName to be redacted", decision.redactText)
        }
    }

    @Test
    fun userDenylistUsesPackageBoundaryInsteadOfArbitraryPrefix() {
        val policy = SensitiveSurfacePolicy(
            userDeniedPackages = setOf("com.example.bank"),
        )
        val denied = policy.evaluate("com.example.bank", false)
        assertFalse(denied.interactionAllowed)
        assertTrue(denied.redactText)
        assertFalse(policy.evaluate("com.example.bank.secure", false).interactionAllowed)
        assertTrue(policy.evaluate("com.example.bankingdemo", false).interactionAllowed)
    }

    @Test
    fun ordinaryVerifiedPackageRemainsInteractive() {
        val decision = SensitiveSurfacePolicy().evaluate(
            packageName = "com.example.notes",
            password = false,
        )
        assertTrue(decision.interactionAllowed)
        assertFalse(decision.redactText)
        assertNull(decision.reason)
    }

    @Test
    fun missingPackageFailsClosed() {
        val missing = SensitiveSurfacePolicy().evaluate(null, false)
        assertFalse(missing.interactionAllowed)
        assertTrue(missing.redactText)
        val blank = SensitiveSurfacePolicy().evaluate("   ", false)
        assertFalse(blank.interactionAllowed)
        assertTrue(blank.redactText)
    }
}
