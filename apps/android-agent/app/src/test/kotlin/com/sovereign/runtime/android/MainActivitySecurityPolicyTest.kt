package com.sovereign.runtime.android

import com.sovereign.runtime.android.approval.AndroidApprovalBrokerState
import com.sovereign.runtime.android.approval.AndroidApprovalPresentation
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MainActivitySecurityPolicyTest {
    @Test
    fun windowIsSecureBeforeRenderingAnyVisibleCredentialOrApproval() {
        assertFalse(
            shouldSecureMainActivityWindow(
                connectionConfigVisible = false,
                approvalState = AndroidApprovalBrokerState(),
            ),
        )
        assertTrue(
            shouldSecureMainActivityWindow(
                connectionConfigVisible = true,
                approvalState = AndroidApprovalBrokerState(),
            ),
        )
        assertTrue(
            shouldSecureMainActivityWindow(
                connectionConfigVisible = false,
                approvalState = AndroidApprovalBrokerState(
                    active = AndroidApprovalPresentation(
                        requestId = "11111111-1111-4111-8111-111111111111",
                        principalFingerprint = "0123456789abcdef",
                        toolName = "android.test.consequential",
                        title = "Review action",
                        message = "Review this one-time Android action.",
                        detail = "Arguments SHA-256: 0123456789abcdef…",
                        argumentsSha256 = "a".repeat(64),
                        requestedAtElapsedMs = 1_000L,
                        expiresAtElapsedMs = 31_000L,
                        burstDetected = false,
                    ),
                ),
            ),
        )
    }
}
