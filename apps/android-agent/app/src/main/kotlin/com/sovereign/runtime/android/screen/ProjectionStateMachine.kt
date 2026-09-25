package com.sovereign.runtime.android.screen

import java.util.UUID

enum class ProjectionLifecycle {
    IDLE,
    CONSENT_PENDING,
    ACTIVE,
    NEEDS_ATTENTION,
}

data class ProjectionState(
    val lifecycle: ProjectionLifecycle,
    val generation: Long,
    val consentRequestId: String?,
    val projectionSessionId: String?,
    val phaseStartedAtElapsedMs: Long,
    val deadlineAtElapsedMs: Long?,
    val failureReason: String?,
)

sealed interface ProjectionEvent {
    val atElapsedMs: Long

    data class RequestConsent(
        override val atElapsedMs: Long,
        val requestId: String,
    ) : ProjectionEvent

    data class ConsentGranted(
        override val atElapsedMs: Long,
        val generation: Long,
        val requestId: String,
        val projectionSessionId: String,
    ) : ProjectionEvent

    data class ConsentDenied(
        override val atElapsedMs: Long,
        val generation: Long,
        val requestId: String,
    ) : ProjectionEvent

    data class DeadlineExpired(
        override val atElapsedMs: Long,
        val generation: Long,
    ) : ProjectionEvent

    data class ProjectionStopped(
        override val atElapsedMs: Long,
        val generation: Long,
        val projectionSessionId: String,
    ) : ProjectionEvent

    data class FatalFailure(
        override val atElapsedMs: Long,
        val generation: Long,
        val redactedReason: String,
    ) : ProjectionEvent

    data class Stop(
        override val atElapsedMs: Long,
    ) : ProjectionEvent

    data class RecoverAfterProcessStart(
        override val atElapsedMs: Long,
    ) : ProjectionEvent
}

sealed interface ProjectionEffect {
    data class PresentLocalConsent(
        val generation: Long,
        val requestId: String,
        val deadlineAtElapsedMs: Long,
    ) : ProjectionEffect

    data class ActivateProjection(
        val generation: Long,
        val projectionSessionId: String,
    ) : ProjectionEffect

    data class ReleaseProjection(
        val generation: Long,
        val projectionSessionId: String,
        val reasonCode: String,
    ) : ProjectionEffect

    data class Attention(
        val reason: String,
    ) : ProjectionEffect

    data class Hold(val reason: String) : ProjectionEffect
    data class Ignored(val reason: String) : ProjectionEffect
}

data class ProjectionTransition(
    val state: ProjectionState,
    val effect: ProjectionEffect,
)

