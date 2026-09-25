package com.sovereign.runtime.android.runtime

import android.content.Context
import android.os.Build
import android.os.SystemClock
import com.sovereign.runtime.android.accessibility.AccessibilityActionEngine
import com.sovereign.runtime.android.accessibility.AccessibilityServiceRegistry
import com.sovereign.runtime.android.accessibility.AccessibilitySnapshotBuilder
import com.sovereign.runtime.android.accessibility.AndroidActionResult
import com.sovereign.runtime.android.accessibility.AndroidUiAction
import com.sovereign.runtime.android.accessibility.SensitiveSurfacePolicy
import com.sovereign.runtime.android.accessibility.UiSnapshot
import com.sovereign.runtime.android.accessibility.UiSnapshotRegistry
import com.sovereign.runtime.android.apps.AndroidAppLaunchResult
import com.sovereign.runtime.android.apps.AndroidAppListResult
import com.sovereign.runtime.android.apps.AndroidAppManager
import com.sovereign.runtime.android.apps.AndroidCurrentAppResult
import com.sovereign.runtime.android.apps.PackageManagerAndroidAppPlatform
import com.sovereign.runtime.android.approval.AndroidApprovalBroker
import com.sovereign.runtime.android.audit.AndroidAuditLedger
import com.sovereign.runtime.android.gateway.McpGatewayController
import com.sovereign.runtime.android.notification.AndroidNotificationRuntime
import com.sovereign.runtime.android.notification.NotificationReadList
import com.sovereign.runtime.android.notification.NotificationReadStatus
import com.sovereign.runtime.android.screen.AccessibilityScreenshotController
import com.sovereign.runtime.android.screen.ProjectionScreenCaptureController
import com.sovereign.runtime.android.screen.ScreenCaptureRequester
import com.sovereign.runtime.android.screen.ScreenCaptureResult
import com.sovereign.runtime.android.screen.ScreenCaptureRouter
import com.sovereign.runtime.android.screen.ScreenProjectionRuntime
import com.sovereign.runtime.android.surface.AndroidSurfaceRuntime
import com.sovereign.runtime.android.surface.AndroidSurfaceStatus
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

