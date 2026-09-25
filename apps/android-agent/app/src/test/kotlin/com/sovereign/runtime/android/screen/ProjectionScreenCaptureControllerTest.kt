package com.sovereign.runtime.android.screen

import com.sovereign.runtime.android.runtime.AuthorityProfile
import com.sovereign.runtime.android.surface.ActiveSurface
import com.sovereign.runtime.android.surface.ActiveSurfaceRegistry
import com.sovereign.runtime.android.surface.SensitiveSurfaceCategory
import com.sovereign.runtime.android.surface.SensitiveSurfacePolicy
import com.sovereign.runtime.android.surface.SurfaceElapsedClock
import java.util.UUID
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

internal class ProjectionScreenCaptureControllerTest {
    private var now = 1_000L
    private val sessionId = UUID.randomUUID().toString()
    private val state = activeProjection(sessionId)

    @Test
    fun validLocalProjectionPublishesOneBoundedArtifactThroughExistingRegistry() = runTest {
        val surfaceRegistry = activeSurfaceRegistry()
        val surface = surfaceRegistry.observe("com.example.notes", 7)
        val frameBytes = byteArrayOf(1, 2, 3, 4)
        val source = FakeProjectionFrameSource(
            state = state,
            result = ProjectionFrameResult.Success(
                ProjectionFrame(
                    generation = state.generation,
                    projectionSessionId = sessionId,
                    width = 1,
                    height = 1,
                    mimeType = "image/png",
                    bytes = frameBytes,
                ),
            ),
        )
        val captures = ScreenCaptureRegistry(
            clock = ScreenElapsedClock { now },
        )
        val leases = leaseRegistry()
        val controller = controller(
            surfaceProvider = surfaceRegistry::current,
            source = source,
            leases = leases,
            captures = captures,
        )

        val result = controller.capture()

        assertTrue(result is ScreenCaptureResult.Success)
        result as ScreenCaptureResult.Success
        assertEquals(surface.revision, result.artifact.revision)
        assertEquals(surface.packageName, result.artifact.packageName)
        assertEquals(surface.windowId, result.artifact.windowId)
        assertEquals(1, source.calls)
        assertEquals(0, leases.pendingCount())
        assertEquals(state.generation, source.lastLease?.projectionGeneration)
        assertEquals(sessionId, source.lastLease?.projectionSessionId)
        assertEquals(surface.packageName, source.lastLease?.foregroundPackage)
        assertEquals(surface.revision, source.lastLease?.foregroundWindowEpoch)
        assertNotNull(captures.metadata())
        result.artifact.bytes[0] = 9
        assertEquals(1, captures.read(result.artifact.captureId)?.bytes?.first()?.toInt())
    }

    @Test
    fun sensitiveSurfaceIsDeniedBeforeLeaseOrFrameProduction() = runTest {
        val surfaceRegistry = activeSurfaceRegistry()
        surfaceRegistry.observe("com.example.authenticator", 7)
        val source = successfulSource()
        val leases = leaseRegistry()
        val controller = controller(
            surfaceProvider = surfaceRegistry::current,
            source = source,
            leases = leases,
            captures = captureRegistry(),
            surfacePolicy = SensitiveSurfacePolicy(
                mapOf(
                    "com.example.authenticator" to
                        SensitiveSurfaceCategory.AUTHENTICATOR,
                ),
            ),
        )

        val result = controller.capture()

        assertTrue(result is ScreenCaptureResult.Failure)
        result as ScreenCaptureResult.Failure
        assertEquals(ScreenCaptureStatus.DENIED, result.failure.status)
        assertEquals("secret_bearing_application", result.failure.reasonCode)
        assertEquals(0, source.calls)
        assertEquals(0, leases.pendingCount())
    }

