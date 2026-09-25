package com.sovereign.runtime.android.screen

internal fun interface ScreenCaptureRequester {
    suspend fun capture(): ScreenCaptureResult
}
