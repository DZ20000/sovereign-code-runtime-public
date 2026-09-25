package com.sovereign.runtime.android.apps

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AndroidAppManagerTest {
    @Test
    fun listIsBoundedSortedDeduplicatedAndRevisionBound() = runTest {
        var elapsed = 1_000L
        val platform = FakePlatform(
            activities = mutableListOf(
                activity("com.zeta.app", "com.zeta.Main", "Zeta"),
                activity("com.beta.app", "com.beta.Main", "Beta"),
                activity("com.alpha.app", "com.alpha.Other", "Zulu"),
                activity("com.alpha.app", "com.alpha.Main", "Alpha"),
                activity("com.alpha.app", "com.alpha.Main", "Duplicate"),
                activity("com.disabled.app", "com.disabled.Main", "Disabled", enabled = false),
                activity("com.hidden.app", "com.hidden.Main", "Hidden", exported = false),
                activity("not-a-package", "Bad", "Invalid"),
            ),
        )
        val manager = manager(
            platform = platform,
            elapsedNow = { elapsed },
            epochNow = { 9_000L },
            maximumApps = 2,
            denialReason = { packageName ->
                if (packageName == "com.beta.app") "Locally denied." else null
            },
        )

        val listed = manager.listLaunchableApps()

        assertEquals("apps_1_abcdefghijklmnop", listed.revision)
        assertEquals(9_000L, listed.capturedAtEpochMs)
        assertEquals(60_000L, listed.validForMs)
        assertTrue(listed.truncated)
        assertEquals(listOf("com.alpha.app", "com.beta.app"), listed.apps.map { it.packageName })
        assertEquals("Alpha", listed.apps[0].label)
        assertEquals("a0_abcdefghijklmnop", listed.apps[0].ref)
        assertFalse(listed.apps[0].interactionDenied)
        assertTrue(listed.apps[1].interactionDenied)
        assertEquals("Locally denied.", listed.apps[1].interactionDeniedReason)

        elapsed += 1L
        val second = manager.listLaunchableApps()
        assertEquals("apps_2_abcdefghijklmnop", second.revision)
        assertTrue(second.revision != listed.revision)
    }

    @Test
    fun launchRequiresCurrentUnexpiredRevisionAndKnownRef() = runTest {
        var elapsed = 5_000L
        val platform = FakePlatform(
            mutableListOf(activity("com.example.app", "com.example.Main", "Example")),
        )
        val manager = manager(platform, elapsedNow = { elapsed })

        assertFails<AndroidAppListRequiredException> {
            manager.launch("apps_1_abcdefghijklmnop", "a0_abcdefghijklmnop")
        }

        val listed = manager.listLaunchableApps()
        assertFails<StaleAndroidAppRevisionException> {
            manager.launch("apps_9_abcdefghijklmnop", listed.apps.single().ref)
        }
        assertFails<UnknownAndroidAppRefException> {
            manager.launch(listed.revision, "a9_abcdefghijklmnop")
        }

        elapsed += listed.validForMs
        assertFails<StaleAndroidAppRevisionException> {
            manager.launch(listed.revision, listed.apps.single().ref)
        }
        assertFails<AndroidAppListRequiredException> {
            manager.launch(listed.revision, listed.apps.single().ref)
        }
    }

    @Test
    fun launchRevalidatesTheExactListedComponentAndInvalidatesTheSnapshot() = runTest {
        val platform = FakePlatform(
            mutableListOf(
                activity("com.example.app", "com.example.Main", "Example"),
                activity("com.example.app", "com.example.Other", "Other"),
            ),
        )
        val manager = manager(platform)
        val listed = manager.listLaunchableApps()
        val selectedRef = listed.apps.single().ref

        val result = manager.launch(listed.revision, selectedRef)

        assertEquals("com.example.app", result.packageName)
        assertEquals(selectedRef, result.ref)
        assertEquals("com.example.Main", platform.launched.single().activityName)
        assertFails<AndroidAppListRequiredException> {
            manager.launch(listed.revision, selectedRef)
        }
    }

    @Test
    fun componentDisappearanceAndLocalPolicyDenyFailClosed() = runTest {
        val platform = FakePlatform(
            mutableListOf(activity("com.example.app", "com.example.Main", "Example")),
        )
        val denied = manager(
            platform = platform,
            denialReason = { "This package is protected." },
        )
        val deniedList = denied.listLaunchableApps()
        assertTrue(deniedList.apps.single().interactionDenied)
        assertFails<AndroidAppInteractionDeniedException> {
            denied.launch(deniedList.revision, deniedList.apps.single().ref)
        }
        assertTrue(platform.launched.isEmpty())

        val allowed = manager(platform)
        val listed = allowed.listLaunchableApps()
        platform.activities.clear()
        assertFails<AndroidAppNotFoundException> {
            allowed.launch(listed.revision, listed.apps.single().ref)
        }
        assertTrue(platform.launched.isEmpty())
    }

    @Test
    fun currentAppReportsLaunchabilityAndPolicyWithoutCreatingAnActionRef() = runTest {
        val platform = FakePlatform(
            mutableListOf(activity("com.example.app", "com.example.Main", "Example")),
        )
        val manager = manager(
            platform = platform,
            denialReason = { packageName ->
                if (packageName == "com.example.app") "Protected locally." else null
            },
        )

        val current = manager.currentApp("com.example.app")
        assertEquals("Example", current.label)
        assertTrue(current.launchable)
        assertTrue(current.interactionDenied)
        assertEquals("Protected locally.", current.interactionDeniedReason)

        val unknown = manager.currentApp(null)
        assertNull(unknown.packageName)
        assertFalse(unknown.launchable)
        assertTrue(unknown.interactionDenied)
    }

    @Test
    fun platformLaunchFailureIsBoundedAndDoesNotConsumeAnotherRevision() = runTest {
        val platform = FakePlatform(
            mutableListOf(activity("com.example.app", "com.example.Main", "Example")),
        ).apply {
            launchFailure = SecurityException("private platform detail")
        }
        val manager = manager(platform)
        val listed = manager.listLaunchableApps()

        val error = assertFails<AndroidAppLaunchRejectedException> {
            manager.launch(listed.revision, listed.apps.single().ref)
        }
        assertEquals("Android rejected the selected launcher activity.", error.message)
        assertTrue(platform.launched.isEmpty())

        platform.launchFailure = null
        val retry = manager.launch(listed.revision, listed.apps.single().ref)
        assertEquals("com.example.app", retry.packageName)
    }

    @Test
    fun launchReevaluatesLocalPackagePolicyAfterListing() = runTest {
        var denialReason: String? = null
        val platform = FakePlatform(
            mutableListOf(activity("com.example.app", "com.example.Main", "Example")),
        )
        val manager = manager(
            platform = platform,
            denialReason = { denialReason },
        )
        val listed = manager.listLaunchableApps()
        assertFalse(listed.apps.single().interactionDenied)
        denialReason = "Package policy changed after listing."

        val error = assertFails<AndroidAppInteractionDeniedException> {
            manager.launch(listed.revision, listed.apps.single().ref)
        }
        assertEquals("Package policy changed after listing.", error.message)
        assertTrue(platform.launched.isEmpty())
    }

    @Test
    fun currentAppAcceptsSingleSegmentFrameworkPackageNames() = runTest {
        val platform = FakePlatform(mutableListOf())
        val manager = manager(platform)

        val current = manager.currentApp("android")

        assertEquals("android", current.packageName)
        assertFalse(current.launchable)
        assertFalse(current.interactionDenied)
    }

    @Test
    fun timestampValidationHappensBeforeApplicationLaunchSideEffect() = runTest {
        var epoch = 2_000L
        val platform = FakePlatform(
            mutableListOf(activity("com.example.app", "com.example.Main", "Example")),
        )
        val manager = manager(
            platform = platform,
            epochNow = { epoch },
        )
        val listed = manager.listLaunchableApps()
        epoch = -1L

        assertFails<IllegalArgumentException> {
            manager.launch(listed.revision, listed.apps.single().ref)
        }
        assertTrue(platform.launched.isEmpty())

        epoch = 3_000L
        val retry = manager.launch(listed.revision, listed.apps.single().ref)
        assertTrue(retry.dispatchAccepted)
        assertEquals(3_000L, retry.dispatchedAtEpochMs)
        assertTrue(retry.confirmationRequired)
        assertEquals("com.example.app", platform.launched.single().packageName)
    }

    @Test
    fun publicAppTextRemovesUnicodeFormatControls() = runTest {
        val platform = FakePlatform(
            mutableListOf(
                activity(
                    "com.example.app",
                    "com.example.Main",
                    "Safe\u202EApp",
                ),
            ),
        )
        val manager = manager(
            platform = platform,
            denialReason = { "Protected\u2066package" },
        )

        val listed = manager.listLaunchableApps()

        assertEquals("Safe App", listed.apps.single().label)
        assertEquals("Protected package", listed.apps.single().interactionDeniedReason)
    }

    @Test
    fun launchCancellationPropagatesAndKeepsTheCurrentRevisionForRetry() = runTest {
        val cancellation = CancellationException("cancel launch")
        val platform = FakePlatform(
            mutableListOf(activity("com.example.app", "com.example.Main", "Example")),
        ).apply {
            launchFailure = cancellation
        }
        val manager = manager(platform)
        val listed = manager.listLaunchableApps()

        val error = assertFails<CancellationException> {
            manager.launch(listed.revision, listed.apps.single().ref)
        }
        assertTrue(error === cancellation)

        platform.launchFailure = null
        val retry = manager.launch(listed.revision, listed.apps.single().ref)
        assertTrue(retry.dispatchAccepted)
        assertEquals("com.example.app", retry.packageName)
    }

    @Test
    fun packageVisibilityQueryFailureIsBoundedAndDoesNotPublishARevision() = runTest {
        val platform = FakePlatform(mutableListOf()).apply {
            queryFailure = SecurityException("private PackageManager detail")
        }
        val manager = manager(platform)

        val error = assertFails<AndroidAppQueryRejectedException> {
            manager.listLaunchableApps()
        }
        assertEquals("Android package visibility query failed.", error.message)

        platform.queryFailure = null
        platform.activities += activity("com.example.app", "com.example.Main", "Example")
        val listed = manager.listLaunchableApps()
        assertEquals("apps_1_abcdefghijklmnop", listed.revision)
    }

    @Test
    fun packageVisibilityQueryCancellationIsNeverConvertedToToolFailure() = runTest {
        val cancellation = CancellationException("cancel query")
        val platform = FakePlatform(mutableListOf()).apply {
            queryFailure = cancellation
        }
        val manager = manager(platform)

        val error = assertFails<CancellationException> {
            manager.listLaunchableApps()
        }
        assertTrue(error === cancellation)
    }

    private fun manager(
        platform: FakePlatform,
        elapsedNow: () -> Long = { 1_000L },
        epochNow: () -> Long = { 2_000L },
        maximumApps: Int = 512,
        denialReason: (String) -> String? = { null },
    ): AndroidAppManager = AndroidAppManager(
        platform = platform,
        interactionDenialReason = denialReason,
        maximumApps = maximumApps,
        appListValidityMs = 60_000L,
        elapsedNow = elapsedNow,
        epochNow = epochNow,
        nonceGenerator = { "abcdefghijklmnop" },
    )

    private fun activity(
        packageName: String,
        activityName: String,
        label: String,
        enabled: Boolean = true,
        exported: Boolean = true,
    ): AndroidLaunchActivity = AndroidLaunchActivity(
        packageName = packageName,
        activityName = activityName,
        label = label,
        enabled = enabled,
        exported = exported,
    )

    private suspend inline fun <reified T : Throwable> assertFails(
        crossinline operation: suspend () -> Unit,
    ): T {
        val error = runCatching { operation() }.exceptionOrNull()
        assertTrue("Expected ${T::class.java.simpleName}, got $error", error is T)
        return error as T
    }

    private class FakePlatform(
        val activities: MutableList<AndroidLaunchActivity>,
    ) : AndroidAppPlatform {
        val launched = mutableListOf<AndroidLaunchActivity>()
        var queryFailure: Throwable? = null
        var launchFailure: Throwable? = null

        override suspend fun queryLauncherActivities(
            packageName: String?,
        ): List<AndroidLaunchActivity> {
            queryFailure?.let { throw it }
            return activities
                .filter { activity -> packageName == null || activity.packageName == packageName }
                .toList()
        }

        override suspend fun launch(activity: AndroidLaunchActivity) {
            launchFailure?.let { throw it }
            launched += activity
        }
    }
}
