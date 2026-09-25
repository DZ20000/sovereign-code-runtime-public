package com.sovereign.runtime.android.accessibility

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class UiModelsTest {
    @Test
    fun publicTextIsFlattenedTrimmedAndBounded() {
        assertEquals("hello world", normalizePublicUiText("  hello\n\tworld  "))
        assertNull(normalizePublicUiText("\u0000\n\t"))
        val bounded = normalizePublicUiText("x".repeat(500))
        assertEquals(256, bounded?.length)
        assertTrue(bounded.orEmpty().endsWith("…"))
    }

    @Test
    fun boundsRejectEmptyAndOffscreenRectangles() {
        assertTrue(UiBounds(0, 0, 100, 100).isInside(200, 300))
        assertFalse(UiBounds(10, 10, 10, 20).isNonEmpty())
        assertFalse(UiBounds(-1, 0, 10, 10).isInside(100, 100))
        assertFalse(UiBounds(0, 0, 101, 10).isInside(100, 100))
    }

    @Test
    fun identityComparisonIncludesBoundsAndSensitivityFlags() {
        val identity = NodeIdentity(
            windowId = 1,
            packageName = "example.app",
            className = "android.widget.EditText",
            viewId = "example.app:id/input",
            bounds = UiBounds(1, 2, 3, 4),
            editable = true,
            password = false,
        )
        assertTrue(nodeIdentityMatches(identity, identity.copy()))
        assertFalse(
            nodeIdentityMatches(
                identity,
                identity.copy(bounds = UiBounds(1, 2, 4, 4)),
            ),
        )
        assertFalse(nodeIdentityMatches(identity, identity.copy(password = true)))
    }
}
