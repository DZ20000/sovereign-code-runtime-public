package com.sovereign.runtime.android.notification

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

internal class NotificationTextSanitizerTest {
    private val sanitizer = NotificationTextSanitizer(maximumFieldCharacters = 128)

    @Test
    fun redactsAuthenticatorPasswordManagerAndPaymentNotifications() {
        for (sensitivity in listOf(
            NotificationSensitivity.AUTHENTICATOR,
            NotificationSensitivity.PASSWORD_MANAGER,
            NotificationSensitivity.BANKING_OR_PAYMENT,
            NotificationSensitivity.SENSITIVE,
        )) {
            val result = sanitizer.sanitizeText(
                title = "Secret title",
                text = "Code 123456",
                subText = "Account balance",
                sensitivity = sensitivity,
            )
            assertEquals("[REDACTED_NOTIFICATION]", result.title)
            assertNull(result.text)
            assertNull(result.subText)
            assertTrue(result.redacted)
        }
    }

    @Test
    fun redactsOtpOnlyWhenNotificationContextIndicatesOneTimeCode() {
        val otp = sanitizer.sanitizeText(
            title = "Verification code",
            text = "Use 123456 to sign in",
            subText = null,
            sensitivity = NotificationSensitivity.NORMAL,
        )
        assertEquals("Use [REDACTED_OTP] to sign in", otp.text)
        assertEquals("one_time_code", otp.reasonCode)

        val ordinary = sanitizer.sanitizeText(
            title = "Order update",
            text = "Order 123456 was shipped",
            subText = null,
            sensitivity = NotificationSensitivity.NORMAL,
        )
        assertEquals("Order 123456 was shipped", ordinary.text)
        assertFalse(ordinary.redacted)
    }

    @Test
    fun normalizesControlCharactersAndBoundsFields() {
        val result = sanitizer.sanitizeText(
            title = " A\n\u0000  B ",
            text = "x".repeat(300),
            subText = "  ",
            sensitivity = NotificationSensitivity.NORMAL,
        )
        assertEquals("A B", result.title)
        assertEquals(128, result.text?.length)
        assertNull(result.subText)
    }
}
