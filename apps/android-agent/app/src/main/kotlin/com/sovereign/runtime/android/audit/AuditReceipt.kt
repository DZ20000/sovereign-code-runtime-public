package com.sovereign.runtime.android.audit

import java.security.MessageDigest
import java.util.UUID
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

const val ANDROID_AUDIT_RECEIPT_SCHEMA_VERSION = "sar.audit-receipt/v1"

private val SHA256_PATTERN = Regex("^[a-f0-9]{64}$")
private val PRINCIPAL_FINGERPRINT_PATTERN = Regex("^[a-f0-9]{16}$")
private val TOOL_NAME_PATTERN = Regex("^[a-z][a-z0-9_.-]{0,127}$")
private val ERROR_CODE_PATTERN = Regex("^[A-Z][A-Z0-9_]{0,63}$")
private val UI_REF_PATTERN = Regex("^n[0-9a-z]{1,3}$")
private val RECEIPT_FILE_PATTERN = Regex("^receipt-([0-9]{16})\\.json$")
private val TEMPORARY_RECEIPT_PATTERN = Regex(
    "^\\.receipt-[a-f0-9-]{36}\\.tmp$",
)

internal val auditReceiptFilePattern: Regex = RECEIPT_FILE_PATTERN
internal val temporaryAuditReceiptPattern: Regex = TEMPORARY_RECEIPT_PATTERN

enum class AuditReceiptPhase {
    INTENT,
    RESULT,
}

enum class AuditReceiptOutcome {
    REQUESTED,
    SUCCEEDED,
    DENIED,
    FAILED,
    CANCELLED,
}

data class AuditReceiptInput(
    val correlationId: String,
    val phase: AuditReceiptPhase,
    val principalFingerprint: String,
    val toolName: String,
    val authority: String,
    val readOnly: Boolean,
    val outcome: AuditReceiptOutcome,
    val argumentNames: List<String>,
    val argumentsSha256: String,
    val resultSha256: String? = null,
    val errorCode: String? = null,
    val uiRevisionSha256: String? = null,
    val uiRef: String? = null,
    val targetPackageSha256: String? = null,
    val approvalRequestId: String? = null,
)

data class AndroidAuditReceipt(
    val schemaVersion: String = ANDROID_AUDIT_RECEIPT_SCHEMA_VERSION,
    val sequence: Long,
    val receiptId: String,
    val correlationId: String,
    val phase: AuditReceiptPhase,
    val occurredAtEpochMs: Long,
    val principalFingerprint: String,
    val toolName: String,
    val authority: String,
    val readOnly: Boolean,
    val outcome: AuditReceiptOutcome,
    val argumentNames: List<String>,
    val argumentsSha256: String,
    val resultSha256: String?,
    val errorCode: String?,
    val uiRevisionSha256: String?,
    val uiRef: String?,
    val targetPackageSha256: String?,
    val approvalRequestId: String?,
    val previousReceiptSha256: String?,
    val receiptSha256: String,
)

