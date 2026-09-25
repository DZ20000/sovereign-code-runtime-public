package com.sovereign.runtime.android.screen

import java.util.UUID

internal data class ScreenCaptureLease(
    val leaseId: String,
    val projectionGeneration: Long,
    val projectionSessionId: String,
    val foregroundPackage: String,
    val foregroundWindowEpoch: Long,
    val width: Int,
    val height: Int,
    val issuedAtElapsedMs: Long,
    val expiresAtElapsedMs: Long,
)

internal data class ScreenCaptureLeaseRequest(
    val projectionGeneration: Long,
    val projectionSessionId: String,
    val foregroundPackage: String,
    val foregroundWindowEpoch: Long,
    val width: Int,
    val height: Int,
)

internal sealed interface ScreenCaptureLeaseResolution {
    data class Consumed(val lease: ScreenCaptureLease) : ScreenCaptureLeaseResolution
    data class Rejected(val reasonCode: String, val explanation: String) : ScreenCaptureLeaseResolution
}

internal fun interface ScreenCaptureElapsedClock {
    fun nowMs(): Long
}

internal class ScreenCaptureLeaseRegistry(
    private val clock: ScreenCaptureElapsedClock,
    private val leaseIdFactory: () -> String = { UUID.randomUUID().toString() },
    private val leaseLifetimeMs: Long = 5_000,
    private val maximumPendingLeases: Int = 8,
) {
    init {
        require(leaseLifetimeMs in 100..30_000) {
            "leaseLifetimeMs is outside its allowed range."
        }
        require(maximumPendingLeases in 1..64) {
            "maximumPendingLeases is outside its allowed range."
        }
    }

    private val pending = LinkedHashMap<String, ScreenCaptureLease>()

    @Synchronized
    fun issue(
        projectionState: ProjectionState,
        request: ScreenCaptureLeaseRequest,
    ): ScreenCaptureLease {
        require(projectionState.lifecycle == ProjectionLifecycle.ACTIVE) {
            "A capture lease requires an active MediaProjection session."
        }
        require(request.projectionGeneration == projectionState.generation) {
            "Capture lease generation does not match the active projection."
        }
        require(request.projectionSessionId == projectionState.projectionSessionId) {
            "Capture lease session does not match the active projection."
        }
        requirePackageName(request.foregroundPackage)
        require(request.foregroundWindowEpoch >= 0) {
            "Foreground window epoch must be non-negative."
        }
        require(request.width in 1..16_384 && request.height in 1..16_384) {
            "Capture dimensions exceed their allowed range."
        }
        removeExpired(clock.nowMs())
        check(pending.size < maximumPendingLeases) {
            "The pending screen-capture lease limit has been reached."
        }
        val issuedAt = clock.nowMs()
        require(issuedAt >= 0) { "Capture lease timestamp must be non-negative." }
        val expiresAt = issuedAt + leaseLifetimeMs
        check(expiresAt >= issuedAt) { "Capture lease deadline overflow." }
        val leaseId = leaseIdFactory()
        require(runCatching { UUID.fromString(leaseId) }.isSuccess) {
            "Capture lease ID must be a UUID."
        }
        check(!pending.containsKey(leaseId)) { "Capture lease ID was reused." }
        return ScreenCaptureLease(
            leaseId = leaseId,
            projectionGeneration = request.projectionGeneration,
            projectionSessionId = request.projectionSessionId,
            foregroundPackage = request.foregroundPackage,
            foregroundWindowEpoch = request.foregroundWindowEpoch,
            width = request.width,
            height = request.height,
            issuedAtElapsedMs = issuedAt,
            expiresAtElapsedMs = expiresAt,
        ).also { lease -> pending[leaseId] = lease }
    }

    @Synchronized
    fun consume(
        leaseId: String,
        projectionState: ProjectionState,
        foregroundPackage: String,
        foregroundWindowEpoch: Long,
    ): ScreenCaptureLeaseResolution {
        requirePackageName(foregroundPackage)
        require(foregroundWindowEpoch >= 0) {
            "Foreground window epoch must be non-negative."
        }
        val lease = pending.remove(leaseId)
            ?: return ScreenCaptureLeaseResolution.Rejected(
                reasonCode = "capture_lease_unknown_or_consumed",
                explanation = "The screen-capture lease does not exist or was already consumed.",
            )
        val now = clock.nowMs()
        if (now < lease.issuedAtElapsedMs || now >= lease.expiresAtElapsedMs) {
            return ScreenCaptureLeaseResolution.Rejected(
                reasonCode = "capture_lease_expired",
                explanation = "The screen-capture lease expired before use.",
            )
        }
        if (
            projectionState.lifecycle != ProjectionLifecycle.ACTIVE ||
            projectionState.generation != lease.projectionGeneration ||
            projectionState.projectionSessionId != lease.projectionSessionId
        ) {
            return ScreenCaptureLeaseResolution.Rejected(
                reasonCode = "projection_session_mismatch",
                explanation = "The MediaProjection session changed after the lease was issued.",
            )
        }
        if (foregroundPackage != lease.foregroundPackage) {
            return ScreenCaptureLeaseResolution.Rejected(
                reasonCode = "capture_package_mismatch",
                explanation = "The foreground package changed after the lease was issued.",
            )
        }
        if (foregroundWindowEpoch != lease.foregroundWindowEpoch) {
            return ScreenCaptureLeaseResolution.Rejected(
                reasonCode = "capture_window_epoch_mismatch",
                explanation = "The foreground window changed after the lease was issued.",
            )
        }
        return ScreenCaptureLeaseResolution.Consumed(lease)
    }

    @Synchronized
    fun discard(leaseId: String) {
        pending.remove(leaseId)
    }

    @Synchronized
    fun invalidateAll() {
        pending.clear()
    }

    @Synchronized
    fun pendingCount(): Int {
        removeExpired(clock.nowMs())
        return pending.size
    }

    private fun removeExpired(now: Long) {
        val iterator = pending.iterator()
        while (iterator.hasNext()) {
            val entry = iterator.next()
            if (now < entry.value.issuedAtElapsedMs || now >= entry.value.expiresAtElapsedMs) {
                iterator.remove()
            }
        }
    }

    private fun requirePackageName(value: String) {
        require(value.matches(Regex("^[A-Za-z0-9_.]{1,255}$"))) {
            "Foreground package name has an invalid shape."
        }
    }
}
