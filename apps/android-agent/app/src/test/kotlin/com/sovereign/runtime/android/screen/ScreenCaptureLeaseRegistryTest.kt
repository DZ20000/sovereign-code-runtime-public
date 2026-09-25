package com.sovereign.runtime.android.screen

import java.util.UUID
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

internal class ScreenCaptureLeaseRegistryTest {
    private var now = 1_000L
    private var nextId = 1
    private val registry = ScreenCaptureLeaseRegistry(
        clock = ScreenCaptureElapsedClock { now },
        leaseIdFactory = {
            UUID.nameUUIDFromBytes("lease-${nextId++}".toByteArray()).toString()
        },
        leaseLifetimeMs = 100,
        maximumPendingLeases = 2,
    )

    @Test
    fun leaseIsBoundToProjectionPackageWindowAndSingleConsumption() {
        val projection = activeProjection()
        val lease = registry.issue(
            projection,
            ScreenCaptureLeaseRequest(
                projectionGeneration = projection.generation,
                projectionSessionId = projection.projectionSessionId!!,
                foregroundPackage = "com.example.app",
                foregroundWindowEpoch = 7,
                width = 1080,
                height = 2400,
            ),
        )
        assertEquals(1, registry.pendingCount())
        val consumed = registry.consume(
            leaseId = lease.leaseId,
            projectionState = projection,
            foregroundPackage = "com.example.app",
            foregroundWindowEpoch = 7,
        )
        assertTrue(consumed is ScreenCaptureLeaseResolution.Consumed)
        assertEquals(0, registry.pendingCount())
        assertRejected(
            "capture_lease_unknown_or_consumed",
            registry.consume(
                lease.leaseId,
                projection,
                "com.example.app",
                7,
            ),
        )
    }

    @Test
    fun mismatchConsumesAndRejectsLeaseSoItCannotBeRetriedOnAnotherSurface() {
        val projection = activeProjection()
        val packageLease = issue(projection)
        assertRejected(
            "capture_package_mismatch",
            registry.consume(
                packageLease.leaseId,
                projection,
                "com.other.app",
                packageLease.foregroundWindowEpoch,
            ),
        )
        assertRejected(
            "capture_lease_unknown_or_consumed",
            registry.consume(
                packageLease.leaseId,
                projection,
                packageLease.foregroundPackage,
                packageLease.foregroundWindowEpoch,
            ),
        )

        val windowLease = issue(projection)
        assertRejected(
            "capture_window_epoch_mismatch",
            registry.consume(
                windowLease.leaseId,
                projection,
                windowLease.foregroundPackage,
                windowLease.foregroundWindowEpoch + 1,
            ),
        )

        val sessionLease = issue(projection)
        val changedProjection = projection.copy(
            generation = projection.generation + 1,
            projectionSessionId = UUID.randomUUID().toString(),
        )
        assertRejected(
            "projection_session_mismatch",
            registry.consume(
                sessionLease.leaseId,
                changedProjection,
                sessionLease.foregroundPackage,
                sessionLease.foregroundWindowEpoch,
            ),
        )
    }

    @Test
    fun expiryAndClockRegressionFailClosed() {
        val projection = activeProjection()
        val expired = issue(projection)
        now = expired.expiresAtElapsedMs
        assertRejected(
            "capture_lease_expired",
            registry.consume(
                expired.leaseId,
                projection,
                expired.foregroundPackage,
                expired.foregroundWindowEpoch,
            ),
        )

        now = 2_000
        val regressed = issue(projection)
        now = regressed.issuedAtElapsedMs - 1
        assertRejected(
            "capture_lease_expired",
            registry.consume(
                regressed.leaseId,
                projection,
                regressed.foregroundPackage,
                regressed.foregroundWindowEpoch,
            ),
        )
    }

    @Test
    fun pendingLimitAndInvalidationAreBounded() {
        val projection = activeProjection()
        issue(projection)
        issue(projection)
        val error = runCatching { issue(projection) }.exceptionOrNull()
        assertTrue(error is IllegalStateException)
        registry.invalidateAll()
        assertEquals(0, registry.pendingCount())
    }

    @Test
    fun issueRequiresExactActiveProjection() {
        val projection = activeProjection()
        val request = ScreenCaptureLeaseRequest(
            projectionGeneration = projection.generation,
            projectionSessionId = projection.projectionSessionId!!,
            foregroundPackage = "com.example.app",
            foregroundWindowEpoch = 7,
            width = 1080,
            height = 2400,
        )
        val idleError = runCatching {
            registry.issue(projection.copy(lifecycle = ProjectionLifecycle.IDLE), request)
        }.exceptionOrNull()
        assertTrue(idleError is IllegalArgumentException)
        val generationError = runCatching {
            registry.issue(
                projection,
                request.copy(projectionGeneration = projection.generation + 1),
            )
        }.exceptionOrNull()
        assertTrue(generationError is IllegalArgumentException)
    }

    private fun issue(projection: ProjectionState): ScreenCaptureLease = registry.issue(
        projection,
        ScreenCaptureLeaseRequest(
            projectionGeneration = projection.generation,
            projectionSessionId = projection.projectionSessionId!!,
            foregroundPackage = "com.example.app",
            foregroundWindowEpoch = 7,
            width = 1080,
            height = 2400,
        ),
    )

    private fun activeProjection(): ProjectionState = ProjectionState(
        lifecycle = ProjectionLifecycle.ACTIVE,
        generation = 3,
        consentRequestId = null,
        projectionSessionId = UUID.randomUUID().toString(),
        phaseStartedAtElapsedMs = 100,
        deadlineAtElapsedMs = null,
        failureReason = null,
    )

    private fun assertRejected(
        reason: String,
        resolution: ScreenCaptureLeaseResolution,
    ) {
        assertTrue(resolution is ScreenCaptureLeaseResolution.Rejected)
        assertEquals(
            reason,
            (resolution as ScreenCaptureLeaseResolution.Rejected).reasonCode,
        )
    }
}
