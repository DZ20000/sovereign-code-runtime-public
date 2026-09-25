package com.sovereign.runtime.android.screen

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

internal class ProjectionFrameSafetyTest {
    @Test
    fun dimensionsAreBoundedWithoutChangingAspectRatioMaterially() {
        val bounded = boundProjectionFrameDimensions(
            width = 12_000,
            height = 9_000,
        )

        assertTrue(bounded.width in 1..8_192)
        assertTrue(bounded.height in 1..8_192)
        assertTrue(
            bounded.width.toLong() * bounded.height.toLong() <=
                ScreenCaptureArtifact.MAX_PIXELS,
        )
        val sourceRatio = 12_000.0 / 9_000.0
        val boundedRatio = bounded.width.toDouble() / bounded.height.toDouble()
        assertTrue(kotlin.math.abs(sourceRatio - boundedRatio) < 0.01)
    }

    @Test
    fun blackOrTransparentInteriorFailsClosedButVisibleInteriorPasses() {
        val width = 20
        val height = 20
        val black = IntArray(width * height) { 0xff000000.toInt() }
        val transparent = IntArray(width * height)
        assertFalse(projectionFrameHasVisibleInterior(black, width, height))
        assertFalse(projectionFrameHasVisibleInterior(transparent, width, height))

        val borderOnly = black.copyOf()
        for (x in 0 until width) borderOnly[x] = 0xffffffff.toInt()
        assertFalse(projectionFrameHasVisibleInterior(borderOnly, width, height))

        val visible = black.copyOf()
        visible[(height / 2) * width + width / 2] = 0xff336699.toInt()
        assertTrue(projectionFrameHasVisibleInterior(visible, width, height))
    }
}
