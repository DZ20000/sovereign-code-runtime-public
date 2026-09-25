package com.sovereign.runtime.android.approval

import java.util.UUID
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class AndroidApprovalBrokerTest {
    @Test
    fun localAllowResolvesTheActiveRequestOnce() = runTest {
        val broker = broker()
        val request = input()
        val pending = async { broker.request(request) }
        runCurrent()

        assertEquals(request.requestId, broker.state.value.active?.requestId)
        assertTrue(
            broker.resolve(
                requestId = request.requestId,
                decision = AndroidApprovalDecision.ALLOW_ONCE,
            ),
        )
        assertEquals(
            AndroidApprovalResult(
                requestId = request.requestId,
                decision = AndroidApprovalDecision.ALLOW_ONCE,
                reason = AndroidApprovalResolutionReason.LOCAL_ALLOW,
            ),
            pending.await(),
        )
        assertNull(broker.state.value.active)
        assertFalse(
            broker.resolve(
                requestId = request.requestId,
                decision = AndroidApprovalDecision.ALLOW_ONCE,
            ),
        )
    }

    @Test
    fun requestsArePresentedFifoAndQueuedRequestsCannotBeLocallyResolvedEarly() = runTest {
        val broker = broker(maximumPending = 3)
        val first = input()
        val second = input()
        val firstResult = async { broker.request(first) }
        val secondResult = async { broker.request(second) }
        runCurrent()

        assertEquals(first.requestId, broker.state.value.active?.requestId)
        assertEquals(1, broker.state.value.queuedCount)
        assertFalse(
            broker.resolve(
                requestId = second.requestId,
                decision = AndroidApprovalDecision.ALLOW_ONCE,
            ),
        )

        assertTrue(broker.resolve(first.requestId, AndroidApprovalDecision.DENY))
        assertEquals(
            AndroidApprovalResolutionReason.LOCAL_DENY,
            firstResult.await().reason,
        )
        assertEquals(second.requestId, broker.state.value.active?.requestId)
        assertEquals(0, broker.state.value.queuedCount)

        assertTrue(broker.resolve(second.requestId, AndroidApprovalDecision.ALLOW_ONCE))
        assertEquals(
            AndroidApprovalResolutionReason.LOCAL_ALLOW,
            secondResult.await().reason,
        )
    }

    @Test
    fun timeoutRemovesTheRequestAndActivatesTheNextOne() = runTest {
        val broker = broker(timeoutMs = 1_000L)
        val first = input()
        val second = input()
        val firstResult = async { broker.request(first) }
        val secondResult = async { broker.request(second) }
        runCurrent()

        advanceTimeBy(1_001L)
        runCurrent()
        assertEquals(AndroidApprovalResolutionReason.TIMEOUT, firstResult.await().reason)
        assertEquals(AndroidApprovalResolutionReason.TIMEOUT, secondResult.await().reason)
        assertNull(broker.state.value.active)
        assertEquals(0, broker.state.value.queuedCount)
    }

    @Test
    fun queueOverflowAndDuplicateRequestIdsFailClosedWithoutReplacingTheActiveRequest() = runTest {
        val broker = broker(maximumPending = 2)
        val first = input()
        val second = input()
        val firstResult = async { broker.request(first) }
        val secondResult = async { broker.request(second) }
        runCurrent()

        val overflow = broker.request(input())
        assertEquals(AndroidApprovalResolutionReason.QUEUE_OVERFLOW, overflow.reason)
        val duplicate = broker.request(first)
        assertEquals(AndroidApprovalResolutionReason.DUPLICATE_REQUEST, duplicate.reason)
        assertEquals(first.requestId, broker.state.value.active?.requestId)
        assertEquals(1, broker.state.value.queuedCount)

        broker.cancelAll(AndroidApprovalResolutionReason.GATEWAY_STOP)
        assertEquals(AndroidApprovalResolutionReason.GATEWAY_STOP, firstResult.await().reason)
        assertEquals(AndroidApprovalResolutionReason.GATEWAY_STOP, secondResult.await().reason)
    }

    @Test
    fun lateLocalAllowCannotWinTheExpiryRace() = runTest {
        var elapsed = 1_000L
        val broker = AndroidApprovalBroker(
            timeoutMs = 1_000L,
            maximumPending = 8,
            burstWindowMs = 10_000L,
            burstThreshold = 2,
            now = { elapsed },
        )
        val request = input()
        val pending = async { broker.request(request) }
        runCurrent()

        elapsed = 2_001L
        assertFalse(
            broker.resolve(
                requestId = request.requestId,
                decision = AndroidApprovalDecision.ALLOW_ONCE,
            ),
        )
        val result = pending.await()
        assertEquals(AndroidApprovalDecision.DENY, result.decision)
        assertEquals(AndroidApprovalResolutionReason.TIMEOUT, result.reason)
        assertNull(broker.state.value.active)
    }

    @Test
    fun resolvedRequestIdentityCannotBeReplayedWithinTheBoundedRetirementWindow() = runTest {
        val broker = broker()
        val request = input()
        val pending = async { broker.request(request) }
        runCurrent()
        assertTrue(broker.resolve(request.requestId, AndroidApprovalDecision.DENY))
        assertEquals(AndroidApprovalResolutionReason.LOCAL_DENY, pending.await().reason)

        val replay = broker.request(request)
        assertEquals(AndroidApprovalDecision.DENY, replay.decision)
        assertEquals(AndroidApprovalResolutionReason.DUPLICATE_REQUEST, replay.reason)
        assertNull(broker.state.value.active)
        assertEquals(0, broker.state.value.queuedCount)
    }

    @Test
    fun burstFlagIncludesRapidQueuedRequestsButNotUnrelatedOldRequests() = runTest {
        var elapsed = 10_000L
        val broker = AndroidApprovalBroker(
            timeoutMs = 30_000L,
            maximumPending = 4,
            burstWindowMs = 10_000L,
            burstThreshold = 2,
            now = { elapsed },
        )
        val first = input()
        val second = input()
        val firstResult = async { broker.request(first) }
        runCurrent()
        elapsed += 1
        val secondResult = async { broker.request(second) }
        runCurrent()

        assertFalse(requireNotNull(broker.state.value.active).burstDetected)
        broker.resolve(first.requestId, AndroidApprovalDecision.DENY)
        assertEquals(AndroidApprovalResolutionReason.LOCAL_DENY, firstResult.await().reason)
        assertTrue(requireNotNull(broker.state.value.active).burstDetected)

        broker.resolve(second.requestId, AndroidApprovalDecision.DENY)
        assertEquals(AndroidApprovalResolutionReason.LOCAL_DENY, secondResult.await().reason)
    }

    @Test
    fun cancellationRemovesAQueuedRequestWithoutAffectingTheActiveRequest() = runTest {
        val broker = broker(maximumPending = 3)
        val first = input()
        val second = input()
        val firstResult = async { broker.request(first) }
        val secondResult = async { broker.request(second) }
        runCurrent()

        secondResult.cancel()
        runCurrent()
        assertEquals(first.requestId, broker.state.value.active?.requestId)
        assertEquals(0, broker.state.value.queuedCount)

        broker.resolve(first.requestId, AndroidApprovalDecision.DENY)
        assertEquals(AndroidApprovalResolutionReason.LOCAL_DENY, firstResult.await().reason)
    }

    private fun broker(
        timeoutMs: Long = 30_000L,
        maximumPending: Int = 8,
    ): AndroidApprovalBroker = AndroidApprovalBroker(
        timeoutMs = timeoutMs,
        maximumPending = maximumPending,
        burstWindowMs = 10_000L,
        burstThreshold = 2,
        now = { 0L },
    )

    private fun input(): AndroidApprovalRequestInput = AndroidApprovalRequestInput(
        requestId = UUID.randomUUID().toString(),
        principalFingerprint = "0123456789abcdef",
        toolName = "android.test.consequential",
        title = "Consequential Android action",
        message = "Review this one-time Android action before it runs.",
        detail = "Tool: android.test.consequential\nArguments SHA-256: 0123456789abcdef…",
        argumentsSha256 = "a".repeat(64),
    )
}
