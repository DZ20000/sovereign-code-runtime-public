package com.sovereign.runtime.android.gateway

import com.sovereign.runtime.android.runtime.AuthorityProfile
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

internal class NotificationMcpCatalogContractTest {
    @Test
    fun notificationToolsAreL1ReadOnlyAndActionToolsRemainAbsent() {
        val expected = setOf(
            "android.notification.status",
            "android.notification.list",
        )
        val definitions = AndroidToolCatalog.definitions
            .filter { definition -> definition.name.startsWith("android.notification.") }

        assertEquals(expected, definitions.map { definition -> definition.name }.toSet())
        assertEquals(2, definitions.size)
        for (definition in definitions) {
            assertEquals(AuthorityProfile.OBSERVE, definition.requiredAuthority)
            assertTrue(definition.readOnly)
        }
        for (forbidden in listOf(
            "android.notification.open",
            "android.notification.reply",
            "android.notification.dismiss",
            "android.notification.clear",
            "android.notification.action",
        )) {
            assertFalse(
                AndroidToolCatalog.definitions.any { definition -> definition.name == forbidden },
            )
        }
    }
}
