package com.sovereign.runtime.android.gateway

import com.sovereign.runtime.android.screen.ScreenCaptureMetadata
import com.sovereign.runtime.android.surface.AndroidSurfaceStatus
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AndroidSurfaceStatusJsonTest {
    @Test
    fun serializationIsBoundedExplicitAndContainsNoRawScreenshotBytes() {
        val status = AndroidSurfaceStatus(
            accessibilityConnected = true,
            screenshotApiSupported = true,
            notificationListenerConnected = true,
            activePackageName = "com.example.notes",
            activeWindowId = 4,
            activeSurfaceRevision = 11,
            activeSurfaceCategory = "normal",
            screenshotAllowedForActiveSurface = true,
            surfaceReasonCode = "normal_application",
            notificationSnapshotRevision = "notifications_9_abcdefghijklmnop",
            notificationCount = 3,
            currentCapture = ScreenCaptureMetadata(
                captureId = "8c418b6a-3e57-49b6-a46e-4456ca667ee0",
                revision = 11,
                packageName = "com.example.notes",
                windowId = 4,
                capturedAtElapsedMs = 1_000,
                width = 1080,
                height = 2400,
                mimeType = "image/png",
                byteLength = 8_192,
                sha256 = "b".repeat(64),
            ),
        )

        val json = status.toJson()
        assertEquals(
            "sar.surface-status/v1",
            (json.getValue("schemaVersion") as JsonPrimitive).content,
        )
        assertFalse((json.getValue("rootImplemented") as JsonPrimitive).content.toBoolean())
        assertFalse((json.getValue("shizukuImplemented") as JsonPrimitive).content.toBoolean())
        assertEquals(
            "notifications_9_abcdefghijklmnop",
            (json.getValue("notificationSnapshotRevision") as JsonPrimitive).content,
        )
        val capture = json.getValue("currentCapture") as JsonObject
        assertEquals("image/png", (capture.getValue("mimeType") as JsonPrimitive).content)
        assertEquals("8192", (capture.getValue("byteLength") as JsonPrimitive).content)
        val serialized = json.toString()
        assertFalse(serialized.contains("encodedBytes"))
        assertFalse(serialized.contains("AQID"))
    }

    @Test
    fun unavailableValuesRemainExplicitNulls() {
        val json = AndroidSurfaceStatus(
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
        ).toJson()

        assertTrue(json.getValue("activePackageName") is JsonNull)
        assertTrue(json.getValue("currentCapture") is JsonNull)
        assertTrue(json.getValue("notificationSnapshotRevision") is JsonNull)
    }
}