internal fun validateAuditReceiptInput(input: AuditReceiptInput): AuditReceiptInput {
    require(runCatching { UUID.fromString(input.correlationId) }.isSuccess) {
        "Audit correlation ID must be a UUID."
    }
    require(PRINCIPAL_FINGERPRINT_PATTERN.matches(input.principalFingerprint)) {
        "Audit principal fingerprint has an invalid shape."
    }
    require(TOOL_NAME_PATTERN.matches(input.toolName)) {
        "Audit tool name has an invalid shape."
    }
    require(input.authority.length in 1..64 && input.authority == input.authority.trim()) {
        "Audit authority has an invalid shape."
    }
    require(input.argumentNames.size <= 64) {
        "Audit argument-name count exceeds its limit."
    }
    val normalizedArgumentNames = input.argumentNames.map { name ->
        require(Regex("^[A-Za-z][A-Za-z0-9_]{0,63}$").matches(name)) {
            "Audit argument name has an invalid shape."
        }
        name
    }.distinct().sorted()
    require(normalizedArgumentNames.size == input.argumentNames.size) {
        "Audit argument names must be unique."
    }
    require(SHA256_PATTERN.matches(input.argumentsSha256)) {
        "Audit argument digest has an invalid shape."
    }
    for ((label, digest) in listOf(
        "result" to input.resultSha256,
        "UI revision" to input.uiRevisionSha256,
        "target package" to input.targetPackageSha256,
    )) {
        require(digest == null || SHA256_PATTERN.matches(digest)) {
            "Audit $label digest has an invalid shape."
        }
    }
    require(input.errorCode == null || ERROR_CODE_PATTERN.matches(input.errorCode)) {
        "Audit error code has an invalid shape."
    }
    require(input.uiRef == null || UI_REF_PATTERN.matches(input.uiRef)) {
        "Audit UI ref has an invalid shape."
    }
    require(
        input.approvalRequestId == null ||
            runCatching { UUID.fromString(input.approvalRequestId) }.isSuccess,
    ) {
        "Audit approval request ID must be a UUID."
    }
    require(
        (input.phase == AuditReceiptPhase.INTENT && input.outcome == AuditReceiptOutcome.REQUESTED) ||
            (input.phase == AuditReceiptPhase.RESULT && input.outcome != AuditReceiptOutcome.REQUESTED),
    ) {
        "Audit receipt phase and outcome are inconsistent."
    }
    require(input.phase == AuditReceiptPhase.RESULT || input.resultSha256 == null) {
        "Audit intent receipt may not contain a result digest."
    }
    require(
        input.outcome in setOf(AuditReceiptOutcome.FAILED, AuditReceiptOutcome.DENIED) ||
            input.errorCode == null,
    ) {
        "Audit error code is allowed only for denied or failed results."
    }
    return input.copy(argumentNames = normalizedArgumentNames)
}

fun sha256Hex(value: String): String = sha256Hex(value.toByteArray(Charsets.UTF_8))

fun sha256Hex(value: ByteArray): String = MessageDigest.getInstance("SHA-256")
    .digest(value)
    .joinToString(separator = "") { byte -> "%02x".format(byte) }

fun principalFingerprint(value: String): String = sha256Hex(value).take(16)

fun canonicalAuditJson(element: JsonElement): String = canonicalizeAuditJson(element).toString()

private fun canonicalizeAuditJson(element: JsonElement): JsonElement = when (element) {
    is JsonObject -> JsonObject(
        element.entries
            .sortedBy { (key, _) -> key }
            .associate { (key, value) -> key to canonicalizeAuditJson(value) },
    )
    is JsonArray -> JsonArray(element.map(::canonicalizeAuditJson))
    else -> element
}

fun digestAuditJson(element: JsonElement): String = sha256Hex(canonicalAuditJson(element))

internal fun createAuditReceipt(
    sequence: Long,
    receiptId: String,
    occurredAtEpochMs: Long,
    previousReceiptSha256: String?,
    input: AuditReceiptInput,
): AndroidAuditReceipt {
    require(sequence in 1..9_999_999_999_999_999L) {
        "Audit sequence exceeds its supported range."
    }
    require(runCatching { UUID.fromString(receiptId) }.isSuccess) {
        "Audit receipt ID must be a UUID."
    }
    require(occurredAtEpochMs >= 0) {
        "Audit receipt timestamp must be non-negative."
    }
    require(previousReceiptSha256 == null || SHA256_PATTERN.matches(previousReceiptSha256)) {
        "Previous audit receipt digest has an invalid shape."
    }
    val normalizedInput = validateAuditReceiptInput(input)
    val unsigned = unsignedReceiptJson(
        sequence = sequence,
        receiptId = receiptId,
        occurredAtEpochMs = occurredAtEpochMs,
        previousReceiptSha256 = previousReceiptSha256,
        input = normalizedInput,
    )
    val receiptSha256 = digestAuditJson(unsigned)
    return receiptFromJson(
        JsonObject(unsigned + ("receiptSha256" to JsonPrimitive(receiptSha256))),
        expectedSequence = sequence,
        expectedPreviousSha256 = previousReceiptSha256,
    )
}

