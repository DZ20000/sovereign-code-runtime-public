package com.sovereign.runtime.android.screen

internal class ScreenCaptureRouter(
    private val projectionStateProvider: () -> ProjectionState,
    private val accessibilityRequester: ScreenCaptureRequester,
    private val projectionRequester: ScreenCaptureRequester,
) : ScreenCaptureRequester {
    override suspend fun capture(): ScreenCaptureResult =
        if (projectionStateProvider().lifecycle == ProjectionLifecycle.ACTIVE) {
            projectionRequester.capture()
        } else {
            accessibilityRequester.capture()
        }
}
