package com.sovereign.runtime.android.screen

import android.accessibilityservice.AccessibilityService
import java.lang.ref.WeakReference
import java.util.concurrent.atomic.AtomicReference

internal object AccessibilityServiceLocator {
    private val reference = AtomicReference<WeakReference<AccessibilityService>?>(null)

    fun attach(service: AccessibilityService) {
        reference.set(WeakReference(service))
    }

    fun detach(service: AccessibilityService) {
        val current = reference.get()?.get()
        if (current === service) {
            reference.set(null)
        }
    }

    fun current(): AccessibilityService? = reference.get()?.get()
}
