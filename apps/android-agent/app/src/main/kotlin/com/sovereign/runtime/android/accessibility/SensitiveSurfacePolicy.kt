package com.sovereign.runtime.android.accessibility

data class SurfaceDecision(
    val interactionAllowed: Boolean,
    val redactText: Boolean,
    val reason: String?,
)

class SensitiveSurfacePolicy(
    userDeniedPackages: Set<String> = emptySet(),
    private val ownPackagePrefix: String = "com.sovereign.runtime.android",
) {
    private val deniedPackages = userDeniedPackages
        .map(String::trim)
        .filter(String::isNotEmpty)
        .toSet()

    private val protectedPackagePrefixes = setOf(
        "com.android.permissioncontroller",
        "com.google.android.permissioncontroller",
        "com.android.systemui",
        ownPackagePrefix,
    )

    fun evaluate(
        packageName: String?,
        password: Boolean,
    ): SurfaceDecision {
        if (password) {
            return SurfaceDecision(
                interactionAllowed = false,
                redactText = true,
                reason = "Password and credential fields are protected.",
            )
        }
        val normalizedPackage = packageName?.trim().orEmpty()
        if (normalizedPackage.isEmpty()) {
            return SurfaceDecision(
                interactionAllowed = false,
                redactText = true,
                reason = "The active package could not be verified.",
            )
        }
        if (deniedPackages.any { denied -> packageMatches(normalizedPackage, denied) }) {
            return SurfaceDecision(
                interactionAllowed = false,
                redactText = true,
                reason = "The package is denied by local policy.",
            )
        }
        if (protectedPackagePrefixes.any { protected -> packageMatches(normalizedPackage, protected) }) {
            return SurfaceDecision(
                interactionAllowed = false,
                redactText = true,
                reason = "The package is a protected Android or Sovereign control surface.",
            )
        }
        return SurfaceDecision(
            interactionAllowed = true,
            redactText = false,
            reason = null,
        )
    }

    private fun packageMatches(
        packageName: String,
        prefix: String,
    ): Boolean = packageName == prefix || packageName.startsWith("$prefix.")
}
