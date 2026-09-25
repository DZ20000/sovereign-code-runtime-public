package com.sovereign.runtime.android.screen

import java.util.UUID
import kotlin.math.min
import kotlin.math.sqrt

internal data class ProjectionFrameDimensions(
    val width: Int,
    val height: Int,
) {
    init {
        require(width in 1..8_192 && height in 1..8_192) {
            "MediaProjection frame dimensions exceed their limits."
        }
        require(width.toLong() * height.toLong() <= ScreenCaptureArtifact.MAX_PIXELS) {
            "MediaProjection frame pixel count exceeds its limit."
        }
    }
}

internal data class ProjectionFrame(
    val generation: Long,
    val projectionSessionId: String,
    val width: Int,
    val height: Int,
    val mimeType: String,
    val bytes: ByteArray,
) {
    init {
        require(generation >= 1) {
            "MediaProjection frame generation must be positive."
        }
        require(runCatching { UUID.fromString(projectionSessionId) }.isSuccess) {
            "MediaProjection frame session ID must be a UUID."
        }
        ProjectionFrameDimensions(width, height)
        require(mimeType == "image/png") {
            "MediaProjection frames must use bounded PNG encoding."
        }
        require(bytes.isNotEmpty() && bytes.size <= ScreenCaptureArtifact.MAX_ENCODED_BYTES) {
            "MediaProjection frame byte length exceeds its limit."
        }
    }

    fun zeroize() {
        bytes.fill(0)
    }
}

internal sealed interface ProjectionFrameResult {
    data class Success(val frame: ProjectionFrame) : ProjectionFrameResult
    data class Failure(val failure: ScreenCaptureFailure) : ProjectionFrameResult
}

internal interface ProjectionFrameSource : AutoCloseable {
    val generation: Long
    val projectionSessionId: String

    fun dimensions(): ProjectionFrameDimensions

    suspend fun capture(lease: ScreenCaptureLease): ProjectionFrameResult

    override fun close()
}

internal data class ProjectionCaptureBinding(
    val state: ProjectionState,
    val source: ProjectionFrameSource,
) {
    init {
        require(state.lifecycle == ProjectionLifecycle.ACTIVE) {
            "A projection capture binding requires an active session."
        }
        require(state.generation == source.generation) {
            "Projection capture source generation does not match ownership."
        }
        require(state.projectionSessionId == source.projectionSessionId) {
            "Projection capture source session does not match ownership."
        }
    }
}

internal fun boundProjectionFrameDimensions(
    width: Int,
    height: Int,
): ProjectionFrameDimensions {
    require(width in 1..65_535 && height in 1..65_535) {
        "MediaProjection source dimensions are invalid."
    }
    val pixels = width.toLong() * height.toLong()
    val dimensionScale = min(
        1.0,
        min(8_192.0 / width.toDouble(), 8_192.0 / height.toDouble()),
    )
    val pixelScale = if (pixels <= ScreenCaptureArtifact.MAX_PIXELS) {
        1.0
    } else {
        sqrt(ScreenCaptureArtifact.MAX_PIXELS.toDouble() / pixels.toDouble())
    }
    val scale = min(dimensionScale, pixelScale)
    return ProjectionFrameDimensions(
        width = (width * scale).toInt().coerceAtLeast(1),
        height = (height * scale).toInt().coerceAtLeast(1),
    )
}

internal fun projectionPixelIsVisible(argb: Int): Boolean {
    val alpha = argb ushr 24 and 0xff
    val red = argb ushr 16 and 0xff
    val green = argb ushr 8 and 0xff
    val blue = argb and 0xff
    return alpha >= 16 && (red >= 16 || green >= 16 || blue >= 16)
}

internal fun projectionFrameHasVisibleInterior(
    pixels: IntArray,
    width: Int,
    height: Int,
): Boolean {
    val dimensions = ProjectionFrameDimensions(width, height)
    require(pixels.size == dimensions.width * dimensions.height) {
        "MediaProjection pixel buffer size does not match its dimensions."
    }
    val horizontalInset = width / 10
    val verticalInset = height / 10
    val left = horizontalInset.coerceAtMost(width - 1)
    val top = verticalInset.coerceAtMost(height - 1)
    val right = (width - horizontalInset).coerceAtLeast(left + 1)
    val bottom = (height - verticalInset).coerceAtLeast(top + 1)
    for (y in top until bottom) {
        val rowOffset = y * width
        for (x in left until right) {
            if (projectionPixelIsVisible(pixels[rowOffset + x])) return true
        }
    }
    return false
}