    @Test
    fun leaseSurfaceMismatchIsConsumedAndNeverReachesFrameSource() = runTest {
        val first = ActiveSurface(
            revision = 1,
            packageName = "com.example.notes",
            windowId = 7,
            observedAtElapsedMs = now,
        )
        val changed = first.copy(
            revision = 2,
            packageName = "com.example.other",
            windowId = 8,
        )
        var reads = 0
        val source = successfulSource()
        val leases = leaseRegistry()
        val controller = controller(
            surfaceProvider = {
                reads += 1
                if (reads == 1) first else changed
            },
            source = source,
            leases = leases,
            captures = captureRegistry(),
        )

        val result = controller.capture()

        assertTrue(result is ScreenCaptureResult.Failure)
        result as ScreenCaptureResult.Failure
        assertEquals("capture_package_mismatch", result.failure.reasonCode)
        assertEquals(0, source.calls)
        assertEquals(0, leases.pendingCount())
    }

    @Test
    fun postCaptureSurfaceChangeZeroesFrameAndPublishesNothing() = runTest {
        val surfaceRegistry = activeSurfaceRegistry()
        surfaceRegistry.observe("com.example.notes", 7)
        val frameBytes = byteArrayOf(5, 6, 7, 8)
        val source = FakeProjectionFrameSource(
            state = state,
            result = ProjectionFrameResult.Success(
                ProjectionFrame(
                    generation = state.generation,
                    projectionSessionId = sessionId,
                    width = 1,
                    height = 1,
                    mimeType = "image/png",
                    bytes = frameBytes,
                ),
            ),
            beforeReturn = {
                surfaceRegistry.observe("com.example.other", 8)
            },
        )
        val captures = captureRegistry()
        val controller = controller(
            surfaceProvider = surfaceRegistry::current,
            source = source,
            leases = leaseRegistry(),
            captures = captures,
        )

        val result = controller.capture()

        assertTrue(result is ScreenCaptureResult.Failure)
        result as ScreenCaptureResult.Failure
        assertEquals("surface_changed", result.failure.reasonCode)
        assertTrue(frameBytes.all { it == 0.toByte() })
        assertNull(captures.metadata())
    }

    @Test
    fun projectionSessionChangeZeroesFrameAndPublishesNothing() = runTest {
        val surfaceRegistry = activeSurfaceRegistry()
        surfaceRegistry.observe("com.example.notes", 7)
        val frameBytes = byteArrayOf(9, 8, 7, 6)
        var binding = binding(successfulSource(frameBytes))
        val captures = captureRegistry()
        val controller = ProjectionScreenCaptureController(
            authorityProvider = { AuthorityProfile.OBSERVE },
            projectionBindingProvider = { binding },
            projectionStateProvider = { binding.state },
            activeSurfaceProvider = surfaceRegistry::current,
            surfacePolicy = SensitiveSurfacePolicy(),
            capturePolicy = ScreenCapturePolicy(),
            leaseRegistry = leaseRegistry(),
            captureRegistry = captures,
            elapsedClock = ScreenElapsedClock { now },
            captureIdFactory = { UUID.randomUUID().toString() },
            afterFrameCaptured = {
                val nextState = activeProjection(UUID.randomUUID().toString()).copy(
                    generation = state.generation + 1,
                )
                binding = ProjectionCaptureBinding(
                    state = nextState,
                    source = successfulSource(sourceState = nextState),
                )
            },
        )

        val result = controller.capture()

        assertTrue(result is ScreenCaptureResult.Failure)
        result as ScreenCaptureResult.Failure
        assertEquals("projection_session_changed", result.failure.reasonCode)
        assertTrue(frameBytes.all { it == 0.toByte() })
        assertNull(captures.metadata())
    }

