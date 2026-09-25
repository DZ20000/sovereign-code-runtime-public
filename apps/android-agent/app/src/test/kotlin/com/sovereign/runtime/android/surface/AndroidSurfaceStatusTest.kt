package com.sovereign.runtime.android.surface

import com.sovereign.runtime.android.screen.ScreenCaptureMetadata
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AndroidSurfaceStatusTest {
    @Test
    fun reportsCurrentSurfaceAndNeverClaimsRootOrShizuku() {
        val capture = ScreenCaptureMetadata(
            captureId = "8c418b6a-3e57-49b6-a46e-4456ca667ee0",
            revision = 9,
            packageName = "com.example.notes",
            windowId = 3,
            capturedAtElapsedMs = 1_000,
            width = 1080,
            height = 2400,
            mimeType = "image/png",
            byteLength = 4_096,
            sha256 = "a".repeat(64),
        )
        val status = AndroidSurfaceStatus(
            accessibilityConnected = true,
            screenshotApiSupported = true,
            notificationListenerConnected = true,
            activePackageName = "com.example.notes",
            activeWindowId = 3,
            activeSurfaceRevision = 7,
            activeSurfaceCategory = "normal",
            screenshotAllowedForActiveSurface = true,
            surfaceReasonCode = "normal_application",
            notificationSnapshotRevision = "notifications_4_abcdefghijklmnop",
            notificationCount = 2,
            currentCapture = capture,
        )

        assertEquals(ANDROID_SURFACE_STATUS_SCHEMA_VERSION, status.schemaVersion)
        assertEquals("com.example.notes", status.activePackageName)
        assertEquals(capture, status.currentCapture)
        assertFalse(status.shizukuImplemented)
        assertFalse(status.rootImplemented)
    }

    @Test
    fun missingSurfaceRemainsExplicitWithoutInventedMetadata() {
        val status = AndroidSurfaceStatus(
            accessibilityConnected = false,
            screenshotApiSupported = false,
            notificationListenerConnected = false,
            activePackageName = null,
            activeWindowId = null,
            activeSurfaceRevision = null,
            activeSurfaceCategory = null,
            screenshotAllowedForActiveSurface = null,
            surfaceReasonCode = null,
            notificationSnapshotRevision = null,
            notificationCount = 0,
            currentCapture = null,
        )

        assertNull(status.activePackageName)
        assertNull(status.currentCapture)
        assertEquals(0, status.notificationCount)
    }

    @Test
    fun partialActiveSurfaceMetadataFailsClosed() {
        val error = runCatching {
            AndroidSurfaceStatus(
                accessibilityConnected = true,
                screenshotApiSupported = true,
                notificationListenerConnected = false,
                activePackageName = "com.example.notes",
                activeWindowId = null,
                activeSurfaceRevision = 7,
                activeSurfaceCategory = "normal",
                screenshotAllowedForActiveSurface = true,
                surfaceReasonCode = "normal_application",
                notificationSnapshotRevision = null,
                notificationCount = 0,
                currentCapture = null,
            )
        }.exceptionOrNull()

        assertTrue(error is IllegalArgumentException)
    }
}
