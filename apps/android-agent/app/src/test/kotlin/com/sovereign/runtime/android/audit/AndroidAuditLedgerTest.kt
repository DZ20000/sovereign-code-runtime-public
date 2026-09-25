package com.sovereign.runtime.android.audit

import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardOpenOption
import java.util.UUID
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AndroidAuditLedgerTest {
    private val cleanup = mutableListOf<Path>()

    @After
    fun tearDown() {
        cleanup.asReversed().forEach { path ->
            runCatching {
                Files.walk(path).sorted(Comparator.reverseOrder()).forEach(Files::deleteIfExists)
            }
        }
        cleanup.clear()
    }

    @Test
    fun verifiesEmptyStoreAndTracksSuccessfulAppend() = runTest {
        val ledger = ledger()
        val initial = ledger.verify()
        assertEquals(AndroidAuditLedgerPhase.READY, initial.phase)
        assertNull(initial.lastSequence)

        val receipt = ledger.append(intent())
        val state = ledger.state.value
        assertEquals(AndroidAuditLedgerPhase.READY, state.phase)
        assertEquals(receipt.sequence, state.lastSequence)
        assertEquals(receipt.receiptSha256, state.lastReceiptSha256)
        assertNotNull(state.directorySyncCompleted)
        assertNull(state.errorCode)
    }

    @Test
    fun corruptionMovesLedgerToErrorAndFailsClosed() = runTest {
        val root = root()
        val store = ImmutableAuditReceiptStore(root.resolve("audit"))
        val ledger = AndroidAuditLedger(store)
        ledger.append(intent())
        Files.write(
            root.resolve("audit/receipt-0000000000000001.json"),
            " ".toByteArray(StandardCharsets.UTF_8),
            StandardOpenOption.APPEND,
        )

        val error = runCatching { ledger.verify() }.exceptionOrNull()
        assertTrue(error is AuditStoreException)
        assertEquals(AndroidAuditLedgerPhase.ERROR, ledger.state.value.phase)
        assertEquals("AUDIT_CORRUPT", ledger.state.value.errorCode)
        assertTrue(ledger.state.value.errorMessage.orEmpty().isNotBlank())
    }

    private fun ledger(): AndroidAuditLedger = AndroidAuditLedger(
        ImmutableAuditReceiptStore(root().resolve("audit")),
    )

    private fun root(): Path = Files.createTempDirectory("sar-ledger-test-").also(cleanup::add)

    private fun intent(): AuditReceiptInput = AuditReceiptInput(
        correlationId = UUID.randomUUID().toString(),
        phase = AuditReceiptPhase.INTENT,
        principalFingerprint = principalFingerprint("test-session"),
        toolName = "android.ui.observe",
        authority = "L1 Observe",
        readOnly = true,
        outcome = AuditReceiptOutcome.REQUESTED,
        argumentNames = emptyList(),
        argumentsSha256 = sha256Hex("{}"),
    )
}
