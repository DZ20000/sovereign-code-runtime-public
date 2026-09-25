package com.sovereign.runtime.android.screen

import android.accessibilityservice.AccessibilityService
import android.graphics.Bitmap
import android.hardware.HardwareBuffer
import android.os.Build
import android.view.Display
import androidx.annotation.RequiresApi
import androidx.core.graphics.scale
import com.sovereign.runtime.android.surface.AndroidSurfaceRuntime
import java.io.ByteArrayOutputStream
import java.util.UUID
import java.util.concurrent.Executor
import kotlin.coroutines.resume
import kotlinx.coroutines.suspendCancellableCoroutine

internal class AccessibilityScreenshotController(
    private val serviceProvider: () -> AccessibilityService? = AccessibilityServiceLocator::current,
    private val captureRegistry: ScreenCaptureRegistry = AndroidSurfaceRuntime.screenCaptures,
) : ScreenCaptureRequester {
    override suspend fun capture(): ScreenCaptureResult {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            return failure(
                ScreenCaptureStatus.UNSUPPORTED,
                "android_api_unsupported",
                "Accessibility screenshots require Android 11 or newer.",
            )
        }
        val service = serviceProvider() ?: return failure(
            ScreenCaptureStatus.FAILED,
            "accessibility_service_unavailable",
            "The Accessibility service is not connected.",
        )
        val before = AndroidSurfaceRuntime.activeSurface.current() ?: return failure(
            ScreenCaptureStatus.FAILED,
            "surface_unavailable",
            "Observe an active Android window before requesting a screenshot.",
        )
        val policy = AndroidSurfaceRuntime.policy.decide(before.packageName)
        if (!policy.screenshotAllowed) {
            return failure(
                ScreenCaptureStatus.DENIED,
                policy.reasonCode,
                "Screenshots are disabled for the current sensitive application surface.",
            )
        }
        val raw = captureApi30(service)
        if (raw is ScreenCaptureResult.Failure) return raw
        raw as RawScreenshotResult
        val after = AndroidSurfaceRuntime.activeSurface.current()
        if (
            after == null ||
            after.revision != before.revision ||
            after.packageName != before.packageName ||
            after.windowId != before.windowId
        ) {
            raw.bytes.fill(0)
            return failure(
                ScreenCaptureStatus.FAILED,
                "surface_changed",
                "The active Android surface changed while the screenshot was being captured.",
            )
        }
        val artifact = ScreenCaptureArtifact(
            captureId = UUID.randomUUID().toString(),
            revision = before.revision,
            packageName = before.packageName,
            windowId = before.windowId,
            capturedAtElapsedMs = android.os.SystemClock.elapsedRealtime(),
            width = raw.width,
            height = raw.height,
            mimeType = raw.mimeType,
            bytes = raw.bytes,
            sha256 = secureSha256(raw.bytes),
        )
        captureRegistry.publish(artifact)
        return ScreenCaptureResult.Success(artifact.copy(bytes = artifact.bytes.copyOf()))
    }

    @RequiresApi(Build.VERSION_CODES.R)
    private suspend fun captureApi30(
        service: AccessibilityService,
    ): Any = suspendCancellableCoroutine { continuation ->
        val executor = Executor { runnable -> service.mainExecutor.execute(runnable) }
        service.takeScreenshot(
            Display.DEFAULT_DISPLAY,
            executor,
            object : AccessibilityService.TakeScreenshotCallback {
                override fun onSuccess(screenshot: AccessibilityService.ScreenshotResult) {
                    if (!continuation.isActive) {
                        screenshot.hardwareBuffer.close()
                        return
                    }
                    continuation.resume(encodeScreenshot(screenshot))
                }

                override fun onFailure(errorCode: Int) {
                    if (!continuation.isActive) return
                    continuation.resume(mapScreenshotFailure(errorCode))
                }
            },
        )
    }

    @RequiresApi(Build.VERSION_CODES.R)
    private fun encodeScreenshot(
        screenshot: AccessibilityService.ScreenshotResult,
    ): Any {
        val hardwareBuffer: HardwareBuffer = screenshot.hardwareBuffer
        return try {
            val hardwareBitmap = Bitmap.wrapHardwareBuffer(
                hardwareBuffer,
                screenshot.colorSpace,
            ) ?: return failure(
                ScreenCaptureStatus.FAILED,
                "hardware_buffer_unavailable",
                "Android did not expose a readable screenshot buffer.",
            )
            val source = try {
                hardwareBitmap.copy(Bitmap.Config.ARGB_8888, false)
                    ?: return failure(
                        ScreenCaptureStatus.FAILED,
                        "bitmap_copy_failed",
                        "Android screenshot pixels could not be copied into app memory.",
                    )
            } finally {
                hardwareBitmap.recycle()
            }
            source.useSafely { bitmap ->
                val bounded = boundBitmap(bitmap)
                try {
                    val output = ByteArrayOutputStream()
                    if (!bounded.compress(Bitmap.CompressFormat.PNG, 100, output)) {
                        return failure(
                            ScreenCaptureStatus.FAILED,
                            "screenshot_encode_failed",
                            "The screenshot could not be encoded.",
                        )
                    }
                    val bytes = output.toByteArray()
                    if (bytes.isEmpty() || bytes.size > ScreenCaptureArtifact.MAX_ENCODED_BYTES) {
                        bytes.fill(0)
                        return failure(
                            ScreenCaptureStatus.FAILED,
                            "screenshot_too_large",
                            "The encoded screenshot exceeds the in-memory safety limit.",
                        )
                    }
                    RawScreenshotResult(
                        width = bounded.width,
                        height = bounded.height,
                        mimeType = "image/png",
                        bytes = bytes,
                    )
                } finally {
                    if (bounded !== bitmap) bounded.recycle()
                }
            }
        } catch (_: SecurityException) {
            failure(
                ScreenCaptureStatus.SECURE_WINDOW,
                "secure_window",
                "Android blocked screenshot access for the current secure window.",
            )
        } catch (_: Throwable) {
            failure(
                ScreenCaptureStatus.FAILED,
                "screenshot_processing_failed",
                "The screenshot failed during bounded in-memory processing.",
            )
        } finally {
            hardwareBuffer.close()
        }
    }

    private fun boundBitmap(source: Bitmap): Bitmap {
        val pixels = source.width.toLong() * source.height.toLong()
        if (pixels <= ScreenCaptureArtifact.MAX_PIXELS) return source
        val scale = kotlin.math.sqrt(
            ScreenCaptureArtifact.MAX_PIXELS.toDouble() / pixels.toDouble(),
        )
        val width = (source.width * scale).toInt().coerceAtLeast(1)
        val height = (source.height * scale).toInt().coerceAtLeast(1)
        return source.scale(width, height)
    }

    private fun mapScreenshotFailure(errorCode: Int): ScreenCaptureResult.Failure {
        val secureWindowCode = if (
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE
        ) {
            AccessibilityService.ERROR_TAKE_SCREENSHOT_SECURE_WINDOW
        } else {
            Int.MIN_VALUE
        }
        return if (errorCode == secureWindowCode) {
            failure(
                ScreenCaptureStatus.SECURE_WINDOW,
                "secure_window",
                "Android blocked screenshot access for the current secure window.",
            )
        } else {
            failure(
                ScreenCaptureStatus.FAILED,
                "android_screenshot_error",
                "Android rejected the screenshot request with error code $errorCode.",
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

    private data class RawScreenshotResult(
        val width: Int,
        val height: Int,
        val mimeType: String,
        val bytes: ByteArray,
    )

    private inline fun <T> Bitmap.useSafely(block: (Bitmap) -> T): T = try {
        block(this)
    } finally {
        recycle()
    }
}


