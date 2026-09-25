package com.sovereign.runtime.android.notification

internal data class SanitizedNotificationText(
    val title: String?,
    val text: String?,
    val subText: String?,
    val redacted: Boolean,
    val reasonCode: String?,
)

internal class NotificationTextSanitizer(
    private val maximumFieldCharacters: Int = 1_024,
) {
    init {
        require(maximumFieldCharacters in 64..4_096) {
            "maximumFieldCharacters is outside its allowed range."
        }
    }

    fun sanitize(draft: NotificationDraft, ref: String): NotificationRecord {
        val sanitized = sanitizeText(
            title = draft.title,
            text = draft.text,
            subText = draft.subText,
            sensitivity = draft.sensitivity,
        )
        return NotificationRecord(
            ref = ref,
            packageName = draft.packageName,
            postedAtEpochMs = draft.postedAtEpochMs,
            title = sanitized.title,
            text = sanitized.text,
            subText = sanitized.subText,
            category = normalize(draft.category, 128),
            ongoing = draft.ongoing,
            clearable = draft.clearable,
            hasContentIntent = draft.hasContentIntent,
            actionCount = draft.actionCount,
            redacted = sanitized.redacted,
            redactionReason = sanitized.reasonCode,
        )
    }

    fun sanitizeText(
        title: CharSequence?,
        text: CharSequence?,
        subText: CharSequence?,
        sensitivity: NotificationSensitivity,
    ): SanitizedNotificationText {
        if (sensitivity != NotificationSensitivity.NORMAL) {
            val reason = when (sensitivity) {
                NotificationSensitivity.AUTHENTICATOR -> "authenticator_notification"
                NotificationSensitivity.PASSWORD_MANAGER -> "password_manager_notification"
                NotificationSensitivity.BANKING_OR_PAYMENT -> "banking_or_payment_notification"
                NotificationSensitivity.SENSITIVE -> "sensitive_notification"
                NotificationSensitivity.NORMAL -> error("unreachable")
            }
            return SanitizedNotificationText(
                title = "[REDACTED_NOTIFICATION]",
                text = null,
                subText = null,
                redacted = true,
                reasonCode = reason,
            )
        }

        val normalizedTitle = normalize(title, maximumFieldCharacters)
        val normalizedText = normalize(text, maximumFieldCharacters)
        val normalizedSubText = normalize(subText, maximumFieldCharacters)
        val context = listOfNotNull(normalizedTitle, normalizedText, normalizedSubText)
            .joinToString(separator = " ")
        if (OTP_CONTEXT.containsMatchIn(context) && OTP_DIGITS.containsMatchIn(context)) {
            return SanitizedNotificationText(
                title = normalizedTitle?.let(::redactOtp),
                text = normalizedText?.let(::redactOtp),
                subText = normalizedSubText?.let(::redactOtp),
                redacted = true,
                reasonCode = "one_time_code",
            )
        }
        return SanitizedNotificationText(
            title = normalizedTitle,
            text = normalizedText,
            subText = normalizedSubText,
            redacted = false,
            reasonCode = null,
        )
    }

    private fun redactOtp(value: String): String = OTP_DIGITS.replace(value, "[REDACTED_OTP]")

    private fun normalize(value: CharSequence?, maximumCharacters: Int): String? {
        val normalized = value
            ?.toString()
            ?.replace(CONTROL_CHARACTERS, " ")
            ?.replace(REPEATED_WHITESPACE, " ")
            ?.trim()
            ?.take(maximumCharacters)
            .orEmpty()
        return normalized.ifEmpty { null }
    }

    private companion object {
        val CONTROL_CHARACTERS = Regex("[\\r\\n\\u0000-\\u001f\\u007f]+")
        val REPEATED_WHITESPACE = Regex("\\s{2,}")
        val OTP_CONTEXT = Regex(
            "(?i)(otp|one[- ]?time|verification|verify|security code|login code|验证码|校验码|动态码|一次性密码)",
        )
        val OTP_DIGITS = Regex("(?<!\\d)\\d{4,8}(?!\\d)")
    }
}
