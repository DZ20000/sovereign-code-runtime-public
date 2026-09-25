package com.sovereign.runtime.android.accessibility

import android.accessibilityservice.AccessibilityService
import java.lang.ref.WeakReference
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

class AccessibilityServiceUnavailableException(
    message: String,
) : IllegalStateException(message)

class AccessibilityServiceRegistry(
    private val snapshotRegistry: UiSnapshotRegistry,
) {
    private val lock = Any()
    private var serviceReference = WeakReference<AccessibilityService>(null)
    private val mutableConnected = MutableStateFlow(false)

    val connected: StateFlow<Boolean> = mutableConnected.asStateFlow()

    fun connect(service: AccessibilityService) {
        synchronized(lock) {
            serviceReference = WeakReference(service)
            mutableConnected.value = true
            snapshotRegistry.invalidate("Accessibility service connected.")
        }
    }

    fun disconnect(service: AccessibilityService) {
        synchronized(lock) {
            if (serviceReference.get() === service) {
                serviceReference.clear()
                serviceReference = WeakReference(null)
                mutableConnected.value = false
                snapshotRegistry.invalidate("Accessibility service disconnected.")
            }
        }
    }

    fun requireService(): AccessibilityService = synchronized(lock) {
        serviceReference.get() ?: throw AccessibilityServiceUnavailableException(
            "Sovereign Accessibility is not connected. Enable it in Android Accessibility settings.",
        )
    }
}
