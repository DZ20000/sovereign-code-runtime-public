package com.sovereign.runtime.android.surface

import java.util.Locale
import java.util.concurrent.ConcurrentHashMap

internal enum class SensitiveSurfaceCategory {
    NORMAL,
    BANKING,
    PAYMENT,
    AUTHENTICATOR,
    PASSWORD_MANAGER,
    DEVICE_ADMIN,
    UNKNOWN,
}

internal enum class NotificationExposure {
    FULL_REDACTED,
    METADATA_ONLY,
}

internal data class SensitiveSurfaceDecision(
    val packageName: String,
    val category: SensitiveSurfaceCategory,
    val uiTextAllowed: Boolean,
    val screenshotAllowed: Boolean,
    val notificationExposure: NotificationExposure,
    val notificationInteractionAllowed: Boolean,
    val reasonCode: String,
)

/**
 * Local package classification. Explicit device-local overrides win; heuristics
 * are deliberately narrow and never grant more access than UNKNOWN.
 */
internal class SensitiveSurfacePolicy(
    initialOverrides: Map<String, SensitiveSurfaceCategory> = emptyMap(),
) {
    private val overrides = ConcurrentHashMap<String, SensitiveSurfaceCategory>()

    init {
        replaceOverrides(initialOverrides)
    }

    fun replaceOverrides(next: Map<String, SensitiveSurfaceCategory>) {
        val normalized = next.entries.associate { (packageName, category) ->
            normalizePackage(packageName) to category
        }
        overrides.clear()
        overrides.putAll(normalized)
    }

    fun classify(packageName: String): SensitiveSurfaceCategory {
        val normalized = normalizePackage(packageName)
        overrides[normalized]?.let { return it }
        return when {
            normalized.contains("authenticator") ||
                normalized.contains("totp") ||
                normalized.endsWith(".auth") -> SensitiveSurfaceCategory.AUTHENTICATOR
            normalized.contains("password") ||
                normalized.contains("bitwarden") ||
                normalized.contains("keepass") ||
                normalized.contains("1password") -> SensitiveSurfaceCategory.PASSWORD_MANAGER
            normalized.contains("deviceadmin") ||
                normalized.contains("device.admin") -> SensitiveSurfaceCategory.DEVICE_ADMIN
            else -> SensitiveSurfaceCategory.UNKNOWN
        }
    }

    fun decide(packageName: String): SensitiveSurfaceDecision {
        val normalized = normalizePackage(packageName)
        return when (val category = classify(normalized)) {
            SensitiveSurfaceCategory.AUTHENTICATOR,
            SensitiveSurfaceCategory.PASSWORD_MANAGER -> SensitiveSurfaceDecision(
                packageName = normalized,
                category = category,
                uiTextAllowed = false,
                screenshotAllowed = false,
                notificationExposure = NotificationExposure.METADATA_ONLY,
                notificationInteractionAllowed = false,
                reasonCode = "secret_bearing_application",
            )
            SensitiveSurfaceCategory.BANKING,
            SensitiveSurfaceCategory.PAYMENT -> SensitiveSurfaceDecision(
                packageName = normalized,
                category = category,
                uiTextAllowed = true,
                screenshotAllowed = false,
                notificationExposure = NotificationExposure.FULL_REDACTED,
                notificationInteractionAllowed = false,
                reasonCode = "financial_application",
            )
            SensitiveSurfaceCategory.DEVICE_ADMIN -> SensitiveSurfaceDecision(
                packageName = normalized,
                category = category,
                uiTextAllowed = true,
                screenshotAllowed = false,
                notificationExposure = NotificationExposure.METADATA_ONLY,
                notificationInteractionAllowed = false,
                reasonCode = "device_administration_surface",
            )
            SensitiveSurfaceCategory.NORMAL -> SensitiveSurfaceDecision(
                packageName = normalized,
                category = category,
                uiTextAllowed = true,
                screenshotAllowed = true,
                notificationExposure = NotificationExposure.FULL_REDACTED,
                notificationInteractionAllowed = true,
                reasonCode = "normal_application",
            )
            SensitiveSurfaceCategory.UNKNOWN -> SensitiveSurfaceDecision(
                packageName = normalized,
                category = category,
                uiTextAllowed = true,
                screenshotAllowed = true,
                notificationExposure = NotificationExposure.FULL_REDACTED,
                notificationInteractionAllowed = true,
                reasonCode = "unclassified_application",
            )
        }
    }

    private fun normalizePackage(packageName: String): String {
        val normalized = packageName.trim().lowercase(Locale.ROOT)
        require(PACKAGE_PATTERN.matches(normalized)) {
            "Android package name has an invalid shape."
        }
        return normalized
    }

    private companion object {
        val PACKAGE_PATTERN = Regex("^[a-z0-9_]+(?:\\.[a-z0-9_]+)+$")
    }
}
