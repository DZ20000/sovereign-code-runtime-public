package com.sovereign.runtime.android.screen

import com.sovereign.runtime.android.runtime.AuthorityProfile

enum class ScreenSensitivity {
    NORMAL,
    UNKNOWN,
    AUTHENTICATOR,
    PASSWORD_MANAGER,
    BANKING_OR_PAYMENT,
    DEVICE_ADMIN,
    SECURE_WINDOW,
}

enum class ScreenCapturePolicyEffect {
    ALLOW,
    REQUIRE_LOCAL_CONSENT,
    DENY,
}

data class ScreenCapturePolicyContext(
    val authorityProfile: AuthorityProfile,
    val sensitivity: ScreenSensitivity,
    val foregroundPackageAllowed: Boolean,
    val projectionActive: Boolean,
    val localConsentSurfaceAvailable: Boolean,
)

data class ScreenCapturePolicyDecision(
    val effect: ScreenCapturePolicyEffect,
    val reasonCode: String,
    val explanation: String,
)

class ScreenCapturePolicy {
    fun decide(context: ScreenCapturePolicyContext): ScreenCapturePolicyDecision {
        if (!context.authorityProfile.allowsObservation()) {
            return denied(
                "authority_insufficient",
                "Screen capture requires at least L1 Observe authority.",
            )
        }
        if (!context.foregroundPackageAllowed) {
            return denied(
                "foreground_package_not_allowed",
                "The foreground application is outside the local screen-observation allowlist.",
            )
        }
        if (context.sensitivity != ScreenSensitivity.NORMAL) {
            return denied(
                sensitivityReason(context.sensitivity),
                "Screen capture is disabled for the current sensitive or unclassified surface.",
            )
        }
        if (context.projectionActive) {
            return ScreenCapturePolicyDecision(
                effect = ScreenCapturePolicyEffect.ALLOW,
                reasonCode = "projection_active",
                explanation = "An in-memory MediaProjection session is active for this app process.",
            )
        }
        if (!context.localConsentSurfaceAvailable) {
            return denied(
                "local_consent_unavailable",
                "Android MediaProjection consent must be presented locally before capture.",
            )
        }
        return ScreenCapturePolicyDecision(
            effect = ScreenCapturePolicyEffect.REQUIRE_LOCAL_CONSENT,
            reasonCode = "media_projection_consent_required",
            explanation = "Android must display its local MediaProjection consent surface.",
        )
    }

    private fun denied(reasonCode: String, explanation: String) =
        ScreenCapturePolicyDecision(
            effect = ScreenCapturePolicyEffect.DENY,
            reasonCode = reasonCode,
            explanation = explanation,
        )

    private fun sensitivityReason(sensitivity: ScreenSensitivity): String = when (sensitivity) {
        ScreenSensitivity.NORMAL -> error("Normal surfaces are not denied by sensitivity.")
        ScreenSensitivity.UNKNOWN -> "screen_surface_unclassified"
        ScreenSensitivity.AUTHENTICATOR -> "authenticator_screen_denied"
        ScreenSensitivity.PASSWORD_MANAGER -> "password_manager_screen_denied"
        ScreenSensitivity.BANKING_OR_PAYMENT -> "banking_or_payment_screen_denied"
        ScreenSensitivity.DEVICE_ADMIN -> "device_admin_screen_denied"
        ScreenSensitivity.SECURE_WINDOW -> "secure_window_screen_denied"
    }
}

private fun AuthorityProfile.allowsObservation(): Boolean = when (this) {
    AuthorityProfile.OBSERVE,
    AuthorityProfile.INTERACTION,
    AuthorityProfile.SYSTEM -> true
}
