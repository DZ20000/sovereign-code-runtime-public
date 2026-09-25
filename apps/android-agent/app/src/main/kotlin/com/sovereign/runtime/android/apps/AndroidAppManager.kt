package com.sovereign.runtime.android.apps

import java.security.SecureRandom
import java.util.Base64
import java.util.Locale
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

private const val DEFAULT_MAXIMUM_APPS = 512
private const val MAXIMUM_RAW_ACTIVITIES = 4_096
private const val MAXIMUM_EXACT_PACKAGE_ACTIVITIES = 64
private const val DEFAULT_APP_LIST_VALIDITY_MS = 60_000L

internal class AndroidAppManager(
    private val platform: AndroidAppPlatform,
    private val interactionDenialReason: (String) -> String?,
    private val maximumApps: Int = DEFAULT_MAXIMUM_APPS,
    private val appListValidityMs: Long = DEFAULT_APP_LIST_VALIDITY_MS,
    private val elapsedNow: () -> Long,
    private val epochNow: () -> Long = System::currentTimeMillis,
    private val nonceGenerator: () -> String = {
        val bytes = ByteArray(12)
        SecureRandom().nextBytes(bytes)
        Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
    },
) {
    init {
        require(maximumApps in 1..2_048) {
            "maximumApps must be from 1 through 2048."
        }
        require(appListValidityMs in 1_000L..300_000L) {
            "appListValidityMs must be from 1000 through 300000."
        }
    }

    private val mutex = Mutex()
    private var nextRevision = 1L
    private var currentSnapshot: AndroidAppSnapshot? = null

    suspend fun listLaunchableApps(): AndroidAppListResult {
        val raw = queryLauncherActivities(null)
        val sanitized = sanitizeActivities(
            activities = raw,
            maximumRawActivities = MAXIMUM_RAW_ACTIVITIES,
        )
        val selected = sanitized.activities
            .groupBy(AndroidLaunchActivity::packageName)
            .map { (packageName, activities) ->
                activities.minWithOrNull(
                    compareBy<AndroidLaunchActivity>(
                        { normalizePublicAppText(it.label, packageName).lowercase(Locale.ROOT) },
                        AndroidLaunchActivity::activityName,
                    ),
                ) ?: error("Sanitized application group was unexpectedly empty.")
            }
            .sortedWith(
                compareBy<AndroidLaunchActivity>(
                    { normalizePublicAppText(it.label, it.packageName).lowercase(Locale.ROOT) },
                    AndroidLaunchActivity::packageName,
                    AndroidLaunchActivity::activityName,
                ),
            )
        val bounded = selected.take(maximumApps)
        return mutex.withLock {
            val elapsed = checkedTimestamp(elapsedNow(), "App-list elapsed timestamp")
            val epoch = checkedTimestamp(epochNow(), "App-list epoch timestamp")
            val expiresAt = elapsed + appListValidityMs
            require(expiresAt >= elapsed) {
                "App-list expiry overflowed the elapsed-time range."
            }
            val revisionNumber = nextRevision
            check(revisionNumber in 1..9_999_999_999_999_999L) {
                "Android app-list revision limit reached."
            }
            nextRevision += 1L
            val nonce = nonceGenerator()
            require(nonce.matches(Regex("^[A-Za-z0-9_-]{16}$"))) {
                "Android app-list nonce has an invalid shape."
            }
            val revision = validateAndroidAppRevision("apps_${revisionNumber}_$nonce")
            val entries = bounded.mapIndexed { index, activity ->
                val denialReason = normalizeAppPolicyReason(
                    interactionDenialReason(activity.packageName),
                )
                val ref = validateAndroidAppRef("a${index.toString(36)}_$nonce")
                AndroidAppSnapshotEntry(
                    public = AndroidLaunchableApp(
                        ref = ref,
                        packageName = activity.packageName,
                        label = normalizePublicAppText(activity.label, activity.packageName),
                        interactionDenied = denialReason != null,
                        interactionDeniedReason = denialReason,
                    ),
                    activity = activity,
                )
            }
            currentSnapshot = AndroidAppSnapshot(
                revision = revision,
                capturedAtElapsedMs = elapsed,
                expiresAtElapsedMs = expiresAt,
                entries = entries,
            )
            AndroidAppListResult(
                revision = revision,
                capturedAtEpochMs = epoch,
                validForMs = appListValidityMs,
                apps = entries.map(AndroidAppSnapshotEntry::public),
                truncated = sanitized.truncated || selected.size > maximumApps,
            )
        }
    }

    suspend fun currentApp(packageName: String?): AndroidCurrentAppResult {
        if (packageName == null) {
            return AndroidCurrentAppResult(
                packageName = null,
                label = null,
                launchable = false,
                interactionDenied = true,
                interactionDeniedReason = "The active Accessibility window did not expose a package name.",
            )
        }
        val validated = validateAndroidPackageName(packageName)
        val selected = findLaunchTargets(validated).firstOrNull()
        val denialReason = normalizeAppPolicyReason(interactionDenialReason(validated))
        return AndroidCurrentAppResult(
            packageName = validated,
            label = selected?.let { activity ->
                normalizePublicAppText(activity.label, validated)
            },
            launchable = selected != null,
            interactionDenied = denialReason != null,
            interactionDeniedReason = denialReason,
        )
    }

    suspend fun launch(
        revision: String,
        ref: String,
    ): AndroidAppLaunchResult = mutex.withLock {
        val validatedRevision = validateAndroidAppRevision(revision)
        val validatedRef = validateAndroidAppRef(ref)
        val snapshot = currentSnapshot ?: throw AndroidAppListRequiredException(
            "Call android.app.list before launching an application.",
        )
        if (validatedRevision != snapshot.revision) {
            throw StaleAndroidAppRevisionException(
                "The Android app-list revision is stale. Call android.app.list again.",
            )
        }
        val elapsed = checkedTimestamp(elapsedNow(), "App-launch elapsed timestamp")
        if (elapsed < snapshot.capturedAtElapsedMs || elapsed >= snapshot.expiresAtElapsedMs) {
            currentSnapshot = null
            throw StaleAndroidAppRevisionException(
                "The Android app-list revision expired. Call android.app.list again.",
            )
        }
        val entry = snapshot.entries.firstOrNull { candidate ->
            candidate.public.ref == validatedRef
        } ?: throw UnknownAndroidAppRefException(
            "The Android app ref is not part of the current app-list revision.",
        )
        val currentDenialReason = normalizeAppPolicyReason(
            interactionDenialReason(entry.activity.packageName),
        )
        (currentDenialReason ?: entry.public.interactionDeniedReason)?.let { reason ->
            throw AndroidAppInteractionDeniedException(reason)
        }

        val currentTarget = findLaunchTargets(entry.activity.packageName)
            .firstOrNull { activity ->
                activity.activityName == entry.activity.activityName
            } ?: throw AndroidAppNotFoundException(
                "The selected launcher activity is no longer available.",
            )
        val dispatchedAtEpochMs = checkedTimestamp(
            epochNow(),
            "Application launch-dispatch timestamp",
        )
        try {
            platform.launch(currentTarget)
        } catch (error: CancellationException) {
            throw error
        } catch (error: AndroidAppLaunchRejectedException) {
            throw error
        } catch (error: Exception) {
            throw AndroidAppLaunchRejectedException(
                "Android rejected the selected launcher activity.",
                error,
            )
        }
        currentSnapshot = null
        AndroidAppLaunchResult(
            revision = snapshot.revision,
            ref = entry.public.ref,
            packageName = currentTarget.packageName,
            dispatchedAtEpochMs = dispatchedAtEpochMs,
        )
    }

    suspend fun invalidate() {
        mutex.withLock {
            currentSnapshot = null
        }
    }

    private suspend fun queryLauncherActivities(
        packageName: String?,
    ): List<AndroidLaunchActivity> = try {
        platform.queryLauncherActivities(packageName)
    } catch (error: CancellationException) {
        throw error
    } catch (error: Exception) {
        throw AndroidAppQueryRejectedException(
            "Android package visibility query failed.",
            error,
        )
    }

    private suspend fun findLaunchTargets(packageName: String): List<AndroidLaunchActivity> =
        sanitizeActivities(
            activities = queryLauncherActivities(packageName),
            maximumRawActivities = MAXIMUM_EXACT_PACKAGE_ACTIVITIES,
        ).activities
            .filter { activity -> activity.packageName == packageName }
            .sortedWith(
                compareBy<AndroidLaunchActivity>(
                    { normalizePublicAppText(it.label, packageName).lowercase(Locale.ROOT) },
                    AndroidLaunchActivity::activityName,
                ),
            )

    private fun sanitizeActivities(
        activities: List<AndroidLaunchActivity>,
        maximumRawActivities: Int,
    ): SanitizedActivities {
        val bounded = activities.take(maximumRawActivities + 1)
        val seenComponents = mutableSetOf<String>()
        val result = mutableListOf<AndroidLaunchActivity>()
        bounded.take(maximumRawActivities).forEach { activity ->
            val packageName = runCatching {
                validateAndroidPackageName(activity.packageName)
            }.getOrNull() ?: return@forEach
            val activityName = runCatching {
                validateAndroidActivityName(activity.activityName)
            }.getOrNull() ?: return@forEach
            if (!activity.enabled || !activity.exported) return@forEach
            val componentKey = "$packageName/$activityName"
            if (!seenComponents.add(componentKey)) return@forEach
            result += activity.copy(
                packageName = packageName,
                activityName = activityName,
                label = normalizePublicAppText(activity.label, packageName),
            )
        }
        return SanitizedActivities(
            activities = result,
            truncated = activities.size > maximumRawActivities,
        )
    }

    private fun checkedTimestamp(value: Long, label: String): Long {
        require(value >= 0L) { "$label must be non-negative." }
        return value
    }

    private data class SanitizedActivities(
        val activities: List<AndroidLaunchActivity>,
        val truncated: Boolean,
    )
}
