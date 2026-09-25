package com.sovereign.runtime.android.notification

import android.os.SystemClock
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

internal object AndroidNotificationRuntime : AndroidNotificationRuntimeView {
    val policyRegistry = NotificationContentPolicyRegistry()
    val registry = NotificationSnapshotRegistry(
        clock = NotificationElapsedClock { SystemClock.elapsedRealtime() },
    )
    val readFacade = NotificationReadFacade(this)

    private val mutableConnected = MutableStateFlow(false)
    val connected: StateFlow<Boolean> = mutableConnected.asStateFlow()

    @Volatile
    private var errorCode: String? = null

    fun connected() {
        mutableConnected.value = true
        errorCode = null
    }

    fun disconnected(reasonCode: String) {
        mutableConnected.value = false
        errorCode = boundedErrorCode(reasonCode)
        registry.invalidate()
    }

    fun failed(error: Throwable) {
        mutableConnected.value = false
        errorCode = "NOTIFICATION_LISTENER_${error::class.java.simpleName.uppercase()}"
            .take(MAXIMUM_ERROR_CODE_CHARACTERS)
        registry.invalidate()
    }

    fun invalidate() {
        registry.invalidate()
    }

    override fun listenerConnected(): Boolean = mutableConnected.value

    override fun policyRevision(): Long = policyRegistry.current().revision

    override fun snapshot(): NotificationSnapshot? = registry.current()

    override fun lastErrorCode(): String? = errorCode

    private fun boundedErrorCode(value: String): String {
        val normalized = value
            .trim()
            .uppercase()
            .replace(ERROR_CODE_CHARACTERS, "_")
            .trim('_')
            .take(MAXIMUM_ERROR_CODE_CHARACTERS)
        return normalized.ifEmpty { "NOTIFICATION_LISTENER_UNAVAILABLE" }
    }

    private const val MAXIMUM_ERROR_CODE_CHARACTERS = 128
    private val ERROR_CODE_CHARACTERS = Regex("[^A-Z0-9_]+")
}
