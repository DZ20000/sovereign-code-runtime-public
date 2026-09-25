package com.sovereign.runtime.android.screen

import java.util.UUID
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ScreenCaptureRegistryTest {
    @Test
    fun keepsOnlyOneRevisionBoundArtifactAndReturnsCopies() {
        var now = 1_000L
        val registry = ScreenCaptureRegistry(
            clock = ScreenElapsedClock { now },
            maximumAgeMs = 100,
        )
        val first = artifact(byteArrayOf(1, 2, 3), revision = 1, now = now)
        registry.publish(first)
        val read = registry.read(first.captureId)!!
        assertEquals(first.metadata(), read.metadata())
        read.bytes[0] = 9
        assertEquals(1, registry.read(first.captureId)!!.bytes[0].toInt())

        val second = artifact(byteArrayOf(4, 5, 6), revision = 2, now = now)
        registry.publish(second)
        assertNull(registry.read(first.captureId))
        assertTrue(first.bytes.all { it == 0.toByte() })

        now += 101
        assertNull(registry.metadata())
        assertTrue(second.bytes.all { it == 0.toByte() })
    }

    @Test(expected = IllegalArgumentException::class)
    fun artifactRejectsDigestMismatch() {
        ScreenCaptureArtifact(
            captureId = UUID.randomUUID().toString(),
            revision = 1,
            packageName = "com.example.app",
            windowId = 1,
            capturedAtElapsedMs = 1,
            width = 1,
            height = 1,
            mimeType = "image/png",
            bytes = byteArrayOf(1),
            sha256 = "0".repeat(64),
        )
    }

    private fun artifact(bytes: ByteArray, revision: Long, now: Long) = ScreenCaptureArtifact(
        captureId = UUID.randomUUID().toString(),
        revision = revision,
        packageName = "com.example.app",
        windowId = 1,
        capturedAtElapsedMs = now,
        width = 1,
        height = 1,
        mimeType = "image/png",
        bytes = bytes,
        sha256 = secureSha256(bytes),
    )
}
