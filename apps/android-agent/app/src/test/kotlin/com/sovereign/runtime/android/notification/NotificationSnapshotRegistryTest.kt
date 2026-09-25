package com.sovereign.runtime.android.notification

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

internal class NotificationSnapshotRegistryTest {
    private var now = 1_000L
    private val registry = NotificationSnapshotRegistry(
        clock = NotificationElapsedClock { now },
        nonceGenerator = NotificationNonceGenerator { "fixedNonce_123" },
        maximumRecords = 2,
        maximumActionAgeMs = 100,
    )

    @Test
    fun publishesBoundedNewestFirstRecordsWithoutExposingSourceKeys() {
        val snapshot = publish(
            listOf(
                draft(key = "raw-key-old", packageName = "com.example.old", postedAt = 10),
                draft(key = "raw-key-new", packageName = "com.example.new", postedAt = 30),
                draft(key = "raw-key-mid", packageName = "com.example.mid", postedAt = 20),
            ),
        )
        assertEquals(2, snapshot.records.size)
        assertEquals(9L, snapshot.policyRevision)
        assertEquals(
            listOf("com.example.new", "com.example.mid"),
            snapshot.records.map(NotificationRecord::packageName),
        )
        assertFalse(snapshot.toString().contains("raw-key"))
        assertTrue(snapshot.records.all { record ->
            record.ref.startsWith("notif_r1_n") && record.ref.endsWith("_fixedNonce_123")
        })
    }

    @Test
    fun resolvesOnlyCurrentRevisionPackageAndUnexpiredRef() {
        val snapshot = publish(
            listOf(draft(key = "source-key", packageName = "com.example.app", postedAt = 10)),
        )
        val record = snapshot.records.single()
        val resolved = registry.resolve(
            NotificationTarget(snapshot.revision, record.ref, record.packageName),
        )
        assertTrue(resolved is NotificationTargetResolution.Resolved)
        assertEquals(
            "source-key",
            (resolved as NotificationTargetResolution.Resolved).sourceKey,
        )

        assertRejected(
            "notification_snapshot_stale",
            NotificationTarget(snapshot.revision - 1, record.ref, record.packageName),
        )
        assertRejected(
            "notification_package_mismatch",
            NotificationTarget(snapshot.revision, record.ref, "com.other.app"),
        )
        assertRejected(
            "notification_ref_unknown",
            NotificationTarget(snapshot.revision, "forged", record.packageName),
        )
        now += 101
        assertRejected(
            "notification_snapshot_expired",
            NotificationTarget(snapshot.revision, record.ref, record.packageName),
        )
    }

    @Test
    fun publishingAgainAndInvalidatingRejectOldReferences() {
        val first = publish(
            listOf(draft(key = "first", packageName = "com.example.app", postedAt = 10)),
        )
        val firstRecord = first.records.single()
        now += 1
        val second = publish(
            listOf(draft(key = "second", packageName = "com.example.app", postedAt = 20)),
        )
        assertTrue(second.revision > first.revision)
        assertRejected(
            "notification_snapshot_stale",
            NotificationTarget(first.revision, firstRecord.ref, firstRecord.packageName),
        )
        registry.invalidate()
        assertRejected(
            "notification_snapshot_missing",
            NotificationTarget(
                second.revision,
                second.records.single().ref,
                second.records.single().packageName,
            ),
        )
    }

    @Test(expected = IllegalArgumentException::class)
    fun duplicateSourceKeysFailClosed() {
        publish(
            listOf(
                draft(key = "duplicate", packageName = "com.example.one", postedAt = 10),
                draft(key = "duplicate", packageName = "com.example.two", postedAt = 20),
            ),
        )
    }

    @Test(expected = IllegalArgumentException::class)
    fun policyRevisionMustBePositive() {
        registry.publish(emptyList(), policyRevision = 0)
    }

    private fun publish(drafts: List<NotificationDraft>): NotificationSnapshot =
        registry.publish(drafts = drafts, policyRevision = 9)

    private fun assertRejected(reason: String, target: NotificationTarget) {
        val result = registry.resolve(target)
        assertTrue(result is NotificationTargetResolution.Rejected)
        assertEquals(reason, (result as NotificationTargetResolution.Rejected).reasonCode)
    }

    private fun draft(
        key: String,
        packageName: String,
        postedAt: Long,
    ): NotificationDraft = NotificationDraft(
        sourceKey = key,
        packageName = packageName,
        postedAtEpochMs = postedAt,
        title = "Title",
        text = "Text",
        subText = null,
        category = "msg",
        ongoing = false,
        clearable = true,
        hasContentIntent = true,
        actionCount = 1,
        sensitivity = NotificationSensitivity.NORMAL,
    )
}
