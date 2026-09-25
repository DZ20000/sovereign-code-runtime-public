package com.sovereign.runtime.android.approval

import java.util.UUID

const val ANDROID_APPROVAL_STATE_SCHEMA_VERSION = "sar.approval-state/v1"

private val PRINCIPAL_FINGERPRINT_PATTERN = Regex("^[a-f0-9]{16}$")
private val TOOL_NAME_PATTERN = Regex("^[a-z][a-z0-9_.-]{0,127}$")
private val SHA256_PATTERN = Regex("^[a-f0-9]{64}$")

enum class AndroidApprovalDecision {
    ALLOW_ONCE,
    DENY,
}

enum class AndroidApprovalResolutionReason {
    LOCAL_ALLOW,
    LOCAL_DENY,
    TIMEOUT,
    QUEUE_OVERFLOW,
    DUPLICATE_REQUEST,
    CANCELLED,
    GATEWAY_STOP,
}

data class AndroidApprovalRequestInput(
    val requestId: String,
    val principalFingerprint: String,
    val toolName: String,
    val title: String,
    val message: String,
    val detail: String,
    val argumentsSha256: String,
)

data class AndroidApprovalPresentation(
    val requestId: String,
    val principalFingerprint: String,
    val toolName: String,
    val title: String,
    val message: String,
    val detail: String,
    val argumentsSha256: String,
    val requestedAtElapsedMs: Long,
    val expiresAtElapsedMs: Long,
    val burstDetected: Boolean,
)

data class AndroidApprovalResult(
    val requestId: String,
    val decision: AndroidApprovalDecision,
    val reason: AndroidApprovalResolutionReason,
)

data class AndroidApprovalBrokerState(
    val schemaVersion: String = ANDROID_APPROVAL_STATE_SCHEMA_VERSION,
    val active: AndroidApprovalPresentation? = null,
    val queuedCount: Int = 0,
)

internal fun validateApprovalRequest(
    input: AndroidApprovalRequestInput,
): AndroidApprovalRequestInput {
    require(runCatching { UUID.fromString(input.requestId) }.isSuccess) {
        "Approval request ID must be a UUID."
    }
    require(PRINCIPAL_FINGERPRINT_PATTERN.matches(input.principalFingerprint)) {
        "Approval principal fingerprint has an invalid shape."
    }
    require(TOOL_NAME_PATTERN.matches(input.toolName)) {
        "Approval tool name has an invalid shape."
    }
    require(input.title.length in 1..128 && input.title == input.title.trim()) {
        "Approval title has an invalid shape."
    }
    require(input.message.length in 1..512 && input.message == input.message.trim()) {
        "Approval message has an invalid shape."
    }
    require(input.detail.length in 1..1_024 && input.detail == input.detail.trim()) {
        "Approval detail has an invalid shape."
    }
    require(SHA256_PATTERN.matches(input.argumentsSha256)) {
        "Approval argument digest has an invalid shape."
    }
    return input
}
