package com.sovereign.runtime.android.audit

import android.content.Context
import java.nio.file.Path
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

const val ANDROID_AUDIT_LEDGER_STATE_SCHEMA_VERSION = "sar.audit-ledger-state/v1"

enum class AndroidAuditLedgerPhase {
    UNVERIFIED,
    READY,
    ERROR,
}

data class AndroidAuditLedgerState(
    val schemaVersion: String = ANDROID_AUDIT_LEDGER_STATE_SCHEMA_VERSION,
    val phase: AndroidAuditLedgerPhase = AndroidAuditLedgerPhase.UNVERIFIED,
    val lastSequence: Long? = null,
    val lastReceiptSha256: String? = null,
    val directorySyncCompleted: Boolean? = null,
    val errorCode: String? = null,
    val errorMessage: String? = null,
)

class AndroidAuditLedger internal constructor(
    private val store: ImmutableAuditReceiptStore,
) {
    constructor(context: Context) : this(
        store = ImmutableAuditReceiptStore(
            auditDirectory(context.applicationContext),
        ),
    )

    private val mutableState = MutableStateFlow(AndroidAuditLedgerState())
    val state: StateFlow<AndroidAuditLedgerState> = mutableState.asStateFlow()

    suspend fun verify(): AndroidAuditLedgerState = try {
        val head = store.verify()
        AndroidAuditLedgerState(
            phase = AndroidAuditLedgerPhase.READY,
            lastSequence = head?.sequence,
            lastReceiptSha256 = head?.receiptSha256,
            directorySyncCompleted = mutableState.value.directorySyncCompleted,
        ).also { next -> mutableState.value = next }
    } catch (error: Throwable) {
        fail(error)
        throw error
    }

    suspend fun append(input: AuditReceiptInput): AndroidAuditReceipt = try {
        val appended = store.append(input)
        mutableState.value = AndroidAuditLedgerState(
            phase = AndroidAuditLedgerPhase.READY,
            lastSequence = appended.receipt.sequence,
            lastReceiptSha256 = appended.receipt.receiptSha256,
            directorySyncCompleted = appended.directorySyncCompleted,
        )
        appended.receipt
    } catch (error: Throwable) {
        fail(error)
        throw error
    }

    suspend fun recent(limit: Int): List<AndroidAuditReceipt> = try {
        if (mutableState.value.phase == AndroidAuditLedgerPhase.UNVERIFIED) {
            verify()
        }
        store.recent(limit)
    } catch (error: Throwable) {
        fail(error)
        throw error
    }

    private fun fail(error: Throwable) {
        mutableState.value = mutableState.value.copy(
            phase = AndroidAuditLedgerPhase.ERROR,
            errorCode = (error as? AuditStoreException)?.code ?: "AUDIT_UNAVAILABLE",
            errorMessage = boundedAuditError(error),
        )
    }

    private fun boundedAuditError(error: Throwable): String =
        (error.message ?: error::class.java.simpleName)
            .replace(Regex("[\\r\\n\\u0000]+"), " ")
            .replace(Regex("\\s+"), " ")
            .trim()
            .let { value ->
                when {
                    value.isEmpty() -> "The Android audit ledger is unavailable."
                    value.length <= 512 -> value
                    else -> value.take(511) + "…"
                }
            }

    companion object {
        private fun auditDirectory(context: Context): Path =
            context.noBackupFilesDir.toPath().resolve("audit-receipts")
    }
}
