package com.sovereign.runtime.android.surface

import android.os.SystemClock
import com.sovereign.runtime.android.screen.ScreenCaptureRegistry
import com.sovereign.runtime.android.screen.ScreenElapsedClock

internal object AndroidSurfaceRuntime {
    val policy = SensitiveSurfacePolicy()
    val redactor = SurfaceTextRedactor()
    val activeSurface = ActiveSurfaceRegistry(
        clock = SurfaceElapsedClock { SystemClock.elapsedRealtime() },
    )
    val screenCaptures = ScreenCaptureRegistry(
        clock = ScreenElapsedClock { SystemClock.elapsedRealtime() },
    )

    fun invalidateTransientState() {
        activeSurface.invalidate()
        screenCaptures.invalidate()
    }
}
