package com.sovereign.runtime.android.audit

import java.nio.ByteBuffer
import java.nio.channels.FileChannel
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path
import java.nio.file.StandardOpenOption
import java.nio.file.attribute.BasicFileAttributes
import java.util.UUID
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject

private const val DEFAULT_MAXIMUM_RECEIPTS = 100_000
private const val DEFAULT_MAXIMUM_RECEIPT_BYTES = 64 * 1024
private const val MAXIMUM_TEMPORARY_FILES = 64

class AuditStoreException(
    val code: String,
    message: String,
    cause: Throwable? = null,
) : IllegalStateException(message, cause)

data class AuditAppendResult(
    val receipt: AndroidAuditReceipt,
    val directorySyncCompleted: Boolean,
)

class ImmutableAuditReceiptStore(
    directoryPath: Path,
    private val maximumReceipts: Int = DEFAULT_MAXIMUM_RECEIPTS,
    private val maximumReceiptBytes: Int = DEFAULT_MAXIMUM_RECEIPT_BYTES,
    private val now: () -> Long = System::currentTimeMillis,
    private val newId: () -> String = { UUID.randomUUID().toString() },
) {
    private val directory = directoryPath.toAbsolutePath().normalize()
    private val mutex = Mutex()
    private var initialized = false
    private var head: AndroidAuditReceipt? = null

    init {
        require(directory.isAbsolute) { "Audit directory must be absolute." }
        require(maximumReceipts in 1..1_000_000) {
            "maximumReceipts must be from 1 through 1000000."
        }
        require(maximumReceiptBytes in 1_024..1_048_576) {
            "maximumReceiptBytes must be from 1024 through 1048576."
        }
    }

    suspend fun append(input: AuditReceiptInput): AuditAppendResult = withContext(Dispatchers.IO) {
        mutex.withLock {
            initializeLocked()
            verifyHeadLocked()
            val current = head
            val nextSequence = (current?.sequence ?: 0L) + 1L
            if (nextSequence > maximumReceipts) {
                throw AuditStoreException(
                    code = "AUDIT_LIMIT_REACHED",
                    message = "The immutable Android audit receipt limit has been reached.",
                )
            }
            val receipt = createAuditReceipt(
                sequence = nextSequence,
                receiptId = newId(),
                occurredAtEpochMs = now().also { timestamp ->
                    require(timestamp >= 0) { "Audit timestamp must be non-negative." }
                },
                previousReceiptSha256 = current?.receiptSha256,
                input = input,
            )
            val bytes = (
                canonicalAuditJson(receiptToJson(receipt)) + "\n"
            ).toByteArray(StandardCharsets.UTF_8)
            if (bytes.size > maximumReceiptBytes) {
                throw AuditStoreException(
                    code = "AUDIT_RECEIPT_TOO_LARGE",
                    message = "The Android audit receipt exceeds its byte limit.",
                )
            }
            val temporaryName = ".receipt-${UUID.randomUUID()}.tmp"
            val temporaryPath = directory.resolve(temporaryName)
            val destinationPath = directory.resolve(formatAuditReceiptFileName(nextSequence))
            var published = false
            try {
                FileChannel.open(
                    temporaryPath,
                    StandardOpenOption.CREATE_NEW,
                    StandardOpenOption.WRITE,
                ).use { channel ->
                    var buffer = ByteBuffer.wrap(bytes)
                    while (buffer.hasRemaining()) {
                        if (channel.write(buffer) < 1) {
                            throw AuditStoreException(
                                code = "AUDIT_IO_FAILED",
                                message = "Audit receipt write made no progress.",
                            )
                        }
                    }
                    channel.force(true)
                }
                try {
                    Files.createLink(destinationPath, temporaryPath)
                    published = true
                } catch (error: Throwable) {
                    if (Files.exists(destinationPath, LinkOption.NOFOLLOW_LINKS)) {
                        throw AuditStoreException(
                            code = "AUDIT_CONFLICT",
                            message = "Another writer published the next audit receipt first.",
                            cause = error,
                        )
                    }
                    throw error
                }
                val directorySyncCompleted = syncDirectoryBestEffort(directory)
                val verified = readReceiptFileLocked(
                    path = destinationPath,
                    expectedSequence = nextSequence,
                    expectedPreviousSha256 = current?.receiptSha256,
                )
                if (verified != receipt) {
                    throw AuditStoreException(
                        code = "AUDIT_CORRUPT",
                        message = "Published audit receipt does not match the prepared receipt.",
                    )
                }
                head = verified
                AuditAppendResult(
                    receipt = verified,
                    directorySyncCompleted = directorySyncCompleted,
                )
            } catch (error: AuditStoreException) {
                throw error
            } catch (error: Throwable) {
                throw AuditStoreException(
                    code = if (published) "AUDIT_CORRUPT" else "AUDIT_IO_FAILED",
                    message = if (published) {
                        "The audit receipt was published but could not be verified."
                    } else {
                        "The audit receipt could not be published."
                    },
                    cause = error,
                )
            } finally {
                runCatching { Files.deleteIfExists(temporaryPath) }
            }
        }
    }

    suspend fun verify(): AndroidAuditReceipt? = withContext(Dispatchers.IO) {
        mutex.withLock {
            initialized = false
            head = null
            initializeLocked()
            head
        }
    }

    suspend fun recent(limit: Int): List<AndroidAuditReceipt> = withContext(Dispatchers.IO) {
        require(limit in 1..1_000) { "Audit receipt read limit must be from 1 through 1000." }
        mutex.withLock {
            initializeLocked()
            val currentHead = head ?: return@withLock emptyList()
            val first = maxOf(1L, currentHead.sequence - limit + 1L)
            (first..currentHead.sequence).map { sequence ->
                val previous = if (sequence == 1L) {
                    null
                } else {
                    readReceiptFileLocked(
                        path = directory.resolve(formatAuditReceiptFileName(sequence - 1L)),
                        expectedSequence = sequence - 1L,
                        expectedPreviousSha256 = if (sequence == 2L) null else null,
                        validatePrevious = false,
                    ).receiptSha256
                }
                readReceiptFileLocked(
                    path = directory.resolve(formatAuditReceiptFileName(sequence)),
                    expectedSequence = sequence,
                    expectedPreviousSha256 = previous,
                )
            }
        }
    }

    private fun initializeLocked() {
        if (initialized) return
        ensureSafeDirectory()
        val entries = Files.newDirectoryStream(directory).use { stream ->
            stream.map { path -> path.fileName.toString() }.toList()
        }
        val receiptSequences = mutableListOf<Long>()
        var temporaryCount = 0
        for (name in entries) {
            val sequence = parseAuditReceiptSequence(name)
            when {
                sequence != null -> receiptSequences += sequence
                temporaryAuditReceiptPattern.matches(name) -> temporaryCount += 1
                else -> throw AuditStoreException(
                    code = "AUDIT_CORRUPT",
                    message = "Audit directory contains an unexpected entry: $name",
                )
            }
        }
        if (temporaryCount > MAXIMUM_TEMPORARY_FILES) {
            throw AuditStoreException(
                code = "AUDIT_LIMIT_REACHED",
                message = "Audit directory contains too many incomplete temporary receipts.",
            )
        }
        receiptSequences.sort()
        if (receiptSequences.size > maximumReceipts) {
            throw AuditStoreException(
                code = "AUDIT_LIMIT_REACHED",
                message = "Audit receipt count exceeds its configured limit.",
            )
        }
        var previousSha256: String? = null
        var latest: AndroidAuditReceipt? = null
        receiptSequences.forEachIndexed { index, sequence ->
            val expected = index.toLong() + 1L
            if (sequence != expected) {
                throw AuditStoreException(
                    code = "AUDIT_CORRUPT",
                    message = "Audit receipt sequence has a gap or duplicate.",
                )
            }
            val verified = readReceiptFileLocked(
                path = directory.resolve(formatAuditReceiptFileName(sequence)),
                expectedSequence = sequence,
                expectedPreviousSha256 = previousSha256,
            )
            latest = verified
            previousSha256 = verified.receiptSha256
        }
        head = latest
        initialized = true
    }

    private fun verifyHeadLocked() {
        val current = head ?: return
        val disk = readReceiptFileLocked(
            path = directory.resolve(formatAuditReceiptFileName(current.sequence)),
            expectedSequence = current.sequence,
            expectedPreviousSha256 = current.previousReceiptSha256,
        )
        if (disk != current) {
            throw AuditStoreException(
                code = "AUDIT_CORRUPT",
                message = "The current audit receipt changed after verification.",
            )
        }
    }

    private fun ensureSafeDirectory() {
        val parent = directory.parent ?: throw AuditStoreException(
            code = "AUDIT_PATH_UNSAFE",
            message = "Audit directory must have a parent.",
        )
        if (!Files.exists(parent, LinkOption.NOFOLLOW_LINKS)) {
            throw AuditStoreException(
                code = "AUDIT_PATH_UNSAFE",
                message = "Audit parent directory does not exist.",
            )
        }
        if (Files.isSymbolicLink(parent) || !Files.isDirectory(parent, LinkOption.NOFOLLOW_LINKS)) {
            throw AuditStoreException(
                code = "AUDIT_PATH_UNSAFE",
                message = "Audit parent must be a real directory.",
            )
        }
        val parentReal = parent.toRealPath(LinkOption.NOFOLLOW_LINKS)
        if (parentReal != parent.toAbsolutePath().normalize()) {
            throw AuditStoreException(
                code = "AUDIT_PATH_UNSAFE",
                message = "Audit parent may not traverse a symbolic link or junction.",
            )
        }
        try {
            Files.createDirectory(directory)
        } catch (_: java.nio.file.FileAlreadyExistsException) {
            // Validated below.
        }
        if (Files.isSymbolicLink(directory) || !Files.isDirectory(directory, LinkOption.NOFOLLOW_LINKS)) {
            throw AuditStoreException(
                code = "AUDIT_PATH_UNSAFE",
                message = "Audit path must be a real directory.",
            )
        }
        val real = directory.toRealPath(LinkOption.NOFOLLOW_LINKS)
        if (real != directory) {
            throw AuditStoreException(
                code = "AUDIT_PATH_UNSAFE",
                message = "Audit directory may not be a symbolic link or junction.",
            )
        }
    }

    private fun readReceiptFileLocked(
        path: Path,
        expectedSequence: Long,
        expectedPreviousSha256: String?,
        validatePrevious: Boolean = true,
    ): AndroidAuditReceipt {
        if (Files.isSymbolicLink(path) || !Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS)) {
            throw AuditStoreException(
                code = "AUDIT_PATH_UNSAFE",
                message = "Audit receipt must be a real regular file.",
            )
        }
        val before = Files.readAttributes(
            path,
            BasicFileAttributes::class.java,
            LinkOption.NOFOLLOW_LINKS,
        )
        if (before.size() !in 1..maximumReceiptBytes.toLong()) {
            throw AuditStoreException(
                code = "AUDIT_CORRUPT",
                message = "Audit receipt has an invalid byte length.",
            )
        }
        val bytes = Files.readAllBytes(path)
        val after = Files.readAttributes(
            path,
            BasicFileAttributes::class.java,
            LinkOption.NOFOLLOW_LINKS,
        )
        if (
            before.fileKey() != after.fileKey() ||
            before.size() != after.size() ||
            before.lastModifiedTime() != after.lastModifiedTime()
        ) {
            throw AuditStoreException(
                code = "AUDIT_CORRUPT",
                message = "Audit receipt changed while it was being read.",
            )
        }
        return try {
            val parsed = Json.parseToJsonElement(
                bytes.toString(StandardCharsets.UTF_8),
            ).jsonObject
            val actualPreviousSha256 = if (validatePrevious) {
                expectedPreviousSha256
            } else {
                parsed["previousReceiptSha256"]?.let { element ->
                    if (element.toString() == "null") null else element.toString().trim('"')
                }
            }
            val receipt = receiptFromJson(
                value = parsed,
                expectedSequence = expectedSequence,
                expectedPreviousSha256 = actualPreviousSha256,
            )
            val canonicalBytes = (
                canonicalAuditJson(receiptToJson(receipt)) + "\n"
            ).toByteArray(StandardCharsets.UTF_8)
            if (!bytes.contentEquals(canonicalBytes)) {
                throw AuditStoreException(
                    code = "AUDIT_CORRUPT",
                    message = "Audit receipt bytes are not in canonical form.",
                )
            }
            receipt
        } catch (error: AuditStoreException) {
            throw error
        } catch (error: Throwable) {
            throw AuditStoreException(
                code = "AUDIT_CORRUPT",
                message = "Audit receipt failed schema or digest verification.",
                cause = error,
            )
        }
    }

    private fun syncDirectoryBestEffort(path: Path): Boolean = try {
        FileChannel.open(path, StandardOpenOption.READ).use { channel ->
            channel.force(true)
        }
        true
    } catch (_: Throwable) {
        false
    }
}
