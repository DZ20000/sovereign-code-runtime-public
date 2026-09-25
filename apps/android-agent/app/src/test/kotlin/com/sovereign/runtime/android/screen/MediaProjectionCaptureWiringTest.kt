package com.sovereign.runtime.android.screen

import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

internal class MediaProjectionCaptureWiringTest {
    @Test
    fun serviceOwnsOneFrameProducerAndRuntimeRoutesOnlyTheRegisteredCaptureTool() {
        val sourceRoot = locateSourceRoot()
        val service = sourceText(
            sourceRoot,
            "main/kotlin/com/sovereign/runtime/android/screen/ScreenProjectionForegroundService.kt",
        )
        val producer = sourceText(
            sourceRoot,
            "main/kotlin/com/sovereign/runtime/android/screen/MediaProjectionFrameProducer.kt",
        )
        val runtime = sourceText(
            sourceRoot,
            "main/kotlin/com/sovereign/runtime/android/runtime/AndroidAgentRuntime.kt",
        )
        val catalog = sourceText(
            sourceRoot,
            "main/kotlin/com/sovereign/runtime/android/gateway/AndroidToolCatalog.kt",
        )
        val server = sourceText(
            sourceRoot,
            "main/kotlin/com/sovereign/runtime/android/gateway/AndroidMcpToolServer.kt",
        )

        assertTrue(service.contains("MediaProjectionFrameProducer.create("))
        assertTrue(service.contains("frameSource = frameProducer"))
        assertTrue(service.contains("catch (_: OutOfMemoryError)"))
        assertTrue(service.contains("activation exceeded its memory limit"))
        assertEquals(1, literalCount(producer, ".createVirtualDisplay("))
        assertTrue(producer.contains("ImageReader.newInstance("))
        assertTrue(
            Regex(
                "VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,\\s+null,\\s+null,",
            ).containsMatchIn(producer),
        )
        assertEquals(
            1,
            literalCount(producer, "virtualDisplay.surface = imageReader.surface"),
        )
        assertTrue(producer.contains("virtualDisplay.surface = null"))
        assertTrue(producer.contains("withTimeoutOrNull("))
        assertTrue(producer.contains("FRAME_TIMEOUT_MS = 2_000L"))
        assertTrue(producer.contains("ScreenCaptureArtifact.MAX_ENCODED_BYTES"))
        assertTrue(producer.contains("projectionFrameHasVisibleInterior("))
        assertTrue(producer.contains("previous.fill(0)"))
        assertTrue(producer.contains("rowPixels?.fill(0)"))
        assertTrue(producer.contains("output.clear()"))
        assertTrue(runtime.contains("ScreenCaptureRouter("))
        assertTrue(runtime.contains("ProjectionScreenCaptureController("))
        assertFalse(catalog.contains("\"android.screen.read\""))
        assertFalse(server.contains("\"android.screen.read\""))
        assertTrue(server.contains("screenCaptureMcpResult(runtime.captureScreen())"))
    }

    private fun literalCount(source: String, value: String): Int =
        source.windowed(value.length).count { it == value }

    private fun sourceText(sourceRoot: Path, relativePath: String): String = String(
        Files.readAllBytes(sourceRoot.resolve(relativePath)),
        StandardCharsets.UTF_8,
    )

    private fun locateSourceRoot(): Path {
        var current = Path.of(System.getProperty("user.dir")).toAbsolutePath().normalize()
        repeat(8) {
            val direct = current.resolve("src")
            if (Files.exists(direct.resolve(
                    "main/kotlin/com/sovereign/runtime/android/runtime/AndroidAgentRuntime.kt",
                ))) {
                return direct
            }
            val module = current.resolve("app/src")
            if (Files.exists(module.resolve(
                    "main/kotlin/com/sovereign/runtime/android/runtime/AndroidAgentRuntime.kt",
                ))) {
                return module
            }
            current = current.parent ?: return@repeat
        }
        error("Could not locate Android app source root for MediaProjection wiring guard.")
    }
}
