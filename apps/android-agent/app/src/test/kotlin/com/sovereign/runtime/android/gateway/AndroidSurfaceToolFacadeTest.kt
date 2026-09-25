package com.sovereign.runtime.android.gateway

import com.sovereign.runtime.android.screen.ScreenCaptureArtifact
import com.sovereign.runtime.android.screen.ScreenCaptureFailure
import com.sovereign.runtime.android.screen.ScreenCaptureRegistry
import com.sovereign.runtime.android.screen.ScreenCaptureResult
import com.sovereign.runtime.android.screen.ScreenCaptureStatus
import com.sovereign.runtime.android.screen.ScreenElapsedClock
import com.sovereign.runtime.android.screen.secureSha256
import java.util.UUID
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AndroidSurfaceToolFacadeTest {
    @Test
    fun captureReturnsMetadataWhileInternalReadReturnsOneBoundedImageCopy() {
        val bytes = byteArrayOf(1, 2, 3, 4)
        val screenRegistry = ScreenCaptureRegistry(
            clock = ScreenElapsedClock { 1_000L },
        )
        val artifact = ScreenCaptureArtifact(
            captureId = UUID.randomUUID().toString(),
            revision = 3,
            packageName = "com.example.app",
            windowId = 7,
            capturedAtElapsedMs = 1_000L,
            width = 1,
            height = 1,
            mimeType = "image/png",
            bytes = bytes,
            sha256 = secureSha256(bytes),
        )
        screenRegistry.publish(artifact)
        val facade = AndroidSurfaceToolFacade(screenRegistry)

        val successResult = ScreenCaptureResult.Success(
            artifact.copy(bytes = artifact.bytes.copyOf()),
        )
        val capture = facade.captureScreen(successResult)
        assertNull(capture.image)
        assertTrue(capture.structured.toString().contains(artifact.captureId))
        assertTrue(capture.structured.toString().contains("\"pixelDeliveryAvailable\":false"))
        assertFalse(capture.structured.toString().contains("readTool"))
        assertFalse(capture.structured.toString().contains("AQIDBA"))
        assertFalse(screenCaptureMcpResult(successResult).isError == true)
        assertTrue(successResult.artifact.bytes.all { it == 0.toByte() })

        val read = facade.readScreen(artifact.captureId)
        assertNotNull(read.image)
        assertEquals(artifact.sha256, read.image?.sha256)
        assertEquals(bytes.toList(), read.image?.bytes?.toList())
        read.image!!.bytes[0] = 9
        assertEquals(1, screenRegistry.read(artifact.captureId)!!.bytes[0].toInt())
    }

    @Test
    fun deniedCaptureAndMissingArtifactFailClosedWithoutPixels() {
        val facade = AndroidSurfaceToolFacade(
            ScreenCaptureRegistry(clock = ScreenElapsedClock { 1_000L }),
        )
        val deniedResult = ScreenCaptureResult.Failure(
            ScreenCaptureFailure(
                ScreenCaptureStatus.DENIED,
                "secret_surface",
                "Screenshots are denied.",
            ),
        )
        val failure = facade.captureScreen(deniedResult)
        assertNull(failure.image)
        assertTrue(failure.structured.toString().contains("secret_surface"))
        val mcpFailure = screenCaptureMcpResult(deniedResult)
        assertTrue(mcpFailure.isError == true)
        assertTrue(
            mcpFailure.structuredContent.toString().contains("SCREEN_CAPTURE_DENIED"),
        )

        val missing = facade.readScreen(UUID.randomUUID().toString())
        assertNull(missing.image)
        assertTrue(missing.structured.toString().contains("capture_missing_or_expired"))
    }
}
