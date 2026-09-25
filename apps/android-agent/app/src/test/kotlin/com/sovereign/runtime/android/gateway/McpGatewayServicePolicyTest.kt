package com.sovereign.runtime.android.gateway

import com.sovereign.runtime.android.approval.AndroidApprovalBrokerState
import com.sovereign.runtime.android.approval.AndroidApprovalPresentation
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class McpGatewayServicePolicyTest {
    @Test
    fun processTerminationIsRequiredForAnOwnedListenerOrAnyPendingApproval() {
        assertFalse(
            shouldTerminateGatewayProcess(
                listenerOwned = false,
                approvalState = AndroidApprovalBrokerState(),
            ),
        )
        assertTrue(
            shouldTerminateGatewayProcess(
                listenerOwned = true,
                approvalState = AndroidApprovalBrokerState(),
            ),
        )
        assertTrue(
            shouldTerminateGatewayProcess(
                listenerOwned = false,
                approvalState = AndroidApprovalBrokerState(
                    active = presentation(),
                ),
            ),
        )
        assertTrue(
            shouldTerminateGatewayProcess(
                listenerOwned = false,
                approvalState = AndroidApprovalBrokerState(
                    queuedCount = 1,
                ),
            ),
        )
    }

    private fun presentation(): AndroidApprovalPresentation = AndroidApprovalPresentation(
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
    )
}