class ProjectionStateMachine(
    private val consentTimeoutMs: Long = 30_000,
) {
    init {
        require(consentTimeoutMs in 1_000..300_000) {
            "consentTimeoutMs is outside its allowed range."
        }
    }

    fun initialState(atElapsedMs: Long = 0): ProjectionState {
        requireTimestamp(atElapsedMs)
        return ProjectionState(
            lifecycle = ProjectionLifecycle.IDLE,
            generation = 0,
            consentRequestId = null,
            projectionSessionId = null,
            phaseStartedAtElapsedMs = atElapsedMs,
            deadlineAtElapsedMs = null,
            failureReason = null,
        )
    }

    fun reduce(state: ProjectionState, event: ProjectionEvent): ProjectionTransition {
        requireTimestamp(event.atElapsedMs)
        if (event is ProjectionEvent.RecoverAfterProcessStart) {
            val releaseEffect = state.projectionSessionId?.let { sessionId ->
                ProjectionEffect.ReleaseProjection(
                    generation = state.generation,
                    projectionSessionId = sessionId,
                    reasonCode = "process_recovery",
                )
            }
            return ProjectionTransition(
                state = idleState(state.generation, event.atElapsedMs),
                effect = releaseEffect ?: ProjectionEffect.Hold(
                    "MediaProjection consent is process-local and was reset after process start.",
                ),
            )
        }
        if (event.atElapsedMs < state.phaseStartedAtElapsedMs) {
            return ProjectionTransition(
                state,
                ProjectionEffect.Ignored("The projection event predates the current lifecycle phase."),
            )
        }
        return when (event) {
            is ProjectionEvent.RequestConsent -> requestConsent(state, event)
            is ProjectionEvent.ConsentGranted -> consentGranted(state, event)
            is ProjectionEvent.ConsentDenied -> consentDenied(state, event)
            is ProjectionEvent.DeadlineExpired -> deadlineExpired(state, event)
            is ProjectionEvent.ProjectionStopped -> projectionStopped(state, event)
            is ProjectionEvent.FatalFailure -> fatalFailure(state, event)
            is ProjectionEvent.Stop -> stop(state, event)
            is ProjectionEvent.RecoverAfterProcessStart -> error("handled above")
        }
    }

    private fun requestConsent(
        state: ProjectionState,
        event: ProjectionEvent.RequestConsent,
    ): ProjectionTransition {
        requireUuid(event.requestId, "MediaProjection consent request ID")
        if (state.lifecycle == ProjectionLifecycle.ACTIVE) {
            return ProjectionTransition(
                state,
                ProjectionEffect.Hold("A MediaProjection session is already active."),
            )
        }
        if (state.lifecycle == ProjectionLifecycle.CONSENT_PENDING) {
            return ProjectionTransition(
                state,
                ProjectionEffect.Hold("A local MediaProjection consent request is already pending."),
            )
        }
        val generation = state.generation + 1
        check(generation > state.generation) { "MediaProjection generation limit reached." }
        val deadline = event.atElapsedMs + consentTimeoutMs
        check(deadline >= event.atElapsedMs) { "MediaProjection consent deadline overflow." }
        return ProjectionTransition(
            state = ProjectionState(
                lifecycle = ProjectionLifecycle.CONSENT_PENDING,
                generation = generation,
                consentRequestId = event.requestId,
                projectionSessionId = null,
                phaseStartedAtElapsedMs = event.atElapsedMs,
                deadlineAtElapsedMs = deadline,
                failureReason = null,
            ),
            effect = ProjectionEffect.PresentLocalConsent(
                generation = generation,
                requestId = event.requestId,
                deadlineAtElapsedMs = deadline,
            ),
        )
    }

    private fun consentGranted(
        state: ProjectionState,
        event: ProjectionEvent.ConsentGranted,
    ): ProjectionTransition {
        requireUuid(event.requestId, "MediaProjection consent request ID")
        requireUuid(event.projectionSessionId, "MediaProjection session ID")
        val rejected = validatePendingEvent(state, event.generation, event.requestId, event.atElapsedMs)
        if (rejected != null) return ProjectionTransition(state, rejected)
        return ProjectionTransition(
            state = ProjectionState(
                lifecycle = ProjectionLifecycle.ACTIVE,
                generation = state.generation,
                consentRequestId = null,
                projectionSessionId = event.projectionSessionId,
                phaseStartedAtElapsedMs = event.atElapsedMs,
                deadlineAtElapsedMs = null,
                failureReason = null,
            ),
            effect = ProjectionEffect.ActivateProjection(
                generation = state.generation,
                projectionSessionId = event.projectionSessionId,
            ),
        )
    }

    private fun consentDenied(
        state: ProjectionState,
        event: ProjectionEvent.ConsentDenied,
    ): ProjectionTransition {
        requireUuid(event.requestId, "MediaProjection consent request ID")
        val rejected = validatePendingEvent(state, event.generation, event.requestId, event.atElapsedMs)
        if (rejected != null) return ProjectionTransition(state, rejected)
        return ProjectionTransition(
            state = idleState(state.generation, event.atElapsedMs),
            effect = ProjectionEffect.Hold("The user denied local MediaProjection consent."),
        )
    }

    private fun deadlineExpired(
        state: ProjectionState,
        event: ProjectionEvent.DeadlineExpired,
    ): ProjectionTransition {
        if (event.generation != state.generation) {
            return ProjectionTransition(
                state,
                ProjectionEffect.Ignored("The projection timeout belongs to a stale generation."),
            )
        }
        if (
            state.lifecycle != ProjectionLifecycle.CONSENT_PENDING ||
            state.deadlineAtElapsedMs == null ||
            event.atElapsedMs < state.deadlineAtElapsedMs
        ) {
            return ProjectionTransition(
                state,
                ProjectionEffect.Ignored("The projection consent deadline has not expired."),
            )
        }
        return ProjectionTransition(
            state = idleState(state.generation, event.atElapsedMs),
            effect = ProjectionEffect.Hold("The local MediaProjection consent request expired."),
        )
    }

    private fun projectionStopped(
        state: ProjectionState,
        event: ProjectionEvent.ProjectionStopped,
    ): ProjectionTransition {
        requireUuid(event.projectionSessionId, "MediaProjection session ID")
        if (
            state.lifecycle != ProjectionLifecycle.ACTIVE ||
            event.generation != state.generation ||
            event.projectionSessionId != state.projectionSessionId
        ) {
            return ProjectionTransition(
                state,
                ProjectionEffect.Ignored("The projection stop event does not match the active session."),
            )
        }
        return ProjectionTransition(
            state = idleState(state.generation, event.atElapsedMs),
            effect = ProjectionEffect.Hold("The MediaProjection session stopped."),
        )
    }

    private fun fatalFailure(
        state: ProjectionState,
        event: ProjectionEvent.FatalFailure,
    ): ProjectionTransition {
        if (event.generation != state.generation) {
            return ProjectionTransition(
                state,
                ProjectionEffect.Ignored("The projection failure belongs to a stale generation."),
            )
        }
        val reason = boundedReason(event.redactedReason)
        val sessionId = state.projectionSessionId
        return ProjectionTransition(
            state = ProjectionState(
                lifecycle = ProjectionLifecycle.NEEDS_ATTENTION,
                generation = state.generation,
                consentRequestId = null,
                projectionSessionId = null,
                phaseStartedAtElapsedMs = event.atElapsedMs,
                deadlineAtElapsedMs = null,
                failureReason = reason,
            ),
            effect = if (sessionId == null) {
                ProjectionEffect.Attention(reason)
            } else {
                ProjectionEffect.ReleaseProjection(
                    generation = state.generation,
                    projectionSessionId = sessionId,
                    reasonCode = "fatal_failure",
                )
            },
        )
    }

    private fun stop(
        state: ProjectionState,
        event: ProjectionEvent.Stop,
    ): ProjectionTransition {
        val sessionId = state.projectionSessionId
        return ProjectionTransition(
            state = idleState(state.generation + 1, event.atElapsedMs),
            effect = if (sessionId == null) {
                ProjectionEffect.Hold("MediaProjection state was cleared.")
            } else {
                ProjectionEffect.ReleaseProjection(
                    generation = state.generation,
                    projectionSessionId = sessionId,
                    reasonCode = "operator_stop",
                )
            },
        )
    }

    private fun validatePendingEvent(
        state: ProjectionState,
        generation: Long,
        requestId: String,
        atElapsedMs: Long,
    ): ProjectionEffect.Ignored? {
        if (generation != state.generation) {
            return ProjectionEffect.Ignored("The consent result belongs to a stale generation.")
        }
        if (
            state.lifecycle != ProjectionLifecycle.CONSENT_PENDING ||
            requestId != state.consentRequestId
        ) {
            return ProjectionEffect.Ignored("The consent result does not match the pending request.")
        }
        if (state.deadlineAtElapsedMs == null || atElapsedMs >= state.deadlineAtElapsedMs) {
            return ProjectionEffect.Ignored("The consent result arrived after its deadline.")
        }
        return null
    }

    private fun idleState(generation: Long, atElapsedMs: Long) = ProjectionState(
        lifecycle = ProjectionLifecycle.IDLE,
        generation = generation,
        consentRequestId = null,
        projectionSessionId = null,
        phaseStartedAtElapsedMs = atElapsedMs,
        deadlineAtElapsedMs = null,
        failureReason = null,
    )

    private fun requireTimestamp(value: Long) {
        require(value >= 0) { "MediaProjection timestamps must be non-negative." }
    }

    private fun requireUuid(value: String, label: String) {
        require(runCatching { UUID.fromString(value) }.isSuccess) { "$label must be a UUID." }
    }

    private fun boundedReason(value: String): String {
        val normalized = value
            .replace(Regex("[\\r\\n\\u0000]+"), " ")
            .replace(Regex("\\s{2,}"), " ")
            .trim()
        return when {
            normalized.isEmpty() -> "MediaProjection failed without a diagnostic."
            normalized.length <= 512 -> normalized
            else -> normalized.take(511) + "…"
        }
    }
}
