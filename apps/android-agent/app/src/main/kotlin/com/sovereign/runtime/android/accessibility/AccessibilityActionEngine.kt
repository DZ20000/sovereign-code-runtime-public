package com.sovereign.runtime.android.accessibility

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.graphics.Path
import android.os.Bundle
import android.view.accessibility.AccessibilityNodeInfo
import com.sovereign.runtime.android.runtime.AndroidCapability
import com.sovereign.runtime.android.runtime.AuthorityPolicy
import com.sovereign.runtime.android.runtime.AuthorityProfile
import kotlin.coroutines.resume
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext

private const val MAX_SET_TEXT_CHARACTERS = 4_000
private const val TAP_DURATION_MS = 80L
private const val DEFAULT_LONG_PRESS_DURATION_MS = 800L
private const val MIN_LONG_PRESS_DURATION_MS = 500L
private const val MAX_LONG_PRESS_DURATION_MS = 2_000L
private const val MIN_SWIPE_DURATION_MS = 100L
private const val MAX_SWIPE_DURATION_MS = 2_000L

enum class AndroidUiAction {
    CLICK,
    LONG_PRESS,
    SET_TEXT,
    SWIPE,
    GLOBAL_BACK,
    GLOBAL_HOME,
    GLOBAL_RECENTS,
}

data class AndroidActionResult(
    val action: AndroidUiAction,
    val succeeded: Boolean,
    val revision: String,
    val ref: String?,
    val packageName: String?,
    val performedAtEpochMs: Long,
    val detail: String,
)

class UiActionRejectedException(
    message: String,
) : IllegalStateException(message)