class AndroidAgentRuntime(
    context: Context,
    deniedPackages: Set<String> = emptySet(),
) {
    private val applicationContext = context.applicationContext
    val approvalBroker = AndroidApprovalBroker(
        now = { SystemClock.elapsedRealtime() },
    )
    val auditLedger = AndroidAuditLedger(applicationContext)
    val snapshotRegistry = UiSnapshotRegistry()
    val serviceRegistry = AccessibilityServiceRegistry(snapshotRegistry)
    val notificationListenerConnected: StateFlow<Boolean> = AndroidNotificationRuntime.connected
    private val authorityPolicy = AuthorityPolicy()
    private val sensitiveSurfacePolicy = SensitiveSurfacePolicy(
        userDeniedPackages = deniedPackages,
    )
    private val mutableProfile = MutableStateFlow(AuthorityProfile.OBSERVE)
    private val appManager = AndroidAppManager(
        platform = PackageManagerAndroidAppPlatform(applicationContext),
        interactionDenialReason = { packageName ->
            val decision = sensitiveSurfacePolicy.evaluate(
                packageName = packageName,
                password = false,
            )
            decision.reason.takeUnless { decision.interactionAllowed }
        },
        elapsedNow = { SystemClock.elapsedRealtime() },
    )
    private val screenCaptureRequester: ScreenCaptureRequester = ScreenCaptureRouter(
        projectionStateProvider = ScreenProjectionRuntime::state,
        accessibilityRequester = AccessibilityScreenshotController(),
        projectionRequester = ProjectionScreenCaptureController(
            authorityProvider = { mutableProfile.value },
        ),
    )
    private val snapshotBuilder = AccessibilitySnapshotBuilder(sensitiveSurfacePolicy)
    private val mutableStatus = MutableStateFlow(
        "Enable Sovereign UI Adapter in Android Accessibility settings. " +
            "The MCP gateway remains stopped until you start its visible foreground service.",
    )

    val profile: StateFlow<AuthorityProfile> = mutableProfile.asStateFlow()
    val status: StateFlow<String> = mutableStatus.asStateFlow()
    val snapshots: StateFlow<UiSnapshot?> = snapshotRegistry.snapshot

    private val actionEngine = AccessibilityActionEngine(
        serviceRegistry = serviceRegistry,
        snapshotRegistry = snapshotRegistry,
        snapshotBuilder = snapshotBuilder,
        sensitiveSurfacePolicy = sensitiveSurfacePolicy,
        authorityPolicy = authorityPolicy,
        profileProvider = { mutableProfile.value },
    )

    val gateway: McpGatewayController by lazy(LazyThreadSafetyMode.SYNCHRONIZED) {
        McpGatewayController(
            context = applicationContext,
            runtime = this,
        )
    }

    suspend fun setProfile(profile: AuthorityProfile) {
        require(profile != AuthorityProfile.SYSTEM) {
            "L3 System is not implemented in the Android MVP."
        }
        mutableProfile.value = profile
        mutableStatus.value = "Authority changed locally to ${profile.displayName}."
        snapshotRegistry.invalidate("Authority profile changed.")
        appManager.invalidate()
        AndroidNotificationRuntime.invalidate()
    }

    fun invalidateSnapshot(reason: String) {
        snapshotRegistry.invalidate(reason)
    }

    suspend fun observe(): UiSnapshot = runAction("UI observed.") {
        actionEngine.observe()
    }

    internal suspend fun captureScreen(): ScreenCaptureResult = runAction(
        "Screen capture request completed with a short-lived in-memory artifact.",
    ) {
        authorityPolicy.require(
            mutableProfile.value,
            AndroidCapability.SCREEN_CAPTURE,
        )
        screenCaptureRequester.capture()
    }

    fun surfaceStatus(): AndroidSurfaceStatus {
        val active = AndroidSurfaceRuntime.activeSurface.current()
        val surfaceDecision = active?.let { current ->
            AndroidSurfaceRuntime.policy.decide(current.packageName)
        }
        val notificationStatus = AndroidNotificationRuntime.readFacade.status()
        val notificationSnapshot = AndroidNotificationRuntime.registry.current()
        return AndroidSurfaceStatus(
            accessibilityConnected = serviceRegistry.connected.value,
            screenshotApiSupported = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R,
            notificationListenerConnected = notificationStatus.listenerConnected,
            activePackageName = active?.packageName,
            activeWindowId = active?.windowId,
            activeSurfaceRevision = active?.revision,
            activeSurfaceCategory = surfaceDecision?.category?.name?.lowercase(),
            screenshotAllowedForActiveSurface = surfaceDecision?.screenshotAllowed,
            surfaceReasonCode = surfaceDecision?.reasonCode,
            notificationSnapshotRevision = notificationSnapshot?.let { snapshot ->
                "notifications_${snapshot.revision}_${snapshot.nonce}"
            },
            notificationCount = notificationStatus.recordCount,
            currentCapture = AndroidSurfaceRuntime.screenCaptures.metadata(),
        )
    }

    suspend fun listApps(): AndroidAppListResult = runAction("Launchable apps listed.") {
        authorityPolicy.require(mutableProfile.value, AndroidCapability.APP_LIST)
        appManager.listLaunchableApps()
    }

    suspend fun currentApp(): AndroidCurrentAppResult = runAction("Current app inspected.") {
        authorityPolicy.require(mutableProfile.value, AndroidCapability.APP_CURRENT)
        appManager.currentApp(snapshotRegistry.snapshot.value?.packageName)
    }

    suspend fun launchApp(
        revision: String,
        ref: String,
    ): AndroidAppLaunchResult = runAction(
        "Application launch request dispatched; observe the foreground app to confirm it.",
    ) {
        authorityPolicy.require(mutableProfile.value, AndroidCapability.APP_LAUNCH)
        appManager.launch(revision, ref).also {
            snapshotRegistry.invalidate(
                "Application launch request may change the foreground surface.",
            )
        }
    }

    internal fun notificationStatus(): NotificationReadStatus {
        authorityPolicy.require(
            mutableProfile.value,
            AndroidCapability.NOTIFICATION_LIST,
        )
        return AndroidNotificationRuntime.readFacade.status()
    }

    internal suspend fun listNotifications(limit: Int = 128): NotificationReadList = runAction(
        "Active notifications listed with local redaction policy.",
    ) {
        authorityPolicy.require(
            mutableProfile.value,
            AndroidCapability.NOTIFICATION_LIST,
        )
        AndroidNotificationRuntime.readFacade.list(limit)
    }

    suspend fun click(
        revision: String,
        ref: String,
    ): AndroidActionResult = runActionResult {
        actionEngine.click(revision, ref)
    }

    suspend fun longPress(
        revision: String,
        ref: String,
        durationMs: Long = 800L,
    ): AndroidActionResult = runActionResult {
        actionEngine.longPress(revision, ref, durationMs)
    }

    suspend fun setText(
        revision: String,
        ref: String,
        text: String,
    ): AndroidActionResult = runActionResult {
        actionEngine.setText(revision, ref, text)
    }

    suspend fun swipe(
        revision: String,
        startX: Float,
        startY: Float,
        endX: Float,
        endY: Float,
        durationMs: Long,
    ): AndroidActionResult = runActionResult {
        actionEngine.swipe(
            revision = revision,
            startX = startX,
            startY = startY,
            endX = endX,
            endY = endY,
            durationMs = durationMs,
        )
    }

    suspend fun globalAction(
        revision: String,
        action: AndroidUiAction,
    ): AndroidActionResult = runActionResult {
        actionEngine.globalAction(revision, action)
    }

    fun reportStatus(message: String) {
        mutableStatus.value = message
            .replace(Regex("[\\r\\n\\u0000]+"), " ")
            .replace(Regex("\\s+"), " ")
            .trim()
            .let { value ->
                when {
                    value.isEmpty() -> "Android runtime status changed."
                    value.length <= 512 -> value
                    else -> value.take(511) + "…"
                }
            }
    }

    fun reportError(error: Throwable) {
        reportStatus(error.message ?: error::class.java.simpleName)
    }

    private suspend fun <T> runAction(
        successMessage: String,
        operation: suspend () -> T,
    ): T = try {
        operation().also { mutableStatus.value = successMessage }
    } catch (error: CancellationException) {
        throw error
    } catch (error: Throwable) {
        reportError(error)
        throw error
    }

    private suspend fun runActionResult(
        operation: suspend () -> AndroidActionResult,
    ): AndroidActionResult = try {
        operation().also { result -> mutableStatus.value = result.detail }
    } catch (error: CancellationException) {
        throw error
    } catch (error: Throwable) {
        reportError(error)
        throw error
    }
}
