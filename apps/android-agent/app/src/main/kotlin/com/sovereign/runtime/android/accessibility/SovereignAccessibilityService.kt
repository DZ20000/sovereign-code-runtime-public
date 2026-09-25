package com.sovereign.runtime.android.accessibility

import android.accessibilityservice.AccessibilityService
import android.view.accessibility.AccessibilityEvent
import com.sovereign.runtime.android.SovereignAndroidApplication
import com.sovereign.runtime.android.screen.AccessibilityServiceLocator
import com.sovereign.runtime.android.surface.AndroidSurfaceRuntime

class SovereignAccessibilityService : AccessibilityService() {
    private val runtime
        get() = SovereignAndroidApplication.from(this).runtime

    override fun onServiceConnected() {
        AccessibilityServiceLocator.attach(this)
        super.onServiceConnected()
        runtime.serviceRegistry.connect(this)
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        val sovereignSurfaceRoot = rootInActiveWindow
        val sovereignSurfacePackage = sovereignSurfaceRoot?.packageName?.toString()
            ?: event?.packageName?.toString()
        if (sovereignSurfaceRoot != null && sovereignSurfacePackage != null) {
            runCatching {
                AndroidSurfaceRuntime.activeSurface.observe(
                    packageName = sovereignSurfacePackage,
                    windowId = sovereignSurfaceRoot.windowId,
                )
            }.onFailure {
                AndroidSurfaceRuntime.invalidateTransientState()
            }
        } else {
            AndroidSurfaceRuntime.invalidateTransientState()
        }
        if (event == null || invalidatesSnapshot(event.eventType)) {
            runtime.invalidateSnapshot(
                "Accessibility event invalidated the current UI revision.",
            )
        }
    }

    override fun onInterrupt() {
        runtime.invalidateSnapshot("Accessibility service was interrupted.")
    }

    override fun onDestroy() {
        AccessibilityServiceLocator.detach(this)
        AndroidSurfaceRuntime.invalidateTransientState()
        runtime.serviceRegistry.disconnect(this)
        super.onDestroy()
    }

    private fun invalidatesSnapshot(eventType: Int): Boolean = when (eventType) {
        AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED,
        AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED,
        AccessibilityEvent.TYPE_WINDOWS_CHANGED,
        AccessibilityEvent.TYPE_VIEW_SCROLLED,
        AccessibilityEvent.TYPE_VIEW_TEXT_CHANGED,
        AccessibilityEvent.TYPE_VIEW_CLICKED,
        AccessibilityEvent.TYPE_VIEW_FOCUSED,
        -> true
        else -> false
    }
}
