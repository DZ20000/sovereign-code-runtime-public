package com.sovereign.runtime.android.gateway

import com.sovereign.runtime.android.screen.ScreenCaptureMetadata
import com.sovereign.runtime.android.screen.ScreenCaptureRegistry
import com.sovereign.runtime.android.screen.ScreenCaptureResult
import com.sovereign.runtime.android.screen.ScreenCaptureStatus
import com.sovereign.runtime.android.surface.AndroidSurfaceRuntime
import io.modelcontextprotocol.kotlin.sdk.types.CallToolResult
import java.util.UUID
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

internal object AndroidSurfaceToolContract {
    const val SCREEN_CAPTURE = "android.screen.capture"
    const val SCREEN_READ = "android.screen.read"

    val readOnlyTools = setOf(SCREEN_CAPTURE)
}

internal data class AndroidMcpImagePayload(
    val mimeType: String,
    val bytes: ByteArray,
    val sha256: String,
)

internal data class AndroidSurfaceToolResult(
    val structured: JsonObject,
    val image: AndroidMcpImagePayload? = null,
)

/**
 * Sanitized bridge between transient screen artifacts and the MCP registration
 * layer. Public notification reads use NotificationReadFacade instead of this
 * screen-artifact bridge. SCREEN_READ remains an unregistered internal contract.
 */
internal class AndroidSurfaceToolFacade(
    private val screenRegistry: ScreenCaptureRegistry,
) {
    fun captureScreen(result: ScreenCaptureResult): AndroidSurfaceToolResult = when (result) {
        is ScreenCaptureResult.Success -> AndroidSurfaceToolResult(
            structured = screenMetadataJson(result.artifact.metadata()),
        )
        is ScreenCaptureResult.Failure -> AndroidSurfaceToolResult(
            structured = buildJsonObject {
                put("schemaVersion", "sar.screen-capture/v1")
                put("ok", false)
                put("status", result.failure.status.name.lowercase())
                put("reasonCode", result.failure.reasonCode)
                put("explanation", result.failure.explanation)
            },
        )
    }

    fun readScreen(captureId: String): AndroidSurfaceToolResult {
        require(runCatching { UUID.fromString(captureId) }.isSuccess) {
            "captureId must be a UUID."
        }
        val artifact = screenRegistry.read(captureId)
            ?: return AndroidSurfaceToolResult(
                structured = buildJsonObject {
                    put("schemaVersion", "sar.screen-read/v1")
                    put("ok", false)
                    put("reasonCode", "capture_missing_or_expired")
                },
            )
        return try {
            AndroidSurfaceToolResult(
                structured = buildJsonObject {
                    put("schemaVersion", "sar.screen-read/v1")
                    put("ok", true)
                    put("capture", screenMetadataJson(artifact.metadata()))
                },
                image = AndroidMcpImagePayload(
                    mimeType = artifact.mimeType,
                    bytes = artifact.bytes.copyOf(),
                    sha256 = artifact.sha256,
                ),
            )
        } finally {
            artifact.bytes.fill(0)
        }
    }

    private fun screenMetadataJson(metadata: ScreenCaptureMetadata): JsonObject = buildJsonObject {
        put("schemaVersion", "sar.screen-capture/v1")
        put("ok", true)
        put("captureId", metadata.captureId)
        put("revision", metadata.revision)
        put("packageName", metadata.packageName)
        put("windowId", metadata.windowId)
        put("capturedAtElapsedMs", metadata.capturedAtElapsedMs)
        put("width", metadata.width)
        put("height", metadata.height)
        put("mimeType", metadata.mimeType)
        put("byteLength", metadata.byteLength)
        put("sha256", metadata.sha256)
        put("pixelDeliveryAvailable", false)
    }
}

internal object AndroidSurfaceMcpFacade {
    private val facade = AndroidSurfaceToolFacade(
        screenRegistry = AndroidSurfaceRuntime.screenCaptures,
    )

    fun captureScreenJson(result: ScreenCaptureResult): JsonObject =
        facade.captureScreen(result).structured

    fun readScreen(captureId: String): AndroidSurfaceToolResult =
        facade.readScreen(captureId)
}

internal fun screenCaptureMcpResult(result: ScreenCaptureResult): CallToolResult = when (result) {
    is ScreenCaptureResult.Success -> try {
        toolSuccess(AndroidSurfaceMcpFacade.captureScreenJson(result))
    } finally {
        result.artifact.bytes.fill(0)
    }
    is ScreenCaptureResult.Failure -> toolFailure(
        code = when (result.failure.status) {
            ScreenCaptureStatus.DENIED -> "SCREEN_CAPTURE_DENIED"
            ScreenCaptureStatus.SECURE_WINDOW -> "SCREEN_CAPTURE_SECURE_WINDOW"
            ScreenCaptureStatus.UNSUPPORTED -> "SCREEN_CAPTURE_UNSUPPORTED"
            ScreenCaptureStatus.FAILED -> "SCREEN_CAPTURE_FAILED"
            ScreenCaptureStatus.READY -> error(
                "A screen capture failure cannot use READY status.",
            )
        },
        message = result.failure.explanation,
    )
}
