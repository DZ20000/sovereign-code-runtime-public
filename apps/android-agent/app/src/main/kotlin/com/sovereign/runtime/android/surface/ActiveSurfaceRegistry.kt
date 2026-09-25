package com.sovereign.runtime.android.surface

internal data class ActiveSurface(
    val revision: Long,
    val packageName: String,
    val windowId: Int,
    val observedAtElapsedMs: Long,
)

internal fun interface SurfaceElapsedClock {
    fun nowElapsedMs(): Long
}

internal class ActiveSurfaceRegistry(
    private val clock: SurfaceElapsedClock,
) {
    private var revision = 0L
    private var current: ActiveSurface? = null

    @Synchronized
    fun observe(packageName: String, windowId: Int): ActiveSurface {
        val normalized = packageName.trim().lowercase()
        require(Regex("^[a-z0-9_]+(?:\\.[a-z0-9_]+)+$").matches(normalized)) {
            "Active surface package has an invalid shape."
        }
        check(revision < Long.MAX_VALUE) { "Active surface revision limit reached." }
        revision += 1
        return ActiveSurface(
            revision = revision,
            packageName = normalized,
            windowId = windowId,
            observedAtElapsedMs = clock.nowElapsedMs(),
        ).also { current = it }
    }

    @Synchronized
    fun current(): ActiveSurface? = current

    @Synchronized
    fun invalidate() {
        current = null
    }
}
