package com.sovereign.runtime.android.screen

import com.sovereign.runtime.android.runtime.AuthorityProfile
import com.sovereign.runtime.android.surface.ActiveSurface
import com.sovereign.runtime.android.surface.AndroidSurfaceRuntime
import com.sovereign.runtime.android.surface.SensitiveSurfacePolicy
import java.util.UUID
import kotlinx.coroutines.CancellationException

internal class ProjectionScreenCaptureController(
    private val authorityProvider: () -> AuthorityProfile,
    private val projectionBindingProvider: () -> ProjectionCaptureBinding? =
        ScreenProjectionRuntime::activeCaptureBinding,
    private val projectionStateProvider: () -> ProjectionState =
        ScreenProjectionRuntime::state,
    private val activeSurfaceProvider: () -> ActiveSurface? =
        AndroidSurfaceRuntime.activeSurface::current,
    private val surfacePolicy: SensitiveSurfacePolicy = AndroidSurfaceRuntime.policy,
    private val capturePolicy: ScreenCapturePolicy = ScreenCapturePolicy(),
    private val leaseRegistry: ScreenCaptureLeaseRegistry =
        ScreenProjectionRuntime.captureLeases,
    private val captureRegistry: ScreenCaptureRegistry =
        AndroidSurfaceRuntime.screenCaptures,
    private val elapsedClock: ScreenElapsedClock =
        ScreenElapsedClock { android.os.SystemClock.elapsedRealtime() },
    private val captureIdFactory: () -> String = { UUID.randomUUID().toString() },
    private val afterFrameCaptured: () -> Unit = {},
) : ScreenCaptureRequester {
    override suspend fun capture(): ScreenCaptureResult {
        val binding = projectionBindingProvider() ?: return failure(
            ScreenCaptureStatus.FAILED,
            "projection_frame_source_unavailable",
            "The active MediaProjection session has no valid in-process frame source.",
        )
        val before = activeSurfaceProvider() ?: return failure(
            ScreenCaptureStatus.FAILED,
            "surface_unavailable",
            "Observe an active Android window before requesting a screenshot.",
        )
        val surfaceDecision = surfacePolicy.decide(before.packageName)
        if (!surfaceDecision.screenshotAllowed) {
            return failure(
                ScreenCaptureStatus.DENIED,
                surfaceDecision.reasonCode,
                "Screenshots are disabled for the current sensitive application surface.",
            )
        }
        val captureDecision = capturePolicy.decide(
            ScreenCapturePolicyContext(
                authorityProfile = authorityProvider(),
                sensitivity = ScreenSensitivity.NORMAL,
                foregroundPackageAllowed = surfaceDecision.screenshotAllowed,
                projectionActive = true,
                localConsentSurfaceAvailable = true,
            ),
        )
        if (captureDecision.effect != ScreenCapturePolicyEffect.ALLOW) {
            return failure(
                ScreenCaptureStatus.DENIED,
                captureDecision.reasonCode,
                captureDecision.explanation,
            )
        }
        val dimensions = try {
            binding.source.dimensions()
        } catch (_: IllegalArgumentException) {
            return failure(
                ScreenCaptureStatus.FAILED,
                "projection_dimensions_invalid",
                "The active MediaProjection dimensions are outside the capture limits.",
            )
        } catch (_: IllegalStateException) {
            return failure(
                ScreenCaptureStatus.FAILED,
                "projection_frame_source_unavailable",
                "The active MediaProjection frame source is unavailable.",
            )
        }
        val lease = try {
            leaseRegistry.issue(
                projectionState = binding.state,
                request = ScreenCaptureLeaseRequest(
                    projectionGeneration = binding.state.generation,
                    projectionSessionId = binding.source.projectionSessionId,
                    foregroundPackage = before.packageName,
                    foregroundWindowEpoch = before.revision,
                    width = dimensions.width,
                    height = dimensions.height,
                ),
            )
        } catch (_: IllegalArgumentException) {
            return failure(
                ScreenCaptureStatus.FAILED,
                "projection_capture_lease_rejected",
                "The MediaProjection capture lease did not match active ownership.",
            )
        } catch (_: IllegalStateException) {
            return failure(
                ScreenCaptureStatus.FAILED,
                "projection_capture_lease_unavailable",
                "A bounded MediaProjection capture lease could not be issued.",
            )
        }
        val atConsumption = activeSurfaceProvider()
        if (atConsumption == null) {
            leaseRegistry.discard(lease.leaseId)
            return failure(
                ScreenCaptureStatus.FAILED,
                "surface_unavailable",
                "The active Android surface disappeared before capture.",
            )
        }
        val resolution = leaseRegistry.consume(
            leaseId = lease.leaseId,
            projectionState = projectionStateProvider(),
            foregroundPackage = atConsumption.packageName,
            foregroundWindowEpoch = atConsumption.revision,
        )
        val consumed = when (resolution) {
            is ScreenCaptureLeaseResolution.Consumed -> resolution.lease
            is ScreenCaptureLeaseResolution.Rejected -> return failure(
                ScreenCaptureStatus.FAILED,
                resolution.reasonCode,
                resolution.explanation,
            )
        }
        val frameResult = try {
            binding.source.capture(consumed)
        } catch (error: CancellationException) {
            throw error
        } catch (_: Throwable) {
            return failure(
                ScreenCaptureStatus.FAILED,
                "projection_frame_failed",
                "The MediaProjection frame failed during bounded in-memory capture.",
            )
        }
        if (frameResult is ProjectionFrameResult.Failure) {
            return ScreenCaptureResult.Failure(frameResult.failure)
        }
        frameResult as ProjectionFrameResult.Success
        val frame = frameResult.frame
        if (
            frame.generation != consumed.projectionGeneration ||
            frame.projectionSessionId != consumed.projectionSessionId ||
            frame.width != consumed.width ||
            frame.height != consumed.height
        ) {
            frame.zeroize()
            return failure(
                ScreenCaptureStatus.FAILED,
                "projection_frame_identity_mismatch",
                "The MediaProjection frame did not match its one-time capture lease.",
            )
        }
        afterFrameCaptured()
        val after = activeSurfaceProvider()
        if (
            after == null ||
            after.revision != before.revision ||
            after.packageName != before.packageName ||
            after.windowId != before.windowId
        ) {
            frame.zeroize()
            return failure(
                ScreenCaptureStatus.FAILED,
                "surface_changed",
                "The active Android surface changed while the screenshot was being captured.",
            )
        }
        val currentBinding = projectionBindingProvider()
        if (
            currentBinding == null ||
            currentBinding.state.generation != binding.state.generation ||
            currentBinding.state.projectionSessionId != binding.state.projectionSessionId ||
            currentBinding.source !== binding.source
        ) {
            frame.zeroize()
            return failure(
                ScreenCaptureStatus.FAILED,
                "projection_session_changed",
                "The MediaProjection ownership changed while the screenshot was being captured.",
            )
        }
        val artifact = try {
            ScreenCaptureArtifact(
                captureId = captureIdFactory(),
                revision = before.revision,
                packageName = before.packageName,
                windowId = before.windowId,
                capturedAtElapsedMs = elapsedClock.nowElapsedMs(),
                width = frame.width,
                height = frame.height,
                mimeType = frame.mimeType,
                bytes = frame.bytes,
                sha256 = secureSha256(frame.bytes),
            )
        } catch (_: IllegalArgumentException) {
            frame.zeroize()
            return failure(
                ScreenCaptureStatus.FAILED,
                "projection_frame_invalid",
                "The MediaProjection frame failed bounded artifact validation.",
            )
        }
        val responseArtifact = try {
            artifact.copy(bytes = artifact.bytes.copyOf())
        } catch (_: Throwable) {
            artifact.bytes.fill(0)
            return failure(
                ScreenCaptureStatus.FAILED,
                "projection_result_copy_failed",
                "The MediaProjection result could not be copied within memory limits.",
            )
        }
        return try {
            captureRegistry.publish(artifact)
            ScreenCaptureResult.Success(responseArtifact)
        } catch (_: Throwable) {
            responseArtifact.bytes.fill(0)
            artifact.bytes.fill(0)
            captureRegistry.invalidate()
            failure(
                ScreenCaptureStatus.FAILED,
                "projection_publish_failed",
                "The MediaProjection frame could not be published in process memory.",
            )
        }
    }

    private fun failure(
        status: ScreenCaptureStatus,
        reasonCode: String,
        explanation: String,
    ): ScreenCaptureResult.Failure = ScreenCaptureResult.Failure(
        ScreenCaptureFailure(status, reasonCode, explanation),
    )
}
