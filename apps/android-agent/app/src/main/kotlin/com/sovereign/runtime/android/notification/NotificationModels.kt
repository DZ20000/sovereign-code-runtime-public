package com.sovereign.runtime.android.notification

internal enum class NotificationSensitivity {
    NORMAL,
    SENSITIVE,
    AUTHENTICATOR,
    PASSWORD_MANAGER,
    BANKING_OR_PAYMENT,
}

internal data class NotificationDraft(
    val sourceKey: String,
    val packageName: String,
    val postedAtEpochMs: Long,
    val title: CharSequence?,
    val text: CharSequence?,
    val subText: CharSequence?,
    val category: String?,
    val ongoing: Boolean,
    val clearable: Boolean,
    val hasContentIntent: Boolean,
    val actionCount: Int,
    val sensitivity: NotificationSensitivity,
)

internal data class NotificationRecord(
    val ref: String,
    val packageName: String,
    val postedAtEpochMs: Long,
    val title: String?,
    val text: String?,
    val subText: String?,
    val category: String?,
    val ongoing: Boolean,
    val clearable: Boolean,
    val hasContentIntent: Boolean,
    val actionCount: Int,
    val redacted: Boolean,
    val redactionReason: String?,
)

internal data class NotificationSnapshot(
    val revision: Long,
    val nonce: String,
    val policyRevision: Long,
    val observedAtElapsedMs: Long,
    val records: List<NotificationRecord>,
)

internal data class NotificationTarget(
    val revision: Long,
    val ref: String,
    val packageName: String,
)

internal sealed interface NotificationTargetResolution {
    data class Resolved(
        val snapshot: NotificationSnapshot,
        val record: NotificationRecord,
        val sourceKey: String,
    ) : NotificationTargetResolution

    data class Rejected(
        val reasonCode: String,
        val explanation: String,
    ) : NotificationTargetResolution
}
