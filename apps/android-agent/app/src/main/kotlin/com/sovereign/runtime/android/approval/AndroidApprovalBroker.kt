package com.sovereign.runtime.android.approval

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull

fun interface AndroidApprovalRequester {
    suspend fun request(input: AndroidApprovalRequestInput): AndroidApprovalResult
}

class AndroidApprovalBroker(
    private val timeoutMs: Long = 30_000L,
    private val maximumPending: Int = 8,
    private val maximumRetiredRequestIds: Int = 4_096,
    private val burstWindowMs: Long = 10_000L,
    private val burstThreshold: Int = 5,
    private val now: () -> Long,
) : AndroidApprovalRequester {
    init {
        require(timeoutMs in 1_000L..300_000L) {
            "Approval timeout must be from 1000 through 300000 milliseconds."
        }
        require(maximumPending in 1..64) {
            "Approval pending limit must be from 1 through 64."
        }
        require(maximumRetiredRequestIds in 64..65_536) {
            "Approval retired-request limit must be from 64 through 65536."
        }
        require(burstWindowMs in 1_000L..300_000L) {
            "Approval burst window must be from 1000 through 300000 milliseconds."
        }
        require(burstThreshold in 2..64) {
            "Approval burst threshold must be from 2 through 64."
        }
    }

    private data class PendingApproval(
        val presentation: AndroidApprovalPresentation,
        val result: CompletableDeferred<AndroidApprovalResult>,
    )

    private val mutex = Mutex()
    private val queue = ArrayDeque<PendingApproval>()
    private val pendingRequestIds = mutableSetOf<String>()
    private val retiredRequestIds = mutableSetOf<String>()
    private val retiredRequestOrder = ArrayDeque<String>()
    private val recentRequestTimes = ArrayDeque<Long>()
    private var active: PendingApproval? = null
    private val mutableState = MutableStateFlow(AndroidApprovalBrokerState())

    val state: StateFlow<AndroidApprovalBrokerState> = mutableState.asStateFlow()

    override suspend fun request(input: AndroidApprovalRequestInput): AndroidApprovalResult {
        val validated = validateApprovalRequest(input)
        val requestedAt = now().also { timestamp ->
            require(timestamp >= 0) { "Approval elapsed timestamp must be non-negative." }
        }
        val expiresAt = requestedAt + timeoutMs
        require(expiresAt >= requestedAt) {
            "Approval expiry overflowed the elapsed-time range."
        }
        val result = CompletableDeferred<AndroidApprovalResult>()
        val rejection = mutex.withLock {
            recordRequestTimeLocked(requestedAt)
            when {
                validated.requestId in pendingRequestIds ||
                    validated.requestId in retiredRequestIds ->
                    AndroidApprovalResolutionReason.DUPLICATE_REQUEST
                pendingCountLocked() >= maximumPending -> {
                    retireRequestIdLocked(validated.requestId)
                    AndroidApprovalResolutionReason.QUEUE_OVERFLOW
                }
                else -> {
                    val pending = PendingApproval(
                        presentation = AndroidApprovalPresentation(
                            requestId = validated.requestId,
                            principalFingerprint = validated.principalFingerprint,
                            toolName = validated.toolName,
                            title = validated.title,
                            message = validated.message,
                            detail = validated.detail,
                            argumentsSha256 = validated.argumentsSha256,
                            requestedAtElapsedMs = requestedAt,
                            expiresAtElapsedMs = expiresAt,
                            burstDetected = recentRequestTimes.size >= burstThreshold,
                        ),
                        result = result,
                    )
                    check(pendingRequestIds.add(validated.requestId)) {
                        "Approval request identity was not unique."
                    }
                    queue.addLast(pending)
                    activateNextLocked()
                    null
                }
            }
        }
        if (rejection != null) {
            return AndroidApprovalResult(
                requestId = validated.requestId,
                decision = AndroidApprovalDecision.DENY,
                reason = rejection,
            )
        }

        try {
            val remainingMs = mutex.withLock {
                val pending = findPendingLocked(validated.requestId)
                (pending?.presentation?.expiresAtElapsedMs ?: requestedAt) - now()
            }.coerceAtLeast(1L)
            val completed = withTimeoutOrNull(remainingMs) { result.await() }
            if (completed != null) return completed
            settle(
                requestId = validated.requestId,
                decision = AndroidApprovalDecision.DENY,
                reason = AndroidApprovalResolutionReason.TIMEOUT,
                allowQueued = true,
            )
            return result.await()
        } catch (error: CancellationException) {
            settle(
                requestId = validated.requestId,
                decision = AndroidApprovalDecision.DENY,
                reason = AndroidApprovalResolutionReason.CANCELLED,
                allowQueued = true,
            )
            throw error
        }
    }

    suspend fun resolve(
        requestId: String,
        decision: AndroidApprovalDecision,
    ): Boolean = settle(
        requestId = requestId,
        decision = decision,
        reason = if (decision == AndroidApprovalDecision.ALLOW_ONCE) {
            AndroidApprovalResolutionReason.LOCAL_ALLOW
        } else {
            AndroidApprovalResolutionReason.LOCAL_DENY
        },
        allowQueued = false,
    )

    suspend fun cancelAll(
        reason: AndroidApprovalResolutionReason = AndroidApprovalResolutionReason.CANCELLED,
    ) {
        require(reason in setOf(
            AndroidApprovalResolutionReason.TIMEOUT,
            AndroidApprovalResolutionReason.CANCELLED,
            AndroidApprovalResolutionReason.GATEWAY_STOP,
        )) {
            "cancelAll requires a cancellation reason."
        }
        mutex.withLock {
            active?.let { current ->
                completeLocked(
                    pending = current,
                    decision = AndroidApprovalDecision.DENY,
                    reason = reason,
                )
            }
            active = null
            while (queue.isNotEmpty()) {
                completeLocked(
                    pending = queue.removeFirst(),
                    decision = AndroidApprovalDecision.DENY,
                    reason = reason,
                )
            }
            publishStateLocked()
        }
    }

    private suspend fun settle(
        requestId: String,
        decision: AndroidApprovalDecision,
        reason: AndroidApprovalResolutionReason,
        allowQueued: Boolean,
    ): Boolean = mutex.withLock {
        val current = active
        if (current?.presentation?.requestId == requestId) {
            val localResolution = reason in setOf(
                AndroidApprovalResolutionReason.LOCAL_ALLOW,
                AndroidApprovalResolutionReason.LOCAL_DENY,
            )
            if (
                localResolution &&
                current.presentation.expiresAtElapsedMs <= now()
            ) {
                active = null
                completeLocked(
                    pending = current,
                    decision = AndroidApprovalDecision.DENY,
                    reason = AndroidApprovalResolutionReason.TIMEOUT,
                )
                activateNextLocked()
                return@withLock false
            }
            active = null
            completeLocked(current, decision, reason)
            activateNextLocked()
            return@withLock true
        }
        if (!allowQueued) return@withLock false

        val retained = ArrayDeque<PendingApproval>()
        var matched: PendingApproval? = null
        while (queue.isNotEmpty()) {
            val candidate = queue.removeFirst()
            if (matched == null && candidate.presentation.requestId == requestId) {
                matched = candidate
            } else {
                retained.addLast(candidate)
            }
        }
        queue.addAll(retained)
        val pending = matched ?: return@withLock false
        completeLocked(pending, decision, reason)
        publishStateLocked()
        true
    }

    private fun activateNextLocked() {
        if (active != null) {
            publishStateLocked()
            return
        }
        val timestamp = now()
        while (queue.isNotEmpty()) {
            val candidate = queue.removeFirst()
            if (candidate.presentation.expiresAtElapsedMs <= timestamp) {
                completeLocked(
                    pending = candidate,
                    decision = AndroidApprovalDecision.DENY,
                    reason = AndroidApprovalResolutionReason.TIMEOUT,
                )
            } else {
                active = candidate
                break
            }
        }
        publishStateLocked()
    }

    private fun completeLocked(
        pending: PendingApproval,
        decision: AndroidApprovalDecision,
        reason: AndroidApprovalResolutionReason,
    ) {
        pendingRequestIds.remove(pending.presentation.requestId)
        retireRequestIdLocked(pending.presentation.requestId)
        pending.result.complete(
            AndroidApprovalResult(
                requestId = pending.presentation.requestId,
                decision = decision,
                reason = reason,
            ),
        )
    }

    private fun retireRequestIdLocked(requestId: String) {
        if (!retiredRequestIds.add(requestId)) return
        retiredRequestOrder.addLast(requestId)
        while (retiredRequestOrder.size > maximumRetiredRequestIds) {
            retiredRequestIds.remove(retiredRequestOrder.removeFirst())
        }
    }

    private fun findPendingLocked(requestId: String): PendingApproval? {
        if (active?.presentation?.requestId == requestId) return active
        return queue.firstOrNull { pending -> pending.presentation.requestId == requestId }
    }

    private fun publishStateLocked() {
        mutableState.value = AndroidApprovalBrokerState(
            active = active?.presentation,
            queuedCount = queue.size,
        )
    }

    private fun pendingCountLocked(): Int = queue.size + if (active == null) 0 else 1

    private fun recordRequestTimeLocked(timestamp: Long) {
        recentRequestTimes.addLast(timestamp)
        while (
            recentRequestTimes.isNotEmpty() &&
            timestamp - recentRequestTimes.first() > burstWindowMs
        ) {
            recentRequestTimes.removeFirst()
        }
        // Only the threshold matters after pruning. Keep the newest threshold
        // samples so duplicate/overflow floods cannot grow process memory.
        while (recentRequestTimes.size > burstThreshold) {
            recentRequestTimes.removeFirst()
        }
    }
}
