package com.sovereign.runtime.android.accessibility

import java.security.SecureRandom
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

class StaleUiRevisionException(
    message: String,
) : IllegalStateException(message)

class UnknownUiRefException(
    message: String,
) : IllegalArgumentException(message)

class UiSnapshotRegistry(
    secureRandom: SecureRandom = SecureRandom(),
) {
    private data class Published(
        val snapshot: UiSnapshot,
        val locators: Map<String, NodeLocator>,
    )

    private val processNonce = ByteArray(12).also(secureRandom::nextBytes)
        .joinToString(separator = "") { byte -> "%02x".format(byte) }
    private val sequence = AtomicLong(0)
    private val lock = Any()
    private var published: Published? = null
    private val mutableSnapshot = MutableStateFlow<UiSnapshot?>(null)

    val snapshot: StateFlow<UiSnapshot?> = mutableSnapshot.asStateFlow()

    fun publish(draft: UiSnapshotDraft): UiSnapshot = synchronized(lock) {
        val nextSequence = sequence.incrementAndGet()
        check(nextSequence > 0) { "UI snapshot revision counter overflowed." }
        val revision = "ui_${processNonce}_${nextSequence.toString(36)}"
        val snapshot = UiSnapshot(
            revision = revision,
            capturedAtEpochMs = draft.capturedAtEpochMs,
            windowId = draft.windowId,
            packageName = draft.packageName,
            nodes = draft.nodes,
            truncated = draft.truncated,
            redactionCount = draft.redactionCount,
        )
        published = Published(snapshot = snapshot, locators = draft.locators.toMap())
        mutableSnapshot.value = snapshot
        snapshot
    }

    fun requireRevision(revision: String): UiSnapshot = synchronized(lock) {
        val current = published ?: throw StaleUiRevisionException(
            "No current UI snapshot exists. Observe the screen before acting.",
        )
        if (revision != current.snapshot.revision) {
            throw StaleUiRevisionException(
                "UI revision is stale. Expected ${current.snapshot.revision}; observe again before acting.",
            )
        }
        current.snapshot
    }

    fun requireLocator(
        revision: String,
        ref: String,
    ): NodeLocator = synchronized(lock) {
        requireRevision(revision)
        published?.locators?.get(ref) ?: throw UnknownUiRefException(
            "Unknown UI ref '$ref' for the current revision.",
        )
    }

    fun invalidate(@Suppress("UNUSED_PARAMETER") reason: String) {
        synchronized(lock) {
            published = null
            mutableSnapshot.value = null
        }
    }

    fun currentRevision(): String? = synchronized(lock) {
        published?.snapshot?.revision
    }
}
