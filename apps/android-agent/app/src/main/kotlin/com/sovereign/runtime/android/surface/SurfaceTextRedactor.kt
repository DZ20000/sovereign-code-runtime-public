package com.sovereign.runtime.android.surface

internal data class RedactedSurfaceText(
    val value: String?,
    val redacted: Boolean,
    val reasonCode: String?,
)

internal class SurfaceTextRedactor {
    fun redact(
        value: CharSequence?,
        metadataOnly: Boolean,
        password: Boolean = false,
        contextualLabel: CharSequence? = null,
    ): RedactedSurfaceText {
        if (value == null) return RedactedSurfaceText(null, false, null)
        if (metadataOnly) {
            return RedactedSurfaceText(null, true, "metadata_only_surface")
        }
        if (password) {
            return RedactedSurfaceText("[REDACTED_PASSWORD]", true, "password_field")
        }
        val bounded = normalize(value)
            ?: return RedactedSurfaceText(null, false, null)
        val context = normalize(contextualLabel).orEmpty()
        val hasOtpContext = OTP_CONTEXT.containsMatchIn(context) ||
            OTP_CONTEXT.containsMatchIn(bounded)
        if (hasOtpContext && OTP_DIGITS.containsMatchIn(bounded)) {
            return RedactedSurfaceText(
                value = OTP_DIGITS.replace(bounded, "[REDACTED_OTP]"),
                redacted = true,
                reasonCode = "one_time_code",
            )
        }
        return RedactedSurfaceText(bounded, false, null)
    }

    private fun normalize(value: CharSequence?): String? = value
        ?.toString()
        ?.replace(CONTROL_CHARACTERS, " ")
        ?.replace(WHITESPACE, " ")
        ?.trim()
        ?.take(MAX_TEXT_CHARACTERS)
        ?.takeIf(String::isNotEmpty)

    private companion object {
        const val MAX_TEXT_CHARACTERS = 4_096
        val CONTROL_CHARACTERS = Regex("[\\u0000-\\u001f\\u007f]")
        val WHITESPACE = Regex("\\s+")
        val OTP_CONTEXT = Regex(
            "(?i)(otp|one[- ]?time|verification|verify|security code|验证码|校验码|动态码|一次性密码)",
        )
        val OTP_DIGITS = Regex("(?<!\\d)\\d{4,8}(?!\\d)")
    }
}
