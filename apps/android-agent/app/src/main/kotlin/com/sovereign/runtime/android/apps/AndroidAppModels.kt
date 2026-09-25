package com.sovereign.runtime.android.apps

const val ANDROID_APP_LIST_SCHEMA_VERSION = "sar.app-list/v1"
const val ANDROID_CURRENT_APP_SCHEMA_VERSION = "sar.current-app/v1"
const val ANDROID_APP_LAUNCH_SCHEMA_VERSION = "sar.app-launch/v1"

private val ANDROID_PACKAGE_PATTERN = Regex(
    "^[A-Za-z][A-Za-z0-9_]*(?:\\.[A-Za-z][A-Za-z0-9_]*){0,31}$",
)
private val ANDROID_ACTIVITY_PATTERN = Regex("^[A-Za-z0-9_.$]{1,512}$")
private val ANDROID_APP_REVISION_PATTERN = Regex("^apps_[1-9][0-9]{0,15}_[A-Za-z0-9_-]{16}$")
private val ANDROID_APP_REF_PATTERN = Regex("^a[0-9a-z]{1,3}_[A-Za-z0-9_-]{16}$")

data class AndroidLaunchActivity(
    val packageName: String,
    val activityName: String,
    val label: String?,
    val enabled: Boolean,
    val exported: Boolean,
)

data class AndroidLaunchableApp(
    val ref: String,
    val packageName: String,
    val label: String,
    val interactionDenied: Boolean,
    val interactionDeniedReason: String?,
)

data class AndroidAppListResult(
    val schemaVersion: String = ANDROID_APP_LIST_SCHEMA_VERSION,
    val revision: String,
    val capturedAtEpochMs: Long,
    val validForMs: Long,
    val apps: List<AndroidLaunchableApp>,
    val truncated: Boolean,
)

data class AndroidCurrentAppResult(
    val schemaVersion: String = ANDROID_CURRENT_APP_SCHEMA_VERSION,
    val packageName: String?,
    val label: String?,
    val launchable: Boolean,
    val interactionDenied: Boolean,
    val interactionDeniedReason: String?,
)

data class AndroidAppLaunchResult(
    val schemaVersion: String = ANDROID_APP_LAUNCH_SCHEMA_VERSION,
    val revision: String,
    val ref: String,
    val packageName: String,
    val dispatchAccepted: Boolean = true,
    val dispatchedAtEpochMs: Long,
    val confirmationRequired: Boolean = true,
)

class AndroidAppListRequiredException(
    message: String,
) : IllegalStateException(message)

class StaleAndroidAppRevisionException(
    message: String,
) : IllegalStateException(message)

class UnknownAndroidAppRefException(
    message: String,
) : IllegalStateException(message)

class AndroidAppQueryRejectedException(
    message: String,
    cause: Throwable? = null,
) : IllegalStateException(message, cause)

class AndroidAppNotFoundException(
    message: String,
) : IllegalStateException(message)

class AndroidAppInteractionDeniedException(
    message: String,
) : IllegalStateException(message)

class AndroidAppLaunchRejectedException(
    message: String,
    cause: Throwable? = null,
) : IllegalStateException(message, cause)

internal data class AndroidAppSnapshotEntry(
    val public: AndroidLaunchableApp,
    val activity: AndroidLaunchActivity,
)

internal data class AndroidAppSnapshot(
    val revision: String,
    val capturedAtElapsedMs: Long,
    val expiresAtElapsedMs: Long,
    val entries: List<AndroidAppSnapshotEntry>,
)

internal fun validateAndroidPackageName(value: String): String {
    require(value.length in 3..255 && ANDROID_PACKAGE_PATTERN.matches(value)) {
        "Android packageName has an invalid shape."
    }
    return value
}

internal fun validateAndroidActivityName(value: String): String {
    require(ANDROID_ACTIVITY_PATTERN.matches(value)) {
        "Android launcher activity name has an invalid shape."
    }
    return value
}

internal fun validateAndroidAppRevision(value: String): String {
    require(ANDROID_APP_REVISION_PATTERN.matches(value)) {
        "Android app-list revision has an invalid shape."
    }
    return value
}

internal fun validateAndroidAppRef(value: String): String {
    require(ANDROID_APP_REF_PATTERN.matches(value)) {
        "Android app ref has an invalid shape."
    }
    return value
}

internal fun normalizePublicAppText(
    value: String?,
    fallback: String,
): String = value
    .orEmpty()
    .replace(Regex("[\\r\\n\\u0000-\\u001f\\u007f\\p{Cf}]+"), " ")
    .replace(Regex("\\s+"), " ")
    .trim()
    .take(128)
    .ifEmpty { fallback.take(128) }

internal fun normalizeAppPolicyReason(value: String?): String? = value
    ?.replace(Regex("[\\r\\n\\u0000-\\u001f\\u007f\\p{Cf}]+"), " ")
    ?.replace(Regex("\\s+"), " ")
    ?.trim()
    ?.take(256)
    ?.takeIf(String::isNotEmpty)

internal interface AndroidAppPlatform {
    suspend fun queryLauncherActivities(packageName: String? = null): List<AndroidLaunchActivity>

    suspend fun launch(activity: AndroidLaunchActivity)
}