internal fun receiptToJson(receipt: AndroidAuditReceipt): JsonObject = buildJsonObject {
    put("schemaVersion", receipt.schemaVersion)
    put("sequence", receipt.sequence)
    put("receiptId", receipt.receiptId)
    put("correlationId", receipt.correlationId)
    put("phase", receipt.phase.name.lowercase())
    put("occurredAtEpochMs", receipt.occurredAtEpochMs)
    put("principalFingerprint", receipt.principalFingerprint)
    put("toolName", receipt.toolName)
    put("authority", receipt.authority)
    put("readOnly", receipt.readOnly)
    put("outcome", receipt.outcome.name.lowercase())
    put("argumentNames", buildJsonArray {
        receipt.argumentNames.forEach { name -> add(JsonPrimitive(name)) }
    })
    put("argumentsSha256", receipt.argumentsSha256)
    putNullableString("resultSha256", receipt.resultSha256)
    putNullableString("errorCode", receipt.errorCode)
    putNullableString("uiRevisionSha256", receipt.uiRevisionSha256)
    putNullableString("uiRef", receipt.uiRef)
    putNullableString("targetPackageSha256", receipt.targetPackageSha256)
    putNullableString("approvalRequestId", receipt.approvalRequestId)
    putNullableString("previousReceiptSha256", receipt.previousReceiptSha256)
    put("receiptSha256", receipt.receiptSha256)
}

internal fun receiptFromJson(
    value: JsonObject,
    expectedSequence: Long,
    expectedPreviousSha256: String?,
): AndroidAuditReceipt {
    val expectedKeys = setOf(
        "schemaVersion",
        "sequence",
        "receiptId",
        "correlationId",
        "phase",
        "occurredAtEpochMs",
        "principalFingerprint",
        "toolName",
        "authority",
        "readOnly",
        "outcome",
        "argumentNames",
        "argumentsSha256",
        "resultSha256",
        "errorCode",
        "uiRevisionSha256",
        "uiRef",
        "targetPackageSha256",
        "approvalRequestId",
        "previousReceiptSha256",
        "receiptSha256",
    )
    require(value.keys == expectedKeys) {
        "Audit receipt contains missing or unknown fields."
    }
    require(value.getValue("schemaVersion").jsonPrimitive.content == ANDROID_AUDIT_RECEIPT_SCHEMA_VERSION) {
        "Unsupported audit receipt schema version."
    }
    val sequence = value.getValue("sequence").jsonPrimitive.longOrNull
        ?: error("Audit receipt sequence is invalid.")
    require(sequence == expectedSequence) {
        "Audit receipt sequence does not match its filename."
    }
    val receiptId = value.getValue("receiptId").jsonPrimitive.content
    val correlationId = value.getValue("correlationId").jsonPrimitive.content
    val phase = enumValueOf<AuditReceiptPhase>(
        value.getValue("phase").jsonPrimitive.content.uppercase(),
    )
    val occurredAtEpochMs = value.getValue("occurredAtEpochMs").jsonPrimitive.longOrNull
        ?: error("Audit receipt timestamp is invalid.")
    val principalFingerprint = value.getValue("principalFingerprint").jsonPrimitive.content
    val toolName = value.getValue("toolName").jsonPrimitive.content
    val authority = value.getValue("authority").jsonPrimitive.content
    val readOnly = value.getValue("readOnly").jsonPrimitive.content.toBooleanStrict()
    val outcome = enumValueOf<AuditReceiptOutcome>(
        value.getValue("outcome").jsonPrimitive.content.uppercase(),
    )
    val argumentNames = value.getValue("argumentNames").jsonArray.map { element ->
        element.jsonPrimitive.content
    }
    val argumentsSha256 = value.getValue("argumentsSha256").jsonPrimitive.content
    val resultSha256 = value.nullableString("resultSha256")
    val errorCode = value.nullableString("errorCode")
    val uiRevisionSha256 = value.nullableString("uiRevisionSha256")
    val uiRef = value.nullableString("uiRef")
    val targetPackageSha256 = value.nullableString("targetPackageSha256")
    val approvalRequestId = value.nullableString("approvalRequestId")
    val previousReceiptSha256 = value.nullableString("previousReceiptSha256")
    require(previousReceiptSha256 == expectedPreviousSha256) {
        "Audit receipt hash chain is broken."
    }
    val receiptSha256 = value.getValue("receiptSha256").jsonPrimitive.content
    require(SHA256_PATTERN.matches(receiptSha256)) {
        "Audit receipt digest has an invalid shape."
    }
    val input = validateAuditReceiptInput(
        AuditReceiptInput(
            correlationId = correlationId,
            phase = phase,
            principalFingerprint = principalFingerprint,
            toolName = toolName,
            authority = authority,
            readOnly = readOnly,
            outcome = outcome,
            argumentNames = argumentNames,
            argumentsSha256 = argumentsSha256,
            resultSha256 = resultSha256,
            errorCode = errorCode,
            uiRevisionSha256 = uiRevisionSha256,
            uiRef = uiRef,
            targetPackageSha256 = targetPackageSha256,
            approvalRequestId = approvalRequestId,
        ),
    )
    val unsigned = unsignedReceiptJson(
        sequence = sequence,
        receiptId = receiptId,
        occurredAtEpochMs = occurredAtEpochMs,
        previousReceiptSha256 = previousReceiptSha256,
        input = input,
    )
    require(digestAuditJson(unsigned) == receiptSha256) {
        "Audit receipt digest verification failed."
    }
    return AndroidAuditReceipt(
        schemaVersion = ANDROID_AUDIT_RECEIPT_SCHEMA_VERSION,
        sequence = sequence,
        receiptId = receiptId,
        correlationId = input.correlationId,
        phase = input.phase,
        occurredAtEpochMs = occurredAtEpochMs,
        principalFingerprint = input.principalFingerprint,
        toolName = input.toolName,
        authority = input.authority,
        readOnly = input.readOnly,
        outcome = input.outcome,
        argumentNames = input.argumentNames,
        argumentsSha256 = input.argumentsSha256,
        resultSha256 = input.resultSha256,
        errorCode = input.errorCode,
        uiRevisionSha256 = input.uiRevisionSha256,
        uiRef = input.uiRef,
        targetPackageSha256 = input.targetPackageSha256,
        approvalRequestId = input.approvalRequestId,
        previousReceiptSha256 = previousReceiptSha256,
        receiptSha256 = receiptSha256,
    )
}

