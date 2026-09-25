package com.sovereign.runtime.android.surface

import com.sovereign.runtime.android.screen.ScreenCaptureMetadata

const val ANDROID_SURFACE_STATUS_SCHEMA_VERSION = "sar.surface-status/v1"

data class AndroidSurfaceStatus(
    val schemaVersion: String = ANDROID_SURFACE_STATUS_SCHEMA_VERSION,
    val accessibilityConnected: Boolean,
    val screenshotApiSupported: Boolean,
    val notificationListenerConnected: Boolean,
    val activePackageName: String?,
    val activeWindowId: Int?,
    val activeSurfaceRevision: Long?,
    val activeSurfaceCategory: String?,
    val screenshotAllowedForActiveSurface: Boolean?,
    val surfaceReasonCode: String?,
    val notificationSnapshotRevision: String?,
    val notificationCount: Int,
    val currentCapture: ScreenCaptureMetadata?,
    val shizukuImplemented: Boolean = false,
    val rootImplemented: Boolean = false,
) {
    init {
        require(notificationCount >= 0) {
            "Android notification status count must be non-negative."
        }
        require(
            (activePackageName == null && activeWindowId == null &&
                activeSurfaceRevision == null && activeSurfaceCategory == null &&
                screenshotAllowedForActiveSurface == null && surfaceReasonCode == null) ||
                (activePackageName != null && activeWindowId != null &&
                    activeSurfaceRevision != null && activeSurfaceCategory != null &&
                    screenshotAllowedForActiveSurface != null && surfaceReasonCode != null),
        ) {
            "Android active-surface status fields must be all present or all absent."
        }
    }
}
