package com.sovereign.runtime.android.accessibility

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class UiSnapshotRegistryTest {
    private val bounds = UiBounds(10, 20, 110, 70)
    private val locator = NodeLocator(
        ref = "n0",
        childPath = listOf(0, 2),
        identity = NodeIdentity(
            windowId = 4,
            packageName = "example.app",
            className = "android.widget.Button",
            viewId = "example.app:id/continue_button",
            bounds = bounds,
            editable = false,
            password = false,
        ),
        interactionDenied = false,
        interactionDeniedReason = null,
    )

    @Test
    fun publishesOpaqueRevisionAndResolvesOnlyCurrentRefs() {
        val registry = UiSnapshotRegistry()
        val first = registry.publish(draft())
        assertTrue(first.revision.startsWith("ui_"))
        assertEquals(locator, registry.requireLocator(first.revision, "n0"))

        val second = registry.publish(draft(capturedAt = 2L))
        assertNotEquals(first.revision, second.revision)
        assertThrows(StaleUiRevisionException::class.java) {
            registry.requireLocator(first.revision, "n0")
        }
        assertEquals(locator, registry.requireLocator(second.revision, "n0"))
    }

    @Test
    fun invalidationClearsRevisionAndLocators() {
        val registry = UiSnapshotRegistry()
        val snapshot = registry.publish(draft())
        registry.invalidate("test invalidation")

        assertNull(registry.snapshot.value)
        assertNull(registry.currentRevision())
        assertThrows(StaleUiRevisionException::class.java) {
            registry.requireRevision(snapshot.revision)
        }
    }

    @Test
    fun unknownRefIsRejectedWithinCurrentRevision() {
        val registry = UiSnapshotRegistry()
        val snapshot = registry.publish(draft())
        assertThrows(UnknownUiRefException::class.java) {
            registry.requireLocator(snapshot.revision, "n-unknown")
        }
    }

    private fun draft(capturedAt: Long = 1L): UiSnapshotDraft = UiSnapshotDraft(
        capturedAtEpochMs = capturedAt,
        windowId = 4,
        packageName = "example.app",
        nodes = listOf(
            UiNodeSnapshot(
                ref = "n0",
                parentRef = null,
                depth = 0,
                role = UiRole.BUTTON,
                text = "Continue",
                contentDescription = null,
                viewId = "example.app:id/continue_button",
                className = "android.widget.Button",
                packageName = "example.app",
                bounds = bounds,
                clickable = true,
                longClickable = false,
                editable = false,
                scrollable = false,
                checkable = false,
                checked = false,
                enabled = true,
                password = false,
                redacted = false,
                interactionDenied = false,
                interactionDeniedReason = null,
            ),
        ),
        locators = mapOf("n0" to locator),
        truncated = false,
        redactionCount = 0,
    )
}
