package com.sovereign.runtime.android.runtime

data class AuthorityDecision(
    val allowed: Boolean,
    val capability: AndroidCapability,
    val currentProfile: AuthorityProfile,
    val reason: String,
)

class AuthorityDeniedException(
    val decision: AuthorityDecision,
) : IllegalStateException(decision.reason)

class AuthorityPolicy {
    fun decide(
        profile: AuthorityProfile,
        capability: AndroidCapability,
    ): AuthorityDecision {
        val allowed = profile.level >= capability.requiredProfile.level
        return AuthorityDecision(
            allowed = allowed,
            capability = capability,
            currentProfile = profile,
            reason = if (allowed) {
                "${profile.displayName} permits ${capability.name}."
            } else {
                "${capability.name} requires ${capability.requiredProfile.displayName}; " +
                    "current authority is ${profile.displayName}."
            },
        )
    }

    fun require(
        profile: AuthorityProfile,
        capability: AndroidCapability,
    ) {
        val decision = decide(profile, capability)
        if (!decision.allowed) {
            throw AuthorityDeniedException(decision)
        }
    }
}
