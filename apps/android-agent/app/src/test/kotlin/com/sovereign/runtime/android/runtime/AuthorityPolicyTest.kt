package com.sovereign.runtime.android.runtime

import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class AuthorityPolicyTest {
    private val policy = AuthorityPolicy()

    @Test
    fun observeProfileAllowsOnlyObserveCapabilities() {
        assertTrue(
            policy.decide(
                AuthorityProfile.OBSERVE,
                AndroidCapability.UI_OBSERVE,
            ).allowed,
        )
        assertTrue(
            policy.decide(
                AuthorityProfile.OBSERVE,
                AndroidCapability.SCREEN_CAPTURE,
            ).allowed,
        )
        assertFalse(
            policy.decide(
                AuthorityProfile.OBSERVE,
                AndroidCapability.UI_CLICK,
            ).allowed,
        )
        assertFalse(
            policy.decide(
                AuthorityProfile.OBSERVE,
                AndroidCapability.SYSTEM_PACKAGE,
            ).allowed,
        )
    }

    @Test
    fun interactionProfileDoesNotImplicitlyGrantSystemAuthority() {
        assertTrue(
            policy.decide(
                AuthorityProfile.INTERACTION,
                AndroidCapability.UI_SET_TEXT,
            ).allowed,
        )
        assertFalse(
            policy.decide(
                AuthorityProfile.INTERACTION,
                AndroidCapability.SYSTEM_SETTINGS,
            ).allowed,
        )
    }

    @Test
    fun requireFailsClosedWithStructuredDecision() {
        val error = assertThrows(AuthorityDeniedException::class.java) {
            policy.require(
                AuthorityProfile.OBSERVE,
                AndroidCapability.GLOBAL_HOME,
            )
        }
        assertFalse(error.decision.allowed)
        assertTrue(error.message.orEmpty().contains("L2 Interaction"))
    }
}
