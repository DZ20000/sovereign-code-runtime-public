package com.sovereign.runtime.android.screen

import java.util.UUID
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

internal class ProjectionStateMachineTest {
    private val machine = ProjectionStateMachine(consentTimeoutMs = 1_000)

    @Test
    fun grantRequiresCurrentGenerationRequestAndDeadline() {
        val initial = machine.initialState(0)
        val requestId = UUID.randomUUID().toString()
        val pending = machine.reduce(
            initial,
            ProjectionEvent.RequestConsent(atElapsedMs = 10, requestId = requestId),
        )
        assertEquals(ProjectionLifecycle.CONSENT_PENDING, pending.state.lifecycle)
        assertEquals(1_010L, pending.state.deadlineAtElapsedMs)
        assertTrue(pending.effect is ProjectionEffect.PresentLocalConsent)

        val sessionId = UUID.randomUUID().toString()
        val active = machine.reduce(
            pending.state,
            ProjectionEvent.ConsentGranted(
                atElapsedMs = 20,
                generation = pending.state.generation,
                requestId = requestId,
                projectionSessionId = sessionId,
            ),
        )
        assertEquals(ProjectionLifecycle.ACTIVE, active.state.lifecycle)
        assertEquals(sessionId, active.state.projectionSessionId)
        assertTrue(active.effect is ProjectionEffect.ActivateProjection)

        val stale = machine.reduce(
            pending.state,
            ProjectionEvent.ConsentGranted(
                atElapsedMs = 20,
                generation = pending.state.generation - 1,
                requestId = requestId,
                projectionSessionId = UUID.randomUUID().toString(),
            ),
        )
        assertTrue(stale.effect is ProjectionEffect.Ignored)

        val late = machine.reduce(
            pending.state,
            ProjectionEvent.ConsentGranted(
                atElapsedMs = 1_010,
                generation = pending.state.generation,
                requestId = requestId,
                projectionSessionId = UUID.randomUUID().toString(),
            ),
        )
        assertTrue(late.effect is ProjectionEffect.Ignored)
        assertEquals(ProjectionLifecycle.CONSENT_PENDING, late.state.lifecycle)
    }

    @Test
    fun denialAndTimeoutReturnToIdleWithoutPersistentConsent() {
        val requestId = UUID.randomUUID().toString()
        val pending = machine.reduce(
            machine.initialState(),
            ProjectionEvent.RequestConsent(10, requestId),
        ).state
        val denied = machine.reduce(
            pending,
            ProjectionEvent.ConsentDenied(20, pending.generation, requestId),
        )
        assertEquals(ProjectionLifecycle.IDLE, denied.state.lifecycle)
        assertNull(denied.state.projectionSessionId)

        val nextRequestId = UUID.randomUUID().toString()
        val next = machine.reduce(
            denied.state,
            ProjectionEvent.RequestConsent(30, nextRequestId),
        ).state
        val timeout = machine.reduce(
            next,
            ProjectionEvent.DeadlineExpired(next.deadlineAtElapsedMs!!, next.generation),
        )
        assertEquals(ProjectionLifecycle.IDLE, timeout.state.lifecycle)
    }

    @Test
    fun stopAndProcessRecoveryInvalidateProjectionSession() {
        val active = activeState()
        val stop = machine.reduce(active, ProjectionEvent.Stop(50))
        assertEquals(ProjectionLifecycle.IDLE, stop.state.lifecycle)
        assertTrue(stop.effect is ProjectionEffect.ReleaseProjection)
        assertTrue(stop.state.generation > active.generation)

        val recovery = machine.reduce(
            active,
            ProjectionEvent.RecoverAfterProcessStart(0),
        )
        assertEquals(ProjectionLifecycle.IDLE, recovery.state.lifecycle)
        assertTrue(recovery.effect is ProjectionEffect.ReleaseProjection)
    }

    @Test
    fun fatalFailureIsBoundedAndNeedsAttention() {
        val active = activeState()
        val failure = machine.reduce(
            active,
            ProjectionEvent.FatalFailure(
                atElapsedMs = 50,
                generation = active.generation,
                redactedReason = "failure\n" + "x".repeat(1_000),
            ),
        )
        assertEquals(ProjectionLifecycle.NEEDS_ATTENTION, failure.state.lifecycle)
        val boundedReason = requireNotNull(failure.state.failureReason)
        assertTrue(boundedReason.length <= 512)
        assertTrue(!boundedReason.contains('\n'))
        assertTrue(failure.effect is ProjectionEffect.ReleaseProjection)
    }

    private fun activeState(): ProjectionState {
        val requestId = UUID.randomUUID().toString()
        val pending = machine.reduce(
            machine.initialState(),
            ProjectionEvent.RequestConsent(10, requestId),
        ).state
        return machine.reduce(
            pending,
            ProjectionEvent.ConsentGranted(
                atElapsedMs = 20,
                generation = pending.generation,
                requestId = requestId,
                projectionSessionId = UUID.randomUUID().toString(),
            ),
        ).state
    }
}
