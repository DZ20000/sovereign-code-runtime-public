package com.sovereign.runtime.android.screen

internal fun interface ScreenElapsedClock {
    fun nowElapsedMs(): Long
}

/** Keeps only one bounded screenshot in memory; a new capture invalidates the old ID. */
internal class ScreenCaptureRegistry(
    private val clock: ScreenElapsedClock,
    private val maximumAgeMs: Long = 15_000,
) {
    init {
        require(maximumAgeMs in 1..300_000) {
            "Screen capture maximum age is outside its limit."
        }
    }

    private var current: ScreenCaptureArtifact? = null

    @Synchronized
    fun publish(artifact: ScreenCaptureArtifact): ScreenCaptureMetadata {
        current?.bytes?.fill(0)
        current = artifact
        return artifact.metadata()
    }

    @Synchronized
    fun metadata(): ScreenCaptureMetadata? = current
        ?.takeIf(::isCurrent)
        ?.metadata()

    @Synchronized
    fun read(captureId: String): ScreenCaptureArtifact? {
        val artifact = current ?: return null
        if (!isCurrent(artifact) || captureId != artifact.captureId) return null
        return artifact.copy(bytes = artifact.bytes.copyOf())
    }

    @Synchronized
    fun invalidate() {
        current?.bytes?.fill(0)
        current = null
    }

    private fun isCurrent(artifact: ScreenCaptureArtifact): Boolean {
        val age = clock.nowElapsedMs() - artifact.capturedAtElapsedMs
        if (age < 0 || age > maximumAgeMs) {
            artifact.bytes.fill(0)
            current = null
            return false
        }
        return true
    }
}