internal fun formatAuditReceiptFileName(sequence: Long): String =
    "receipt-${sequence.toString().padStart(16, '0')}.json"

internal fun parseAuditReceiptSequence(fileName: String): Long? =
    auditReceiptFilePattern.matchEntire(fileName)
        ?.groupValues
        ?.get(1)
        ?.toLongOrNull()
        ?.takeIf { sequence -> sequence >= 1 }

private fun unsignedReceiptJson(
    sequence: Long,
    receiptId: String,
    occurredAtEpochMs: Long,
    previousReceiptSha256: String?,
    input: AuditReceiptInput,
): JsonObject = buildJsonObject {
    put("schemaVersion", ANDROID_AUDIT_RECEIPT_SCHEMA_VERSION)
    put("sequence", sequence)
    put("receiptId", receiptId)
    put("correlationId", input.correlationId)
    put("phase", input.phase.name.lowercase())
    put("occurredAtEpochMs", occurredAtEpochMs)
    put("principalFingerprint", input.principalFingerprint)
    put("toolName", input.toolName)
    put("authority", input.authority)
    put("readOnly", input.readOnly)
    put("outcome", input.outcome.name.lowercase())
    put("argumentNames", buildJsonArray {
        input.argumentNames.forEach { name -> add(JsonPrimitive(name)) }
    })
    put("argumentsSha256", input.argumentsSha256)
    putNullableString("resultSha256", input.resultSha256)
    putNullableString("errorCode", input.errorCode)
    putNullableString("uiRevisionSha256", input.uiRevisionSha256)
    putNullableString("uiRef", input.uiRef)
    putNullableString("targetPackageSha256", input.targetPackageSha256)
    putNullableString("approvalRequestId", input.approvalRequestId)
    putNullableString("previousReceiptSha256", previousReceiptSha256)
}

private fun JsonObject.nullableString(name: String): String? {
    val element = getValue(name)
    return if (element is JsonNull) null else element.jsonPrimitive.contentOrNull
}

private fun kotlinx.serialization.json.JsonObjectBuilder.putNullableString(
    name: String,
    value: String?,
) {
    put(name, value?.let(::JsonPrimitive) ?: JsonNull)
}
