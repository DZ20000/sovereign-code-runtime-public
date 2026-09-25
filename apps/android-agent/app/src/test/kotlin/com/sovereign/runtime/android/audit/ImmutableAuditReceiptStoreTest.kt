package com.sovereign.runtime.android.audit

import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardOpenOption
import java.util.UUID
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ImmutableAuditReceiptStoreTest {
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
    fun appendsIntentAndResultAsAHashChainedImmutableSequence() = runTest {
        val store = store()
        val correlationId = UUID.randomUUID().toString()
        val intent = store.append(input(
            correlationId = correlationId,
            phase = AuditReceiptPhase.INTENT,
            outcome = AuditReceiptOutcome.REQUESTED,
        )).receipt
        val result = store.append(input(
            correlationId = correlationId,
            phase = AuditReceiptPhase.RESULT,
            outcome = AuditReceiptOutcome.SUCCEEDED,
            resultSha256 = digestAuditJson(buildJsonObject { put("ok", true) }),
        )).receipt

        assertEquals(1L, intent.sequence)
        assertNull(intent.previousReceiptSha256)
        assertEquals(2L, result.sequence)
        assertEquals(intent.receiptSha256, result.previousReceiptSha256)
        assertEquals(result, store.verify())
        assertEquals(listOf(intent, result), store.recent(10))
    }

    @Test
    fun receiptFilesNeverContainRawTextSessionOrBearerMaterial() = runTest {
        val root = root()
        val directory = root.resolve("audit")
        val store = ImmutableAuditReceiptStore(directory)
        val rawText = "secret message from the user"
        val sessionId = "mcp-session-${UUID.randomUUID()}"
        val bearer = "Bearer " + "A".repeat(43)
        val arguments = buildJsonObject {
            put("revision", "ui_deadbeef")
            put("ref", "n1")
            put("text", rawText)
            put("authorization", bearer)
        }
        store.append(input(
            correlationId = UUID.randomUUID().toString(),
            phase = AuditReceiptPhase.INTENT,
            outcome = AuditReceiptOutcome.REQUESTED,
            principal = principalFingerprint(sessionId),
            argumentsSha256 = digestAuditJson(arguments),
            argumentNames = arguments.keys.toList(),
        ))

        val bytes = Files.readAllBytes(
            directory.resolve("receipt-0000000000000001.json"),
        ).toString(StandardCharsets.UTF_8)
        assertFalse(bytes.contains(rawText))
        assertFalse(bytes.contains(sessionId))
        assertFalse(bytes.contains(bearer))
        assertTrue(bytes.contains(digestAuditJson(arguments)))
    }

    @Test
    fun concurrentAppendsProduceOneContiguousChain() = runTest {
        val store = store()
        val receipts = (1..24).map {
            async {
                store.append(input(
                    correlationId = UUID.randomUUID().toString(),
                    phase = AuditReceiptPhase.INTENT,
                    outcome = AuditReceiptOutcome.REQUESTED,
                )).receipt
            }
        }.awaitAll().sortedBy(AndroidAuditReceipt::sequence)

        assertEquals((1L..24L).toList(), receipts.map(AndroidAuditReceipt::sequence))
        receipts.zipWithNext().forEach { (left, right) ->
            assertEquals(left.receiptSha256, right.previousReceiptSha256)
        }
        assertEquals(24L, store.verify()?.sequence)
    }

    @Test
    fun tamperingGapUnexpectedEntryAndSymlinkFailClosed() = runTest {
        val tamperRoot = root()
        val tamperStore = ImmutableAuditReceiptStore(tamperRoot.resolve("audit"))
        tamperStore.append(input(
            correlationId = UUID.randomUUID().toString(),
            phase = AuditReceiptPhase.INTENT,
            outcome = AuditReceiptOutcome.REQUESTED,
        ))
        Files.write(
            tamperRoot.resolve("audit/receipt-0000000000000001.json"),
            " ".toByteArray(StandardCharsets.UTF_8),
            StandardOpenOption.APPEND,
        )
        assertAuditCode("AUDIT_CORRUPT") { tamperStore.verify() }

        val gapRoot = root()
        val gapDirectory = gapRoot.resolve("audit")
        Files.createDirectory(gapDirectory)
        Files.write(
            gapDirectory.resolve("receipt-0000000000000002.json"),
            "{}".toByteArray(StandardCharsets.UTF_8),
        )
        assertAuditCode("AUDIT_CORRUPT") {
            ImmutableAuditReceiptStore(gapDirectory).verify()
        }

        val unexpectedRoot = root()
        val unexpectedDirectory = unexpectedRoot.resolve("audit")
        Files.createDirectory(unexpectedDirectory)
        Files.write(
            unexpectedDirectory.resolve("notes.txt"),
            "unexpected".toByteArray(StandardCharsets.UTF_8),
        )
        assertAuditCode("AUDIT_CORRUPT") {
            ImmutableAuditReceiptStore(unexpectedDirectory).verify()
        }

        val symlinkRoot = root()
        val target = symlinkRoot.resolve("real-audit")
        Files.createDirectory(target)
        val linked = symlinkRoot.resolve("linked-audit")
        try {
            Files.createSymbolicLink(linked, target)
        } catch (_: UnsupportedOperationException) {
            return@runTest
        } catch (error: java.nio.file.FileSystemException) {
            if (System.getProperty("os.name").orEmpty().contains("Windows", ignoreCase = true)) {
                return@runTest
            }
            throw error
        }
        assertAuditCode("AUDIT_PATH_UNSAFE") {
            ImmutableAuditReceiptStore(linked).verify()
        }
    }

    @Test
    fun orphanTemporaryFileIsIgnoredButBoundedAndReceiptLimitIsEnforced() = runTest {
        val root = root()
        val directory = root.resolve("audit")
        val store = ImmutableAuditReceiptStore(directory, maximumReceipts = 1)
        val receipt = store.append(input(
            correlationId = UUID.randomUUID().toString(),
            phase = AuditReceiptPhase.INTENT,
            outcome = AuditReceiptOutcome.REQUESTED,
        )).receipt
        Files.write(
            directory.resolve(".receipt-${UUID.randomUUID()}.tmp"),
            "partial".toByteArray(StandardCharsets.UTF_8),
        )
        assertEquals(receipt, store.verify())
        assertAuditCode("AUDIT_LIMIT_REACHED") {
            store.append(input(
                correlationId = UUID.randomUUID().toString(),
                phase = AuditReceiptPhase.INTENT,
                outcome = AuditReceiptOutcome.REQUESTED,
            ))
        }
    }

    @Test
    fun validatesPhaseOutcomeAndDigestShapesBeforeWriting() = runTest {
        val store = store()
        val invalid = input(
            correlationId = UUID.randomUUID().toString(),
            phase = AuditReceiptPhase.INTENT,
            outcome = AuditReceiptOutcome.SUCCEEDED,
        )
        val error = runCatching { store.append(invalid) }.exceptionOrNull()
        assertTrue(error is IllegalArgumentException)
        assertNull(store.verify())
    }

    private fun input(
        correlationId: String,
        phase: AuditReceiptPhase,
        outcome: AuditReceiptOutcome,
        principal: String = principalFingerprint("session-1"),
        argumentNames: List<String> = listOf("revision", "ref"),
        argumentsSha256: String = sha256Hex("arguments"),
        resultSha256: String? = null,
    ): AuditReceiptInput = AuditReceiptInput(
        correlationId = correlationId,
        phase = phase,
        principalFingerprint = principal,
        toolName = "android.ui.click",
        authority = "L2 Interaction",
        readOnly = false,
        outcome = outcome,
        argumentNames = argumentNames,
        argumentsSha256 = argumentsSha256,
        resultSha256 = resultSha256,
        uiRevisionSha256 = sha256Hex("ui_revision"),
        uiRef = "n1",
    )

    private fun store(): ImmutableAuditReceiptStore =
        ImmutableAuditReceiptStore(root().resolve("audit"))

    private fun root(): Path = Files.createTempDirectory("sar-audit-test-").also(cleanup::add)

    private suspend fun assertAuditCode(
        code: String,
        operation: suspend () -> Unit,
    ) {
        val error = runCatching { operation() }.exceptionOrNull()
        assertTrue("Expected AuditStoreException($code), got $error", error is AuditStoreException)
        assertEquals("Unexpected audit error code for $error", code, (error as AuditStoreException).code)
    }
}
