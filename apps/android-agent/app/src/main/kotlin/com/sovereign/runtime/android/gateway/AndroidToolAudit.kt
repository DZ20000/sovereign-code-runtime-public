package com.sovereign.runtime.android.gateway

import com.sovereign.runtime.android.audit.AndroidAuditLedger
import com.sovereign.runtime.android.audit.AuditReceiptInput
import com.sovereign.runtime.android.audit.AuditReceiptOutcome
import com.sovereign.runtime.android.audit.AuditReceiptPhase
import com.sovereign.runtime.android.audit.digestAuditJson
import com.sovereign.runtime.android.audit.sha256Hex
import io.modelcontextprotocol.kotlin.sdk.types.CallToolRequest
import io.modelcontextprotocol.kotlin.sdk.types.CallToolResult
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

internal class AndroidToolAudit(
    private val ledger: AndroidAuditLedger,
    private val sessionContext: McpSessionContext,
    private val authorityProvider: () -> String,
    private val reportError: (Throwable) -> Unit,
) {
    suspend fun execute(
        definition: AndroidToolDefinition,
        request: CallToolRequest,
        approvalRequestId: String? = null,
        operation: suspend () -> CallToolResult,
    ): CallToolResult {
        if (definition.auditMode == AndroidAuditMode.NONE) {
            return operation()
        }

        val arguments = request.arguments ?: JsonObject(emptyMap())
        val correlationId = UUID.randomUUID().toString()
        val shared = AuditReceiptInput(
            correlationId = correlationId,
            phase = AuditReceiptPhase.INTENT,
            principalFingerprint = sessionContext.principalFingerprint(),
            toolName = definition.name,
            authority = authorityProvider(),
            readOnly = definition.readOnly,
            outcome = AuditReceiptOutcome.REQUESTED,
            argumentNames = boundedAuditArgumentNames(arguments),
            argumentsSha256 = digestAuditJson(arguments),
            uiRevisionSha256 = auditRevision(arguments, null)?.let(::sha256Hex),
            uiRef = auditRef(arguments, null),
            approvalRequestId = approvalRequestId,
        )

        try {
            ledger.append(shared)
        } catch (error: Throwable) {
            reportError(error)
            return toolFailure(
                code = "AUDIT_UNAVAILABLE",
                message = "The immutable audit intent could not be committed, so the Android tool was not executed.",
            )
        }

        val result = try {
            operation()
        } catch (error: CancellationException) {
            withContext(NonCancellable) {
                runCatching {
                    ledger.append(
                        shared.copy(
                            phase = AuditReceiptPhase.RESULT,
                            outcome = AuditReceiptOutcome.CANCELLED,
                        ),
                    )
                }.onFailure(reportError)
            }
            throw error
        }

        val structured = result.structuredContent ?: JsonObject(emptyMap())
        val errorCode = resultErrorCode(structured)
        val outcome = when {
            result.isError != true -> AuditReceiptOutcome.SUCCEEDED
            errorCode in DENIED_ERROR_CODES -> AuditReceiptOutcome.DENIED
            else -> AuditReceiptOutcome.FAILED
        }
        val resultInput = shared.copy(
            phase = AuditReceiptPhase.RESULT,
            outcome = outcome,
            resultSha256 = digestAuditJson(structured),
            errorCode = errorCode.takeIf {
                outcome in setOf(AuditReceiptOutcome.DENIED, AuditReceiptOutcome.FAILED)
            },
            uiRevisionSha256 = auditRevision(arguments, structured)?.let(::sha256Hex),
            uiRef = auditRef(arguments, structured),
            targetPackageSha256 = structured.stringOrNull("packageName")?.let(::sha256Hex),
        )
        try {
            ledger.append(resultInput)
        } catch (error: Throwable) {
            reportError(error)
            return toolFailure(
                code = "AUDIT_RESULT_UNAVAILABLE",
                message = if (definition.readOnly) {
                    "The read completed, but its immutable result receipt could not be committed."
                } else {
                    "The Android action may have completed, but its immutable result receipt could not be committed. Observe the device before retrying."
                },
            )
        }
        return result
    }

    private fun auditRevision(
        arguments: JsonObject,
        result: JsonObject?,
    ): String? = arguments.stringOrNull("revision") ?: result?.stringOrNull("revision")

    private fun auditRef(
        arguments: JsonObject,
        result: JsonObject?,
    ): String? = (arguments.stringOrNull("ref") ?: result?.stringOrNull("ref"))
        ?.takeIf(AUDIT_UI_REF_PATTERN::matches)

    private fun boundedAuditArgumentNames(arguments: JsonObject): List<String> {
        val sortedNames = arguments.keys.sorted()
        val includeTruncationMarker = sortedNames.size > MAX_AUDIT_ARGUMENT_NAMES
        val visibleLimit = if (includeTruncationMarker) {
            MAX_AUDIT_ARGUMENT_NAMES - 1
        } else {
            MAX_AUDIT_ARGUMENT_NAMES
        }
        val used = mutableSetOf<String>()
        val result = sortedNames.take(visibleLimit).mapIndexed { index, name ->
            val candidate = if (AUDIT_ARGUMENT_NAME_PATTERN.matches(name)) {
                name
            } else {
                "x${index}_${sha256Hex(name).take(48)}"
            }
            if (used.add(candidate)) {
                candidate
            } else {
                "x${index}_${sha256Hex("$index:$name").take(48)}".also { fallback ->
                    check(used.add(fallback)) { "Audit argument-name normalization collided." }
                }
            }
        }.toMutableList()
        if (includeTruncationMarker) {
            val allNamesDigest = sha256Hex(sortedNames.joinToString(separator = "\u0000"))
            result += "truncated_${allNamesDigest.take(32)}"
        }
        return result
    }

    private fun resultErrorCode(result: JsonObject): String? =
        (result["error"] as? JsonObject)?.stringOrNull("code")

    private fun JsonObject.stringOrNull(name: String): String? {
        val value = this[name] ?: return null
        if (value is JsonNull) return null
        val primitive = value as? JsonPrimitive ?: return null
        return primitive.takeIf(JsonPrimitive::isString)?.content
    }

    private companion object {
        const val MAX_AUDIT_ARGUMENT_NAMES = 64
        val AUDIT_ARGUMENT_NAME_PATTERN = Regex("^[A-Za-z][A-Za-z0-9_]{0,63}$")
        val AUDIT_UI_REF_PATTERN = Regex("^n[0-9a-z]{1,3}$")
        val DENIED_ERROR_CODES = setOf(
            "AUTHORITY_DENIED",
            "STALE_REVISION",
            "UNKNOWN_REF",
            "ACTION_REJECTED",
            "INVALID_ARGUMENT",
            "MISSING_ARGUMENT",
            "APPROVAL_DENIED",
            "APPROVAL_TIMEOUT",
            "APPROVAL_QUEUE_FULL",
            "APPROVAL_DUPLICATE",
            "APPROVAL_CANCELLED",
            "APPROVAL_REPLAY",
            "APP_LIST_REQUIRED",
            "STALE_APP_REVISION",
            "UNKNOWN_APP_REF",
            "APP_INTERACTION_DENIED",
            "APP_NOT_FOUND",
            "APP_LAUNCH_REJECTED",
            "SCREEN_CAPTURE_DENIED",
            "SCREEN_CAPTURE_SECURE_WINDOW",
        )
    }
}
