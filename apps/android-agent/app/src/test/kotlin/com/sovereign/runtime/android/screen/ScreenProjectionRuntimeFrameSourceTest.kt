package com.sovereign.runtime.android.screen

import java.util.UUID
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

internal class ScreenProjectionRuntimeFrameSourceTest {
    @After
    fun resetRuntime() {
        ScreenProjectionRuntime.recoverAfterProcessStart()
    }

    @Test
    fun activeOwnershipBindsOneFrameSourceAndStopClosesItWithPendingLeases() {
        ScreenProjectionRuntime.recoverAfterProcessStart()
        val pending = ScreenProjectionRuntime.requestLocalConsent().state
        val requestId = requireNotNull(pending.consentRequestId)
        val sessionId = UUID.randomUUID().toString()
        val source = FakeProjectionFrameSource(
            generation = pending.generation,
            projectionSessionId = sessionId,
        )

        val active = ScreenProjectionRuntime.consentGranted(
            generation = pending.generation,
            requestId = requestId,
            projectionSessionId = sessionId,
            frameSource = source,
        )

        assertEquals(ProjectionLifecycle.ACTIVE, active.state.lifecycle)
        assertSame(source, ScreenProjectionRuntime.activeCaptureBinding()?.source)
        ScreenProjectionRuntime.captureLeases.issue(
            projectionState = active.state,
            request = ScreenCaptureLeaseRequest(
                projectionGeneration = active.state.generation,
                projectionSessionId = sessionId,
                foregroundPackage = "com.example.notes",
                foregroundWindowEpoch = 1,
                width = 1,
                height = 1,
            ),
        )
        assertEquals(1, ScreenProjectionRuntime.captureLeases.pendingCount())

        ScreenProjectionRuntime.stop()

        assertTrue(source.closed)
        assertNull(ScreenProjectionRuntime.activeCaptureBinding())
        assertEquals(0, ScreenProjectionRuntime.captureLeases.pendingCount())
    }

    @Test
    fun staleConsentResultClosesUnacceptedFrameSource() {
        ScreenProjectionRuntime.recoverAfterProcessStart()
        val pending = ScreenProjectionRuntime.requestLocalConsent().state
        val sessionId = UUID.randomUUID().toString()
        val source = FakeProjectionFrameSource(
            generation = pending.generation,
            projectionSessionId = sessionId,
        )

        val transition = ScreenProjectionRuntime.consentGranted(
            generation = pending.generation,
            requestId = UUID.randomUUID().toString(),
            projectionSessionId = sessionId,
            frameSource = source,
        )

        assertTrue(transition.effect is ProjectionEffect.Ignored)
        assertEquals(ProjectionLifecycle.CONSENT_PENDING, transition.state.lifecycle)
        assertTrue(source.closed)
        assertNull(ScreenProjectionRuntime.activeCaptureBinding())
    }

    @Test
    fun reducerValidationClosesOnlyTheUnacceptedReplacementSource() {
        ScreenProjectionRuntime.recoverAfterProcessStart()
        val pending = ScreenProjectionRuntime.requestLocalConsent().state
        val requestId = requireNotNull(pending.consentRequestId)
        val sessionId = UUID.randomUUID().toString()
        val activeSource = FakeProjectionFrameSource(
            generation = pending.generation,
            projectionSessionId = sessionId,
        )
        ScreenProjectionRuntime.consentGranted(
            generation = pending.generation,
            requestId = requestId,
            projectionSessionId = sessionId,
            frameSource = activeSource,
        )
        val rejectedSource = FakeProjectionFrameSource(
            generation = pending.generation,
            projectionSessionId = sessionId,
        )

        val failure = runCatching {
            ScreenProjectionRuntime.consentGranted(
                generation = pending.generation,
                requestId = "not-a-uuid",
                projectionSessionId = sessionId,
                frameSource = rejectedSource,
            )
        }.exceptionOrNull()

        assertTrue(failure is IllegalArgumentException)
        assertTrue(rejectedSource.closed)
        assertTrue(!activeSource.closed)
        assertSame(activeSource, ScreenProjectionRuntime.activeCaptureBinding()?.source)
    }

    private class FakeProjectionFrameSource(
        override val generation: Long,
        override val projectionSessionId: String,
    ) : ProjectionFrameSource {
        var closed = false

        override fun dimensions(): ProjectionFrameDimensions =
            ProjectionFrameDimensions(width = 1, height = 1)

        override suspend fun capture(lease: ScreenCaptureLease): ProjectionFrameResult =
            ProjectionFrameResult.Failure(
                ScreenCaptureFailure(
                    status = ScreenCaptureStatus.FAILED,
                    reasonCode = "not_used",
                    explanation = "The frame source is not used by this lifecycle test.",
                ),
            )

        override fun close() {
            closed = true
        }
    }
}
