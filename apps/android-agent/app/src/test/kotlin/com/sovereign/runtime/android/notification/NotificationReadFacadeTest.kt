package com.sovereign.runtime.android.notification

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

internal class NotificationReadFacadeTest {
    @Test
    fun statusAndListExposeOnlyBoundedPublicRecords() {
        val source = FakeRuntimeView(
            connected = true,
            policyRevision = 4,
            snapshot = snapshot(),
            errorCode = null,
        )
        val facade = NotificationReadFacade(source)
        val status = facade.status()
        assertEquals(true, status.listenerConnected)
        assertEquals(4L, status.policyRevision)
        assertEquals(8L, status.snapshotRevision)
        assertEquals(2, status.recordCount)

        val list = facade.list(1)
        assertTrue(list.available)
        assertEquals(1, list.records.size)
        val json = notificationListToJson(list).toString()
        assertTrue(json.contains(NOTIFICATION_LIST_SCHEMA_VERSION))
        assertTrue(json.contains("notif_public_1"))
        assertFalse(json.contains("android-raw-key"))
        assertFalse(json.contains("secret bearer"))
    }

    @Test
    fun disconnectedRuntimeReturnsUnavailableEmptyListAndBoundedErrorCode() {
        val facade = NotificationReadFacade(
            FakeRuntimeView(
                connected = false,
                policyRevision = 7,
                snapshot = null,
                errorCode = "LISTENER_DISCONNECTED",
            ),
        )
        val status = facade.status()
        assertEquals("LISTENER_DISCONNECTED", status.lastErrorCode)
        assertNull(status.snapshotRevision)
        assertEquals(0, status.recordCount)

        val list = facade.list(128)
        assertFalse(list.available)
        assertTrue(list.records.isEmpty())
        assertTrue(
            notificationStatusToJson(status).toString().contains(NOTIFICATION_STATUS_SCHEMA_VERSION),
        )
    }

    @Test
    fun listLimitIsStrictlyBounded() {
        val facade = NotificationReadFacade(FakeRuntimeView(true, 1, snapshot(), null))
        assertTrue(runCatching { facade.list(0) }.exceptionOrNull() is IllegalArgumentException)
        assertTrue(runCatching { facade.list(129) }.exceptionOrNull() is IllegalArgumentException)
    }

    private fun snapshot() = NotificationSnapshot(
        revision = 8,
        nonce = "publicNonce_123",
        policyRevision = 4,
        observedAtElapsedMs = 1_000,
        records = listOf(
            record("notif_public_1", "com.example.one"),
            record("notif_public_2", "com.example.two"),
        ),
    )

    private fun record(ref: String, packageName: String) = NotificationRecord(
        ref = ref,
        packageName = packageName,
        postedAtEpochMs = 100,
        title = "[REDACTED_NOTIFICATION]",
        text = null,
        subText = null,
        category = "msg",
        ongoing = false,
        clearable = true,
        hasContentIntent = true,
        actionCount = 1,
        redacted = true,
        redactionReason = "sensitive_notification",
    )

    private data class FakeRuntimeView(
        val connected: Boolean,
        val policyRevision: Long,
        val snapshot: NotificationSnapshot?,
        val errorCode: String?,
    ) : AndroidNotificationRuntimeView {
        override fun listenerConnected() = connected
        override fun policyRevision() = policyRevision
        override fun snapshot() = snapshot
        override fun lastErrorCode() = errorCode
    }
}
