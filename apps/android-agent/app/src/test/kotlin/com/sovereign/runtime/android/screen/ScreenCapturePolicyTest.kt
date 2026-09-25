package com.sovereign.runtime.android.screen

import com.sovereign.runtime.android.runtime.AuthorityProfile
import org.junit.Assert.assertEquals
import org.junit.Test

internal class ScreenCapturePolicyTest {
    private val policy = ScreenCapturePolicy()

    @Test
    fun normalAllowedSurfaceRequiresLocalConsentUntilProjectionIsActive() {
        val pending = policy.decide(
            ScreenCapturePolicyContext(
                authorityProfile = AuthorityProfile.OBSERVE,
                sensitivity = ScreenSensitivity.NORMAL,
                foregroundPackageAllowed = true,
                projectionActive = false,
                localConsentSurfaceAvailable = true,
            ),
        )
        assertEquals(ScreenCapturePolicyEffect.REQUIRE_LOCAL_CONSENT, pending.effect)
        assertEquals("media_projection_consent_required", pending.reasonCode)

        val active = policy.decide(
            ScreenCapturePolicyContext(
                authorityProfile = AuthorityProfile.OBSERVE,
                sensitivity = ScreenSensitivity.NORMAL,
                foregroundPackageAllowed = true,
                projectionActive = true,
                localConsentSurfaceAvailable = true,
            ),
        )
        assertEquals(ScreenCapturePolicyEffect.ALLOW, active.effect)
    }

    @Test
    fun unknownAndSensitiveSurfacesFailClosed() {
        for (sensitivity in ScreenSensitivity.entries.filterNot { it == ScreenSensitivity.NORMAL }) {
            val decision = policy.decide(
                ScreenCapturePolicyContext(
                    authorityProfile = AuthorityProfile.SYSTEM,
                    sensitivity = sensitivity,
                    foregroundPackageAllowed = true,
                    projectionActive = true,
                    localConsentSurfaceAvailable = true,
                ),
            )
            assertEquals("Expected denial for $sensitivity", ScreenCapturePolicyEffect.DENY, decision.effect)
        }
    }

    @Test
    fun unavailableConsentOrDisallowedPackageFailsClosed() {
        val noConsent = policy.decide(
            ScreenCapturePolicyContext(
                authorityProfile = AuthorityProfile.OBSERVE,
                sensitivity = ScreenSensitivity.NORMAL,
                foregroundPackageAllowed = true,
                projectionActive = false,
                localConsentSurfaceAvailable = false,
            ),
        )
        assertEquals("local_consent_unavailable", noConsent.reasonCode)

        val disallowed = policy.decide(
            ScreenCapturePolicyContext(
                authorityProfile = AuthorityProfile.SYSTEM,
                sensitivity = ScreenSensitivity.NORMAL,
                foregroundPackageAllowed = false,
                projectionActive = true,
                localConsentSurfaceAvailable = true,
            ),
        )
        assertEquals("foreground_package_not_allowed", disallowed.reasonCode)
    }
}
