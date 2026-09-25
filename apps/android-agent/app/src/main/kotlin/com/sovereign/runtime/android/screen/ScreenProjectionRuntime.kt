package com.sovereign.runtime.android.screen

import android.os.SystemClock
import java.util.UUID

internal object ScreenProjectionRuntime {
    private val stateMachine = ProjectionStateMachine()
    val captureLeases = ScreenCaptureLeaseRegistry(
        clock = ScreenCaptureElapsedClock { SystemClock.elapsedRealtime() },
    )

    private var projectionState = stateMachine.initialState(
        atElapsedMs = SystemClock.elapsedRealtime(),
    )
    private var frameSource: ProjectionFrameSource? = null

    @Synchronized
    fun state(): ProjectionState = projectionState

    @Synchronized
    fun activeCaptureBinding(): ProjectionCaptureBinding? {
        val state = projectionState
        val source = frameSource ?: return null
        if (
            state.lifecycle != ProjectionLifecycle.ACTIVE ||
            source.generation != state.generation ||
            source.projectionSessionId != state.projectionSessionId
        ) {
            return null
        }
        return ProjectionCaptureBinding(state = state, source = source)
    }

    @Synchronized
    fun requestLocalConsent(): ProjectionTransition = apply(
        stateMachine.reduce(
            projectionState,
            ProjectionEvent.RequestConsent(
                atElapsedMs = SystemClock.elapsedRealtime(),
                requestId = UUID.randomUUID().toString(),
            ),
        ),
    )

    @Synchronized
    fun consentDenied(
        generation: Long,
        requestId: String,
    ): ProjectionTransition = apply(
        stateMachine.reduce(
            projectionState,
            ProjectionEvent.ConsentDenied(
                atElapsedMs = SystemClock.elapsedRealtime(),
                generation = generation,
                requestId = requestId,
            ),
        ),
    )

    @Synchronized
    fun consentGranted(
        generation: Long,
        requestId: String,
        projectionSessionId: String,
        frameSource: ProjectionFrameSource,
    ): ProjectionTransition {
        if (frameSource.generation != generation) {
            runCatching(frameSource::close)
            throw IllegalArgumentException(
                "MediaProjection frame source generation does not match consent.",
            )
        }
        if (frameSource.projectionSessionId != projectionSessionId) {
            runCatching(frameSource::close)
            throw IllegalArgumentException(
                "MediaProjection frame source session does not match consent.",
            )
        }
        val transition = try {
            stateMachine.reduce(
                projectionState,
                ProjectionEvent.ConsentGranted(
                    atElapsedMs = SystemClock.elapsedRealtime(),
                    generation = generation,
                    requestId = requestId,
                    projectionSessionId = projectionSessionId,
                ),
            )
        } catch (error: RuntimeException) {
            runCatching(frameSource::close)
            throw error
        }
        if (transition.effect !is ProjectionEffect.ActivateProjection) {
            runCatching(frameSource::close)
            return apply(transition)
        }
        this.frameSource?.let { previous -> runCatching(previous::close) }
        projectionState = transition.state
        this.frameSource = frameSource
        return transition
    }

    @Synchronized
    fun consentDeadlineExpired(generation: Long): ProjectionTransition = apply(
        stateMachine.reduce(
            projectionState,
            ProjectionEvent.DeadlineExpired(
                atElapsedMs = SystemClock.elapsedRealtime(),
                generation = generation,
            ),
        ),
    )

    @Synchronized
    fun projectionStopped(
        generation: Long,
        projectionSessionId: String,
    ): ProjectionTransition = apply(
        stateMachine.reduce(
            projectionState,
            ProjectionEvent.ProjectionStopped(
                atElapsedMs = SystemClock.elapsedRealtime(),
                generation = generation,
                projectionSessionId = projectionSessionId,
            ),
        ),
    )

    @Synchronized
    fun fail(
        generation: Long,
        redactedReason: String,
    ): ProjectionTransition = apply(
        stateMachine.reduce(
            projectionState,
            ProjectionEvent.FatalFailure(
                atElapsedMs = SystemClock.elapsedRealtime(),
                generation = generation,
                redactedReason = redactedReason,
            ),
        ),
    )

    @Synchronized
    fun stop(): ProjectionTransition = apply(
        stateMachine.reduce(
            projectionState,
            ProjectionEvent.Stop(
                atElapsedMs = SystemClock.elapsedRealtime(),
            ),
        ),
    )

    @Synchronized
    fun recoverAfterProcessStart(): ProjectionTransition = apply(
        stateMachine.reduce(
            projectionState,
            ProjectionEvent.RecoverAfterProcessStart(
                atElapsedMs = SystemClock.elapsedRealtime(),
            ),
        ),
    )

    private fun apply(transition: ProjectionTransition): ProjectionTransition {
        projectionState = transition.state
        if (projectionState.lifecycle != ProjectionLifecycle.ACTIVE) {
            captureLeases.invalidateAll()
            val previous = frameSource
            frameSource = null
            if (previous != null) runCatching(previous::close)
        }
        return transition
    }
}
