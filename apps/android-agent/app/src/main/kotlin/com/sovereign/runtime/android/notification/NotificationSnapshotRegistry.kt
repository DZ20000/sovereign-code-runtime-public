package com.sovereign.runtime.android.notification

import java.security.SecureRandom
import java.util.Base64

internal fun interface NotificationElapsedClock {
    fun nowMs(): Long
}

internal fun interface NotificationNonceGenerator {
    fun nextNonce(): String
}

internal class NotificationSnapshotRegistry(
    private val clock: NotificationElapsedClock,
    private val sanitizer: NotificationTextSanitizer = NotificationTextSanitizer(),
    private val nonceGenerator: NotificationNonceGenerator = NotificationNonceGenerator {
        ByteArray(12).also(SecureRandom()::nextBytes).let { bytes ->
            Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
        }
    },
    private val maximumRecords: Int = 128,
    private val maximumActionAgeMs: Long = 30_000,
) {
    init {
        require(maximumRecords in 1..512) { "maximumRecords is outside its allowed range." }
        require(maximumActionAgeMs in 1..300_000) {
            "maximumActionAgeMs is outside its allowed range."
        }
    }

    private var nextRevision = 1L
    private var currentSnapshot: NotificationSnapshot? = null
    private var sourceKeysByRef: Map<String, String> = emptyMap()

    @Synchronized
    fun publish(
        drafts: List<NotificationDraft>,
        policyRevision: Long,
    ): NotificationSnapshot {
        require(policyRevision >= 1) {
            "Notification policy revision must be positive."
        }
        val revision = nextRevision
        check(revision < Long.MAX_VALUE) { "Notification revision limit reached." }
        nextRevision += 1
        val nonce = nonceGenerator.nextNonce()
        require(nonce.matches(Regex("^[A-Za-z0-9_-]{8,128}$"))) {
            "Notification nonce has an invalid shape."
        }
        val seenKeys = HashSet<String>()
        val boundedDrafts = drafts
            .onEach { draft ->
                require(draft.sourceKey.length in 1..1_024) {
                    "Notification source key has an invalid shape."
                }
                require(seenKeys.add(draft.sourceKey)) {
                    "Notification source key is duplicated."
                }
                require(draft.packageName.matches(Regex("^[A-Za-z0-9_.]{1,255}$"))) {
                    "Notification package name has an invalid shape."
                }
                require(draft.postedAtEpochMs >= 0) {
                    "Notification post timestamp must be non-negative."
                }
                require(draft.actionCount in 0..64) {
                    "Notification action count exceeds its limit."
                }
            }
            .sortedWith(
                compareByDescending<NotificationDraft> { it.postedAtEpochMs }
                    .thenBy { it.packageName }
                    .thenBy { it.sourceKey },
            )
            .take(maximumRecords)

        val sourceKeys = LinkedHashMap<String, String>(boundedDrafts.size)
        val records = boundedDrafts.mapIndexed { index, draft ->
            val ref = "notif_r${revision}_n${index}_$nonce"
            sourceKeys[ref] = draft.sourceKey
            sanitizer.sanitize(draft, ref)
        }
        return NotificationSnapshot(
            revision = revision,
            nonce = nonce,
            policyRevision = policyRevision,
            observedAtElapsedMs = clock.nowMs(),
            records = records,
        ).also { snapshot ->
            currentSnapshot = snapshot
            sourceKeysByRef = sourceKeys
        }
    }

    @Synchronized
    fun current(): NotificationSnapshot? = currentSnapshot

    @Synchronized
    fun invalidate() {
        currentSnapshot = null
        sourceKeysByRef = emptyMap()
    }

    @Synchronized
    fun resolve(target: NotificationTarget): NotificationTargetResolution {
        val snapshot = currentSnapshot ?: return NotificationTargetResolution.Rejected(
            reasonCode = "notification_snapshot_missing",
            explanation = "List notifications before acting on one.",
        )
        if (target.revision != snapshot.revision) {
            return NotificationTargetResolution.Rejected(
                reasonCode = "notification_snapshot_stale",
                explanation = "The notification set changed after this reference was issued.",
            )
        }
        val age = clock.nowMs() - snapshot.observedAtElapsedMs
        if (age < 0 || age > maximumActionAgeMs) {
            return NotificationTargetResolution.Rejected(
                reasonCode = "notification_snapshot_expired",
                explanation = "The notification observation is too old to act on safely.",
            )
        }
        val record = snapshot.records.firstOrNull { record -> record.ref == target.ref }
            ?: return NotificationTargetResolution.Rejected(
                reasonCode = "notification_ref_unknown",
                explanation = "The notification reference does not exist in the current observation.",
            )
        if (record.packageName != target.packageName) {
            return NotificationTargetResolution.Rejected(
                reasonCode = "notification_package_mismatch",
                explanation = "The notification reference belongs to another package.",
            )
        }
        val sourceKey = sourceKeysByRef[target.ref]
            ?: return NotificationTargetResolution.Rejected(
                reasonCode = "notification_source_missing",
                explanation = "The internal notification identity is no longer available.",
            )
        return NotificationTargetResolution.Resolved(snapshot, record, sourceKey)
    }
}
