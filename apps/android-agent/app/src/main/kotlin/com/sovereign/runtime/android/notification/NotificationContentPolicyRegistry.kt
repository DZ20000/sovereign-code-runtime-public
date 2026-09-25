package com.sovereign.runtime.android.notification

internal data class NotificationContentPolicySnapshot(
    val revision: Long,
    val contentAllowedPackages: Set<String>,
    val explicitlySensitivePackages: Set<String>,
)

internal class NotificationContentPolicyRegistry {
    private var nextRevision = 2L
    private var currentSnapshot = NotificationContentPolicySnapshot(
        revision = 1L,
        contentAllowedPackages = emptySet(),
        explicitlySensitivePackages = emptySet(),
    )

    @Synchronized
    fun current(): NotificationContentPolicySnapshot = currentSnapshot

    @Synchronized
    fun replace(
        contentAllowedPackages: Set<String>,
        explicitlySensitivePackages: Set<String>,
    ): NotificationContentPolicySnapshot {
        val allowed = normalizePackages(contentAllowedPackages, "content-allowed")
        val sensitive = normalizePackages(explicitlySensitivePackages, "sensitive")
        require(allowed.intersect(sensitive).isEmpty()) {
            "A notification package cannot be both content-allowed and explicitly sensitive."
        }
        for (packageName in allowed) {
            require(hardSensitivity(packageName, null) == null) {
                "Hard-sensitive notification packages cannot expose content."
            }
        }
        val revision = nextRevision
        check(revision < Long.MAX_VALUE) {
            "Notification policy revision limit reached."
        }
        nextRevision += 1
        return NotificationContentPolicySnapshot(
            revision = revision,
            contentAllowedPackages = allowed,
            explicitlySensitivePackages = sensitive,
        ).also { snapshot ->
            currentSnapshot = snapshot
        }
    }

    @Synchronized
    fun classify(
        snapshot: NotificationContentPolicySnapshot,
        packageName: String,
        category: String?,
    ): NotificationSensitivity {
        require(snapshot.revision == currentSnapshot.revision) {
            "The notification content policy snapshot is stale."
        }
        val normalizedPackage = normalizePackage(packageName)
        hardSensitivity(normalizedPackage, category)?.let { sensitivity ->
            return sensitivity
        }
        if (normalizedPackage in snapshot.explicitlySensitivePackages) {
            return NotificationSensitivity.SENSITIVE
        }
        return if (normalizedPackage in snapshot.contentAllowedPackages) {
            NotificationSensitivity.NORMAL
        } else {
            NotificationSensitivity.SENSITIVE
        }
    }

    private fun normalizePackages(values: Set<String>, label: String): Set<String> {
        require(values.size <= MAXIMUM_POLICY_PACKAGES) {
            "The notification $label package list exceeds its limit."
        }
        val normalized = values.map(::normalizePackage)
        require(normalized.toSet().size == normalized.size) {
            "The notification $label package list contains a normalized duplicate."
        }
        return normalized.toSet()
    }

    private fun normalizePackage(value: String): String {
        val normalized = value.trim().lowercase()
        require(PACKAGE_PATTERN.matches(normalized)) {
            "The notification package name has an invalid shape."
        }
        return normalized
    }

    private fun hardSensitivity(
        packageName: String,
        category: String?,
    ): NotificationSensitivity? {
        val normalizedCategory = category.orEmpty().trim().lowercase()
        return when {
            AUTHENTICATOR_PATTERN.containsMatchIn(packageName) ||
                AUTHENTICATOR_PATTERN.containsMatchIn(normalizedCategory) ->
                NotificationSensitivity.AUTHENTICATOR
            PASSWORD_MANAGER_PATTERN.containsMatchIn(packageName) ||
                PASSWORD_MANAGER_PATTERN.containsMatchIn(normalizedCategory) ->
                NotificationSensitivity.PASSWORD_MANAGER
            PAYMENT_PATTERN.containsMatchIn(packageName) ||
                PAYMENT_PATTERN.containsMatchIn(normalizedCategory) ->
                NotificationSensitivity.BANKING_OR_PAYMENT
            else -> null
        }
    }

    private companion object {
        const val MAXIMUM_POLICY_PACKAGES = 512
        val PACKAGE_PATTERN = Regex("^[a-z0-9_]+(?:\\.[a-z0-9_]+)+$")
        val AUTHENTICATOR_PATTERN = Regex("(?:authenticator|otp|totp|2fa)")
        val PASSWORD_MANAGER_PATTERN = Regex(
            "(?:bitwarden|1password|lastpass|keepass|password|credential)",
        )
        val PAYMENT_PATTERN = Regex(
            "(?:bank|banking|wallet|payment|paypal|venmo|finance|financial)",
        )
    }
}