class AccessibilityActionEngine(
    private val serviceRegistry: AccessibilityServiceRegistry,
    private val snapshotRegistry: UiSnapshotRegistry,
    private val snapshotBuilder: AccessibilitySnapshotBuilder,
    private val sensitiveSurfacePolicy: SensitiveSurfacePolicy,
    private val authorityPolicy: AuthorityPolicy,
    private val profileProvider: () -> AuthorityProfile,
) {
    suspend fun observe(): UiSnapshot = withContext(Dispatchers.Main.immediate) {
        authorityPolicy.require(profileProvider(), AndroidCapability.UI_OBSERVE)
        val service = serviceRegistry.requireService()
        val root = service.rootInActiveWindow ?: throw UiActionRejectedException(
            "The active window does not expose an accessibility root.",
        )
        snapshotRegistry.publish(snapshotBuilder.build(root))
    }

    suspend fun click(
        revision: String,
        ref: String,
    ): AndroidActionResult = withResolvedNode(
        revision = revision,
        ref = ref,
        capability = AndroidCapability.UI_CLICK,
    ) { service, node, locator ->
        if (!node.isEnabled) {
            throw UiActionRejectedException("The referenced node is disabled.")
        }
        val nodePerformed = node.performAction(AccessibilityNodeInfo.ACTION_CLICK)
        val performed = if (nodePerformed) {
            true
        } else {
            snapshotRegistry.invalidate("Fallback tap was submitted to Android.")
            dispatchTap(service, locator.identity.bounds, TAP_DURATION_MS)
        }
        actionResult(
            action = AndroidUiAction.CLICK,
            succeeded = performed,
            revision = revision,
            ref = ref,
            packageName = locator.identity.packageName,
            detail = if (performed) "Click executed." else "The node and gesture fallback rejected the click.",
        )
    }

    suspend fun longPress(
        revision: String,
        ref: String,
        durationMs: Long = DEFAULT_LONG_PRESS_DURATION_MS,
    ): AndroidActionResult {
        if (durationMs !in MIN_LONG_PRESS_DURATION_MS..MAX_LONG_PRESS_DURATION_MS) {
            throw UiActionRejectedException(
                "Long-press duration must be between $MIN_LONG_PRESS_DURATION_MS and " +
                    "$MAX_LONG_PRESS_DURATION_MS milliseconds.",
            )
        }
        return withResolvedNode(
            revision = revision,
            ref = ref,
            capability = AndroidCapability.UI_LONG_PRESS,
        ) { service, node, locator ->
            if (!node.isEnabled) {
                throw UiActionRejectedException("The referenced node is disabled.")
            }
            val nodePerformed = node.performAction(AccessibilityNodeInfo.ACTION_LONG_CLICK)
            val performed = if (nodePerformed) {
                true
            } else {
                snapshotRegistry.invalidate("Fallback long-press gesture was submitted to Android.")
                dispatchTap(service, locator.identity.bounds, durationMs)
            }
            actionResult(
                action = AndroidUiAction.LONG_PRESS,
                succeeded = performed,
                revision = revision,
                ref = ref,
                packageName = locator.identity.packageName,
                detail = if (performed) {
                    "Long press executed."
                } else {
                    "The node and gesture fallback rejected the long press."
                },
            )
        }
    }

    suspend fun setText(
        revision: String,
        ref: String,
        text: String,
    ): AndroidActionResult {
        if (text.length > MAX_SET_TEXT_CHARACTERS) {
            throw UiActionRejectedException(
                "Text input exceeds the $MAX_SET_TEXT_CHARACTERS-character limit.",
            )
        }
        if (text.any { character -> character == '\u0000' }) {
            throw UiActionRejectedException("Text input may not contain NUL characters.")
        }
        return withResolvedNode(
            revision = revision,
            ref = ref,
            capability = AndroidCapability.UI_SET_TEXT,
        ) { _, node, locator ->
            if (!node.isEnabled || !node.isEditable || node.isPassword) {
                throw UiActionRejectedException(
                    "The referenced node is not an approved editable text field.",
                )
            }
            val arguments = Bundle().apply {
                putCharSequence(
                    AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE,
                    text,
                )
            }
            val performed = node.performAction(
                AccessibilityNodeInfo.ACTION_SET_TEXT,
                arguments,
            )
            actionResult(
                action = AndroidUiAction.SET_TEXT,
                succeeded = performed,
                revision = revision,
                ref = ref,
                packageName = locator.identity.packageName,
                detail = if (performed) {
                    "Text replaced through ACTION_SET_TEXT."
                } else {
                    "The target application rejected ACTION_SET_TEXT; clipboard fallback is disabled."
                },
            )
        }
    }

    suspend fun swipe(
        revision: String,
        startX: Float,
        startY: Float,
        endX: Float,
        endY: Float,
        durationMs: Long,
    ): AndroidActionResult = withContext(Dispatchers.Main.immediate) {
        authorityPolicy.require(profileProvider(), AndroidCapability.UI_SWIPE)
        val snapshot = snapshotRegistry.requireRevision(revision)
        val surface = sensitiveSurfacePolicy.evaluate(
            packageName = snapshot.packageName,
            password = false,
        )
        if (!surface.interactionAllowed) {
            throw UiActionRejectedException(
                surface.reason ?: "The active surface is protected.",
            )
        }
        if (durationMs !in MIN_SWIPE_DURATION_MS..MAX_SWIPE_DURATION_MS) {
            throw UiActionRejectedException(
                "Swipe duration must be between $MIN_SWIPE_DURATION_MS and " +
                    "$MAX_SWIPE_DURATION_MS milliseconds.",
            )
        }
        val service = serviceRegistry.requireService()
        val metrics = service.resources.displayMetrics
        validatePoint(startX, startY, metrics.widthPixels, metrics.heightPixels)
        validatePoint(endX, endY, metrics.widthPixels, metrics.heightPixels)
        val path = Path().apply {
            moveTo(startX, startY)
            lineTo(endX, endY)
        }
        snapshotRegistry.invalidate("Swipe gesture was submitted to Android.")
        val performed = dispatchGesture(service, path, durationMs)
        actionResult(
            action = AndroidUiAction.SWIPE,
            succeeded = performed,
            revision = revision,
            ref = null,
            packageName = snapshot.packageName,
            detail = if (performed) "Swipe executed." else "Android rejected the swipe gesture.",
        )
    }

    suspend fun globalAction(
        revision: String,
        action: AndroidUiAction,
    ): AndroidActionResult = withContext(Dispatchers.Main.immediate) {
        val (capability, androidAction) = when (action) {
            AndroidUiAction.GLOBAL_BACK -> AndroidCapability.GLOBAL_BACK to
                AccessibilityService.GLOBAL_ACTION_BACK
            AndroidUiAction.GLOBAL_HOME -> AndroidCapability.GLOBAL_HOME to
                AccessibilityService.GLOBAL_ACTION_HOME
            AndroidUiAction.GLOBAL_RECENTS -> AndroidCapability.GLOBAL_RECENTS to
                AccessibilityService.GLOBAL_ACTION_RECENTS
            else -> throw UiActionRejectedException("Unsupported global action: $action")
        }
        authorityPolicy.require(profileProvider(), capability)
        val snapshot = snapshotRegistry.requireRevision(revision)
        val surface = sensitiveSurfacePolicy.evaluate(
            packageName = snapshot.packageName,
            password = false,
        )
        if (!surface.interactionAllowed) {
            throw UiActionRejectedException(
                surface.reason ?: "The active surface is protected.",
            )
        }
        val performed = serviceRegistry.requireService().performGlobalAction(androidAction)
        if (performed) {
            snapshotRegistry.invalidate("Global action changed the active UI.")
        }
        actionResult(
            action = action,
            succeeded = performed,
            revision = revision,
            ref = null,
            packageName = snapshot.packageName,
            detail = if (performed) "Global action executed." else "Android rejected the global action.",
        )
    }

    private suspend fun withResolvedNode(
        revision: String,
        ref: String,
        capability: AndroidCapability,
        operation: suspend (
            service: AccessibilityService,
            node: AccessibilityNodeInfo,
            locator: NodeLocator,
        ) -> AndroidActionResult,
    ): AndroidActionResult = withContext(Dispatchers.Main.immediate) {
        authorityPolicy.require(profileProvider(), capability)
        val locator = snapshotRegistry.requireLocator(revision, ref)
        if (locator.interactionDenied) {
            throw UiActionRejectedException(
                locator.interactionDeniedReason ?: "The referenced node is protected.",
            )
        }
        val service = serviceRegistry.requireService()
        val root = service.rootInActiveWindow ?: throw UiActionRejectedException(
            "The active window does not expose an accessibility root.",
        )
        val node = resolvePath(root, locator.childPath)
        val actualIdentity = snapshotBuilder.identityFor(
            node = node,
            fallbackPackageName = root.packageName?.toString(),
        )
        val currentSurface = sensitiveSurfacePolicy.evaluate(
            packageName = actualIdentity.packageName,
            password = actualIdentity.password,
        )
        if (!currentSurface.interactionAllowed) {
            throw UiActionRejectedException(
                currentSurface.reason ?: "The referenced node is now protected.",
            )
        }
        if (!nodeIdentityMatches(locator.identity, actualIdentity)) {
            snapshotRegistry.invalidate("Node identity changed before action.")
            throw StaleUiRevisionException(
                "The referenced node changed after observation. Observe again before acting.",
            )
        }
        val result = operation(service, node, locator)
        if (result.succeeded) {
            snapshotRegistry.invalidate("UI action completed.")
        }
        result
    }

    private fun resolvePath(
        root: AccessibilityNodeInfo,
        childPath: List<Int>,
    ): AccessibilityNodeInfo {
        var current = root
        childPath.forEach { childIndex ->
            if (childIndex < 0 || childIndex >= current.childCount) {
                snapshotRegistry.invalidate("Node path no longer exists.")
                throw StaleUiRevisionException(
                    "The referenced node path no longer exists. Observe again before acting.",
                )
            }
            current = current.getChild(childIndex) ?: run {
                snapshotRegistry.invalidate("Node path resolved to an unavailable child.")
                throw StaleUiRevisionException(
                    "The referenced node is unavailable. Observe again before acting.",
                )
            }
        }
        return current
    }

    private suspend fun dispatchTap(
        service: AccessibilityService,
        bounds: UiBounds,
        durationMs: Long,
    ): Boolean {
        val metrics = service.resources.displayMetrics
        if (!bounds.isInside(metrics.widthPixels, metrics.heightPixels)) {
            throw UiActionRejectedException(
                "The referenced node bounds are empty or outside the current display.",
            )
        }
        val path = Path().apply {
            moveTo(bounds.centerX, bounds.centerY)
        }
        return dispatchGesture(service, path, durationMs)
    }

    private suspend fun dispatchGesture(
        service: AccessibilityService,
        path: Path,
        durationMs: Long,
    ): Boolean = suspendCancellableCoroutine { continuation ->
        val gesture = GestureDescription.Builder()
            .addStroke(
                GestureDescription.StrokeDescription(
                    path,
                    0,
                    durationMs,
                ),
            )
            .build()
        val accepted = service.dispatchGesture(
            gesture,
            object : AccessibilityService.GestureResultCallback() {
                override fun onCompleted(gestureDescription: GestureDescription) {
                    if (continuation.isActive) continuation.resume(true)
                }

                override fun onCancelled(gestureDescription: GestureDescription) {
                    if (continuation.isActive) continuation.resume(false)
                }
            },
            null,
        )
        if (!accepted && continuation.isActive) {
            continuation.resume(false)
        }
    }

    private fun validatePoint(
        x: Float,
        y: Float,
        widthPixels: Int,
        heightPixels: Int,
    ) {
        if (!x.isFinite() || !y.isFinite() || x < 0f || y < 0f || x >= widthPixels || y >= heightPixels) {
            throw UiActionRejectedException(
                "Gesture coordinate ($x, $y) is outside the current display.",
            )
        }
    }

    private fun actionResult(
        action: AndroidUiAction,
        succeeded: Boolean,
        revision: String,
        ref: String?,
        packageName: String?,
        detail: String,
    ): AndroidActionResult = AndroidActionResult(
        action = action,
        succeeded = succeeded,
        revision = revision,
        ref = ref,
        packageName = packageName,
        performedAtEpochMs = System.currentTimeMillis(),
        detail = detail,
    )
}