    @Test
    fun activeStateWithoutFrameOwnershipFailsClosed() = runTest {
        val surfaceRegistry = activeSurfaceRegistry()
        surfaceRegistry.observe("com.example.notes", 7)
        val controller = ProjectionScreenCaptureController(
            authorityProvider = { AuthorityProfile.OBSERVE },
            projectionBindingProvider = { null },
            projectionStateProvider = { state },
            activeSurfaceProvider = surfaceRegistry::current,
            surfacePolicy = SensitiveSurfacePolicy(),
            capturePolicy = ScreenCapturePolicy(),
            leaseRegistry = leaseRegistry(),
            captureRegistry = captureRegistry(),
            elapsedClock = ScreenElapsedClock { now },
            captureIdFactory = { UUID.randomUUID().toString() },
        )

        val result = controller.capture()

        assertTrue(result is ScreenCaptureResult.Failure)
        result as ScreenCaptureResult.Failure
        assertEquals("projection_frame_source_unavailable", result.failure.reasonCode)
    }

    private fun controller(
        surfaceProvider: () -> ActiveSurface?,
        source: FakeProjectionFrameSource,
        leases: ScreenCaptureLeaseRegistry,
        captures: ScreenCaptureRegistry,
        surfacePolicy: SensitiveSurfacePolicy = SensitiveSurfacePolicy(),
    ): ProjectionScreenCaptureController = ProjectionScreenCaptureController(
        authorityProvider = { AuthorityProfile.OBSERVE },
        projectionBindingProvider = { binding(source) },
        projectionStateProvider = { state },
        activeSurfaceProvider = surfaceProvider,
        surfacePolicy = surfacePolicy,
        capturePolicy = ScreenCapturePolicy(),
        leaseRegistry = leases,
        captureRegistry = captures,
        elapsedClock = ScreenElapsedClock { now },
        captureIdFactory = { UUID.randomUUID().toString() },
    )

    private fun binding(source: ProjectionFrameSource): ProjectionCaptureBinding =
        ProjectionCaptureBinding(state = state, source = source)

    private fun successfulSource(
        bytes: ByteArray = byteArrayOf(1, 2, 3, 4),
        sourceState: ProjectionState = state,
    ): FakeProjectionFrameSource = FakeProjectionFrameSource(
        state = sourceState,
        result = ProjectionFrameResult.Success(
            ProjectionFrame(
                generation = sourceState.generation,
                projectionSessionId = sourceState.projectionSessionId!!,
                width = 1,
                height = 1,
                mimeType = "image/png",
                bytes = bytes,
            ),
        ),
    )

    private fun leaseRegistry(): ScreenCaptureLeaseRegistry = ScreenCaptureLeaseRegistry(
        clock = ScreenCaptureElapsedClock { now },
        leaseIdFactory = { UUID.randomUUID().toString() },
        leaseLifetimeMs = 5_000,
    )

    private fun captureRegistry(): ScreenCaptureRegistry = ScreenCaptureRegistry(
        clock = ScreenElapsedClock { now },
    )

    private fun activeSurfaceRegistry(): ActiveSurfaceRegistry = ActiveSurfaceRegistry(
        clock = SurfaceElapsedClock { now },
    )

    private fun activeProjection(projectionSessionId: String): ProjectionState = ProjectionState(
        lifecycle = ProjectionLifecycle.ACTIVE,
        generation = 3,
        consentRequestId = null,
        projectionSessionId = projectionSessionId,
        phaseStartedAtElapsedMs = 100,
        deadlineAtElapsedMs = null,
        failureReason = null,
    )

    private class FakeProjectionFrameSource(
        state: ProjectionState,
        private val result: ProjectionFrameResult,
        private val beforeReturn: () -> Unit = {},
    ) : ProjectionFrameSource {
        override val generation: Long = state.generation
        override val projectionSessionId: String = state.projectionSessionId!!
        var calls = 0
        var lastLease: ScreenCaptureLease? = null
        var closed = false

        override fun dimensions(): ProjectionFrameDimensions =
            ProjectionFrameDimensions(width = 1, height = 1)

        override suspend fun capture(lease: ScreenCaptureLease): ProjectionFrameResult {
            calls += 1
            lastLease = lease
            beforeReturn()
            return result
        }

        override fun close() {
            closed = true
        }
    }
}
