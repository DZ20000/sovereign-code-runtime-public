package com.sovereign.runtime.android.accessibility

import android.graphics.Rect
import android.os.Build
import android.view.accessibility.AccessibilityNodeInfo
import java.util.ArrayDeque

internal fun boundedChildCount(
    childCount: Int,
    maximumChildrenPerNode: Int,
    remainingNodeCapacity: Int,
): Int = minOf(
    childCount.coerceAtLeast(0),
    maximumChildrenPerNode.coerceAtLeast(0),
    remainingNodeCapacity.coerceAtLeast(0),
)

class AccessibilitySnapshotBuilder(
    private val sensitiveSurfacePolicy: SensitiveSurfacePolicy,
    private val maximumNodes: Int = 512,
    private val maximumDepth: Int = 40,
    private val maximumChildrenPerNode: Int = 128,
) {
    init {
        require(maximumNodes in 1..4_096) { "maximumNodes is outside its supported range." }
        require(maximumDepth in 1..100) { "maximumDepth is outside its supported range." }
        require(maximumChildrenPerNode in 1..512) {
            "maximumChildrenPerNode is outside its supported range."
        }
    }

    private data class PendingNode(
        val node: AccessibilityNodeInfo,
        val childPath: List<Int>,
        val parentRef: String?,
        val depth: Int,
    )

    fun build(root: AccessibilityNodeInfo): UiSnapshotDraft {
        val capturedAt = System.currentTimeMillis()
        val rootPackage = root.packageName?.toString()
        val nodes = ArrayList<UiNodeSnapshot>(maximumNodes.coerceAtMost(128))
        val locators = LinkedHashMap<String, NodeLocator>()
        val pending = ArrayDeque<PendingNode>()
        pending.add(
            PendingNode(
                node = root,
                childPath = emptyList(),
                parentRef = null,
                depth = 0,
            ),
        )
        var truncated = false
        var redactionCount = 0

        while (pending.isNotEmpty()) {
            if (nodes.size >= maximumNodes) {
                truncated = true
                break
            }
            val current = pending.removeFirst()
            if (current.depth > maximumDepth) {
                truncated = true
                continue
            }
            val node = current.node
            if (!node.isVisibleToUser) {
                continue
            }

            val ref = "n${nodes.size.toString(36)}"
            val packageName = node.packageName?.toString() ?: rootPackage
            val password = node.isPassword
            val surfaceDecision = sensitiveSurfacePolicy.evaluate(
                packageName = packageName,
                password = password,
            )
            val bounds = nodeBounds(node)
            val text = if (surfaceDecision.redactText) {
                null
            } else {
                normalizePublicUiText(node.text)
            }
            val contentDescription = if (surfaceDecision.redactText) {
                null
            } else {
                normalizePublicUiText(node.contentDescription)
            }
            if (surfaceDecision.redactText) {
                redactionCount += 1
            }
            val identity = NodeIdentity(
                windowId = node.windowId,
                packageName = packageName,
                className = node.className?.toString(),
                viewId = node.viewIdResourceName,
                bounds = bounds,
                editable = node.isEditable,
                password = password,
            )
            val snapshot = UiNodeSnapshot(
                ref = ref,
                parentRef = current.parentRef,
                depth = current.depth,
                role = classifyRole(node),
                text = text,
                contentDescription = contentDescription,
                viewId = node.viewIdResourceName,
                className = node.className?.toString(),
                packageName = packageName,
                bounds = bounds,
                clickable = node.isClickable,
                longClickable = node.isLongClickable,
                editable = node.isEditable,
                scrollable = node.isScrollable,
                checkable = node.isCheckable,
                checked = nodeChecked(node),
                enabled = node.isEnabled,
                password = password,
                redacted = surfaceDecision.redactText,
                interactionDenied = !surfaceDecision.interactionAllowed,
                interactionDeniedReason = surfaceDecision.reason,
            )
            nodes.add(snapshot)
            locators[ref] = NodeLocator(
                ref = ref,
                childPath = current.childPath,
                identity = identity,
                interactionDenied = !surfaceDecision.interactionAllowed,
                interactionDeniedReason = surfaceDecision.reason,
            )

            if (current.depth == maximumDepth) {
                if (node.childCount > 0) truncated = true
                continue
            }
            val childCount = node.childCount
            val remainingNodeCapacity =
                (maximumNodes - nodes.size - pending.size).coerceAtLeast(0)
            val acceptedChildren = boundedChildCount(
                childCount = childCount,
                maximumChildrenPerNode = maximumChildrenPerNode,
                remainingNodeCapacity = remainingNodeCapacity,
            )
            if (childCount > acceptedChildren) truncated = true
            for (index in 0 until acceptedChildren) {
                val child = node.getChild(index) ?: continue
                pending.addLast(
                    PendingNode(
                        node = child,
                        childPath = current.childPath + index,
                        parentRef = ref,
                        depth = current.depth + 1,
                    ),
                )
            }
        }

        return UiSnapshotDraft(
            capturedAtEpochMs = capturedAt,
            windowId = root.windowId,
            packageName = rootPackage,
            nodes = nodes,
            locators = locators,
            truncated = truncated,
            redactionCount = redactionCount,
        )
    }

    fun identityFor(
        node: AccessibilityNodeInfo,
        fallbackPackageName: String?,
    ): NodeIdentity = NodeIdentity(
        windowId = node.windowId,
        packageName = node.packageName?.toString() ?: fallbackPackageName,
        className = node.className?.toString(),
        viewId = node.viewIdResourceName,
        bounds = nodeBounds(node),
        editable = node.isEditable,
        password = node.isPassword,
    )

    private fun nodeChecked(node: AccessibilityNodeInfo): Boolean =
        if (Build.VERSION.SDK_INT >= 36) {
            node.checked == AccessibilityNodeInfo.CHECKED_STATE_TRUE
        } else {
            legacyNodeChecked(node)
        }

    @Suppress("DEPRECATION")
    private fun legacyNodeChecked(node: AccessibilityNodeInfo): Boolean = node.isChecked

    private fun nodeBounds(node: AccessibilityNodeInfo): UiBounds {
        val rect = Rect()
        node.getBoundsInScreen(rect)
        return UiBounds(
            left = rect.left,
            top = rect.top,
            right = rect.right,
            bottom = rect.bottom,
        )
    }

    private fun classifyRole(node: AccessibilityNodeInfo): UiRole {
        val className = node.className?.toString().orEmpty()
        return when {
            node.isEditable || className.endsWith("EditText") -> UiRole.INPUT
            className.endsWith("Switch") || className.endsWith("ToggleButton") -> UiRole.SWITCH
            className.endsWith("CheckBox") -> UiRole.CHECKBOX
            className.endsWith("RadioButton") -> UiRole.RADIO
            node.isClickable || className.endsWith("Button") -> UiRole.BUTTON
            className.endsWith("ImageView") -> UiRole.IMAGE
            node.isScrollable || className.endsWith("ScrollView") -> UiRole.SCROLL_CONTAINER
            className.endsWith("ListView") || className.endsWith("RecyclerView") -> UiRole.LIST
            className.endsWith("TextView") -> UiRole.TEXT
            node.childCount > 0 -> UiRole.CONTAINER
            else -> UiRole.UNKNOWN
        }
    }
}
