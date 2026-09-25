package com.sovereign.runtime.android.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.sovereign.runtime.android.accessibility.AndroidUiAction
import com.sovereign.runtime.android.approval.AndroidApprovalDecision
import com.sovereign.runtime.android.approval.AndroidApprovalResolutionReason
import com.sovereign.runtime.android.gateway.McpGatewayConnectionConfig
import com.sovereign.runtime.android.gateway.McpGatewayPhase
import com.sovereign.runtime.android.runtime.AndroidAgentRuntime
import com.sovereign.runtime.android.runtime.AuthorityProfile
import com.sovereign.runtime.android.surface.AndroidSurfaceStatus
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

class MainViewModel(
    private val runtime: AndroidAgentRuntime,
) : ViewModel() {
    val serviceConnected = runtime.serviceRegistry.connected
    val notificationListenerConnected = runtime.notificationListenerConnected
    val profile = runtime.profile
    val snapshot = runtime.snapshots
    val status = runtime.status
    val approvalState = runtime.approvalBroker.state
    val auditState = runtime.auditLedger.state
    val gatewayState = runtime.gateway.state

    private val mutableConnectionConfig =
        MutableStateFlow<McpGatewayConnectionConfig?>(null)
    val connectionConfig: StateFlow<McpGatewayConnectionConfig?> =
        mutableConnectionConfig.asStateFlow()
    private var hideConnectionConfigJob: Job? = null

    init {
        viewModelScope.launch {
            gatewayState.collect { state ->
                if (state.phase != McpGatewayPhase.RUNNING) {
                    hideConnectionConfig()
                }
            }
        }
        verifyAuditLedger()
    }

    fun setProfile(profile: AuthorityProfile) {
        launchSafely {
            runtime.approvalBroker.cancelAll(
                AndroidApprovalResolutionReason.CANCELLED,
            )
            runtime.setProfile(profile)
        }
    }

    fun observe() {
        launchSafely { runtime.observe() }
    }

    fun surfaceStatus(): AndroidSurfaceStatus = runtime.surfaceStatus()

    fun click(ref: String) {
        launchWithRevision { revision -> runtime.click(revision, ref) }
    }

    fun longPress(ref: String) {
        launchWithRevision { revision -> runtime.longPress(revision, ref) }
    }

    fun setText(
        ref: String,
        text: String,
    ) {
        launchWithRevision { revision -> runtime.setText(revision, ref, text) }
    }

    fun globalBack() {
        launchWithRevision { revision ->
            runtime.globalAction(revision, AndroidUiAction.GLOBAL_BACK)
        }
    }

    fun globalHome() {
        launchWithRevision { revision ->
            runtime.globalAction(revision, AndroidUiAction.GLOBAL_HOME)
        }
    }

    fun globalRecents() {
        launchWithRevision { revision ->
            runtime.globalAction(revision, AndroidUiAction.GLOBAL_RECENTS)
        }
    }

    fun revealGatewayConnection() {
        launchSafely {
            val config = runtime.gateway.revealConnectionConfig()
            mutableConnectionConfig.value = config
            hideConnectionConfigJob?.cancel()
            hideConnectionConfigJob = viewModelScope.launch {
                delay(CONNECTION_CONFIG_REVEAL_MS)
                mutableConnectionConfig.value = null
            }
            runtime.reportStatus(
                "Local MCP connection configuration is visible for 30 seconds. " +
                    "Treat the Bearer header as a password.",
            )
        }
    }

    fun hideConnectionConfig() {
        hideConnectionConfigJob?.cancel()
        hideConnectionConfigJob = null
        mutableConnectionConfig.value = null
    }

    fun rotateGatewayCredential() {
        launchSafely {
            hideConnectionConfig()
            val fingerprint = runtime.gateway.rotateCredential()
            runtime.reportStatus(
                "Local MCP Bearer credential rotated. New fingerprint: $fingerprint.",
            )
        }
    }

    fun verifyAuditLedger() {
        launchSafely {
            runtime.auditLedger.verify()
        }
    }

    fun allowApproval(requestId: String) {
        resolveApproval(requestId, AndroidApprovalDecision.ALLOW_ONCE)
    }

    fun denyApproval(requestId: String) {
        resolveApproval(requestId, AndroidApprovalDecision.DENY)
    }

    fun reportError(error: Throwable) {
        runtime.reportError(error)
    }

    fun reportStatus(message: String) {
        runtime.reportStatus(message)
    }

    private fun resolveApproval(
        requestId: String,
        decision: AndroidApprovalDecision,
    ) {
        launchSafely {
            val resolved = runtime.approvalBroker.resolve(requestId, decision)
            if (!resolved) {
                throw IllegalStateException(
                    "This local approval is no longer active. Review the current request before responding.",
                )
            }
            runtime.reportStatus(
                if (decision == AndroidApprovalDecision.ALLOW_ONCE) {
                    "The Android tool was approved for one execution."
                } else {
                    "The Android tool was denied locally."
                },
            )
        }
    }

    private fun launchWithRevision(
        operation: suspend (revision: String) -> Unit,
    ) {
        val revision = snapshot.value?.revision
        if (revision == null) {
            runtime.reportError(
                IllegalStateException("Observe the current screen before acting."),
            )
            return
        }
        launchSafely { operation(revision) }
    }

    private fun launchSafely(operation: suspend () -> Unit) {
        viewModelScope.launch {
            try {
                operation()
            } catch (error: CancellationException) {
                throw error
            } catch (error: Throwable) {
                runtime.reportError(error)
            }
        }
    }

    override fun onCleared() {
        hideConnectionConfig()
        super.onCleared()
    }

    class Factory(
        private val runtime: AndroidAgentRuntime,
    ) : ViewModelProvider.Factory {
        @Suppress("UNCHECKED_CAST")
        override fun <T : ViewModel> create(modelClass: Class<T>): T {
            require(modelClass.isAssignableFrom(MainViewModel::class.java)) {
                "Unsupported ViewModel type: ${modelClass.name}"
            }
            return MainViewModel(runtime) as T
        }
    }

    companion object {
        private const val CONNECTION_CONFIG_REVEAL_MS = 30_000L
    }
}
