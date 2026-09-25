package com.sovereign.runtime.android.accessibility

import org.junit.Assert.assertEquals
import org.junit.Test

class AccessibilitySnapshotLimitsTest {
    @Test
    fun childAcceptanceIsBoundedByEveryConfiguredLimit() {
        assertEquals(
            10,
            boundedChildCount(
                childCount = 10,
                maximumChildrenPerNode = 128,
                remainingNodeCapacity = 500,
            ),
        )
        assertEquals(
            128,
            boundedChildCount(
                childCount = 300,
                maximumChildrenPerNode = 128,
                remainingNodeCapacity = 500,
            ),
        )
        assertEquals(
            7,
            boundedChildCount(
                childCount = 300,
                maximumChildrenPerNode = 128,
                remainingNodeCapacity = 7,
            ),
        )
    }

    @Test
    fun negativeFrameworkOrCapacityValuesFailClosedToZero() {
        assertEquals(0, boundedChildCount(-1, 128, 500))
        assertEquals(0, boundedChildCount(10, -1, 500))
        assertEquals(0, boundedChildCount(10, 128, -1))
    }
}
