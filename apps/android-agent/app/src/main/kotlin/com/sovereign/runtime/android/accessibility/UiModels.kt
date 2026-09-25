package com.sovereign.runtime.android.accessibility

const val UI_SNAPSHOT_SCHEMA_VERSION = "sar.ui-snapshot/v1"

private const val MAX_PUBLIC_TEXT_CHARACTERS = 256

fun normalizePublicUiText(value: CharSequence?): String? {
    if (value == null) return null
    val normalized = buildString(value.length.coerceAtMost(MAX_PUBLIC_TEXT_CHARACTERS)) {
        value.forEach { character ->
            append(
                when {
                    character == '\u0000' -> ' '
                    character == '\r' || character == '\n' || character == '\t' -> ' '
                    character.isISOControl() -> ' '
                    else -> character
                },
            )
        }
    }.replace(Regex("\\s+"), " ").trim()
    if (normalized.isEmpty()) return null
    return if (normalized.length <= MAX_PUBLIC_TEXT_CHARACTERS) {
        normalized
    } else {
        normalized.take(MAX_PUBLIC_TEXT_CHARACTERS - 1) + "…"
    }
}

data class UiBounds(
    val left: Int,
    val top: Int,
    val right: Int,
    val bottom: Int,
) {
    val width: Int
        get() = (right - left).coerceAtLeast(0)
    val height: Int
        get() = (bottom - top).coerceAtLeast(0)
    val centerX: Float
        get() = left + width / 2f
    val centerY: Float
        get() = top + height / 2f

    fun isNonEmpty(): Boolean = width > 0 && height > 0

    fun isInside(widthPixels: Int, heightPixels: Int): Boolean =
        left >= 0 && top >= 0 && right <= widthPixels && bottom <= heightPixels && isNonEmpty()
}

enum class UiRole {
    BUTTON,
    INPUT,
    CHECKBOX,
    SWITCH,
    RADIO,
    IMAGE,
    TEXT,
    LIST,
    SCROLL_CONTAINER,
    CONTAINER,
    UNKNOWN,
}

data class UiNodeSnapshot(
    val ref: String,
    val parentRef: String?,
    val depth: Int,
    val role: UiRole,
    val text: String?,
    val contentDescription: String?,
    val viewId: String?,
    val className: String?,
    val packageName: String?,
    val bounds: UiBounds,
    val clickable: Boolean,
    val longClickable: Boolean,
    val editable: Boolean,
    val scrollable: Boolean,
    val checkable: Boolean,
    val checked: Boolean,
    val enabled: Boolean,
    val password: Boolean,
    val redacted: Boolean,
    val interactionDenied: Boolean,
    val interactionDeniedReason: String?,
)

data class UiSnapshot(
    val schemaVersion: String = UI_SNAPSHOT_SCHEMA_VERSION,
    val revision: String,
    val capturedAtEpochMs: Long,
    val windowId: Int,
    val packageName: String?,
    val nodes: List<UiNodeSnapshot>,
    val truncated: Boolean,
    val redactionCount: Int,
)

data class UiSnapshotDraft(
    val capturedAtEpochMs: Long,
    val windowId: Int,
    val packageName: String?,
    val nodes: List<UiNodeSnapshot>,
    val locators: Map<String, NodeLocator>,
    val truncated: Boolean,
    val redactionCount: Int,
)

data class NodeIdentity(
    val windowId: Int,
    val packageName: String?,
    val className: String?,
    val viewId: String?,
    val bounds: UiBounds,
    val editable: Boolean,
    val password: Boolean,
)

data class NodeLocator(
    val ref: String,
    val childPath: List<Int>,
    val identity: NodeIdentity,
    val interactionDenied: Boolean,
    val interactionDeniedReason: String?,
)

fun nodeIdentityMatches(
    expected: NodeIdentity,
    actual: NodeIdentity,
): Boolean = expected == actual
