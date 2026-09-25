package com.sovereign.runtime.android.screen

import java.util.UUID
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Test

internal class ScreenCaptureRouterTest {
    @Test
    fun inactiveProjectionUsesAccessibilityCapture() = runTest {
        val accessibility = FakeRequester(success(1))
        val projection = FakeRequester(success(2))
        val router = ScreenCaptureRouter(
            projectionStateProvider = { projectionState(ProjectionLifecycle.IDLE) },
            accessibilityRequester = accessibility,
            projectionRequester = projection,
        )

        assertSame(accessibility.result, router.capture())
        assertEquals(1, accessibility.calls)
        assertEquals(0, projection.calls)
    }

    @Test
    fun activeProjectionUsesProjectionWithoutAccessibilityFallback() = runTest {
        val accessibility = FakeRequester(success(1))
        val projectionFailure = ScreenCaptureResult.Failure(
            ScreenCaptureFailure(
                status = ScreenCaptureStatus.FAILED,
                reasonCode = "projection_frame_timeout",
                explanation = "The MediaProjection frame did not arrive before the timeout.",
            ),
        )
        val projection = FakeRequester(projectionFailure)
        val router = ScreenCaptureRouter(
            projectionStateProvider = { projectionState(ProjectionLifecycle.ACTIVE) },
            accessibilityRequester = accessibility,
            projectionRequester = projection,
        )

        assertSame(projectionFailure, router.capture())
        assertEquals(0, accessibility.calls)
        assertEquals(1, projection.calls)
    }

    private fun success(revision: Long): ScreenCaptureResult.Success {
        val bytes = byteArrayOf(revision.toByte())
        return ScreenCaptureResult.Success(
            ScreenCaptureArtifact(
                captureId = UUID.randomUUID().toString(),
                revision = revision,
                packageName = "com.example.notes",
                windowId = 7,
                capturedAtElapsedMs = 1_000,
                width = 1,
                height = 1,
                mimeType = "image/png",
                bytes = bytes,
                sha256 = secureSha256(bytes),
            ),
        )
    }

    private fun projectionState(lifecycle: ProjectionLifecycle): ProjectionState = ProjectionState(
        lifecycle = lifecycle,
        generation = 3,
        consentRequestId = null,
        projectionSessionId = if (lifecycle == ProjectionLifecycle.ACTIVE) {
            UUID.randomUUID().toString()
        } else {
            null
        },
        phaseStartedAtElapsedMs = 100,
        deadlineAtElapsedMs = null,
        failureReason = null,
    )

    private class FakeRequester(
        val result: ScreenCaptureResult,
    ) : ScreenCaptureRequester {
        var calls = 0

        override suspend fun capture(): ScreenCaptureResult {
            calls += 1
            return result
        }
    }
}
