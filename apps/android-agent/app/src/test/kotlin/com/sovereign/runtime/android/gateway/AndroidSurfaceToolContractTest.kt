package com.sovereign.runtime.android.gateway

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class AndroidSurfaceToolContractTest {
    @Test
    fun screenPayloadContractIsReadOnlyAndDoesNotOwnNotificationTools() {
        assertEquals(
            setOf("android.screen.capture"),
            AndroidSurfaceToolContract.readOnlyTools,
        )
        assertFalse("android.screen.read" in AndroidSurfaceToolContract.readOnlyTools)
        assertFalse("android.notification.list" in AndroidSurfaceToolContract.readOnlyTools)
        assertFalse("android.notification.open" in AndroidSurfaceToolContract.readOnlyTools)
        assertFalse("android.notification.reply" in AndroidSurfaceToolContract.readOnlyTools)
    }
}
