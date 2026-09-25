package com.sovereign.runtime.android.gateway

import com.sovereign.runtime.android.approval.AndroidApprovalDecision
import com.sovereign.runtime.android.approval.AndroidApprovalRequestInput
import com.sovereign.runtime.android.approval.AndroidApprovalRequester
import com.sovereign.runtime.android.approval.AndroidApprovalResolutionReason
import com.sovereign.runtime.android.audit.digestAuditJson
import com.sovereign.runtime.android.audit.sha256Hex
import io.modelcontextprotocol.kotlin.sdk.types.CallToolRequest
import io.modelcontextprotocol.kotlin.sdk.types.CallToolResult
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

internal class AndroidToolApprovalPlan(
    val requestId: String?,
    private val authorizeBlock: suspend (suspend () -> CallToolResult) -> CallToolResult,
) {
    private val consumed = AtomicBoolean(false)

    suspend fun authorize(operation: suspend () -> CallToolResult): CallToolResult {
        if (!consumed.compareAndSet(false, true)) {
            return toolFailure(
                code = "APPROVAL_REPLAY",
                message = "This single-use Android approval plan was already consumed.",
            )
        }
        return authorizeBlock(operation)
    }
}

internal class AndroidToolApproval(
    private val requester: AndroidApprovalRequester,
    private val sessionContext: McpSessionContext,
    private val authorityProvider: () -> String,
) {
    fun plan(
        definition: AndroidToolDefinition,
        request: CallToolRequest,
    ): AndroidToolApprovalPlan {
        if (definition.approvalMode != AndroidApprovalMode.SINGLE_USE) {
            return AndroidToolApprovalPlan(requestId = null) { operation -> operation() }
        }
        require(definition.auditMode == AndroidAuditMode.INTENT_RESULT) {
            "Single-use Android tools must commit immutable intent and result receipts."
        }

        val arguments = request.arguments ?: JsonObject(emptyMap())
        val requestId = UUID.randomUUID().toString()
        val argumentsSha256 = digestAuditJson(arguments)
        val requestInput = AndroidApprovalRequestInput(
            requestId = requestId,
            principalFingerprint = sessionContext.principalFingerprint(),
            toolName = definition.name,
            title = definition.title.take(128),
            message = definition.description.take(512),
            detail = approvalDetail(
                definition = definition,
                arguments = arguments,
                argumentsSha256 = argumentsSha256,
            ),
            argumentsSha256 = argumentsSha256,
        )
        return AndroidToolApprovalPlan(requestId = requestId) { operation ->
            val result = try {
                requester.request(requestInput)
            } catch (error: CancellationException) {
                throw error
            } catch (_: Throwable) {
                return@AndroidToolApprovalPlan toolFailure(
                    code = "APPROVAL_UNAVAILABLE",
                    message = "The local approval broker is unavailable, so the Android tool was not executed.",
                )
            }
            if (result.requestId != requestId) {
                return@AndroidToolApprovalPlan toolFailure(
                    code = "APPROVAL_MISMATCH",
                    message = "The local approval broker returned a decision for another request, so the Android tool was not executed.",
                )
            }
            when {
                result.decision == AndroidApprovalDecision.ALLOW_ONCE &&
                    result.reason == AndroidApprovalResolutionReason.LOCAL_ALLOW -> operation()
                result.reason == AndroidApprovalResolutionReason.TIMEOUT -> toolFailure(
                    code = "APPROVAL_TIMEOUT",
                    message = "The local single-use approval expired before the Android tool could run.",
                )
                result.reason == AndroidApprovalResolutionReason.QUEUE_OVERFLOW -> toolFailure(
                    code = "APPROVAL_QUEUE_FULL",
                    message = "The local approval queue is full, so the Android tool was denied.",
                )
                result.reason == AndroidApprovalResolutionReason.DUPLICATE_REQUEST -> toolFailure(
                    code = "APPROVAL_DUPLICATE",
                    message = "The local approval request identity was already pending, so the Android tool was denied.",
                )
                result.reason in setOf(
                    AndroidApprovalResolutionReason.CANCELLED,
                    AndroidApprovalResolutionReason.GATEWAY_STOP,
                ) -> toolFailure(
                    code = "APPROVAL_CANCELLED",
                    message = "The local approval was cancelled before the Android tool could run.",
                )
                else -> toolFailure(
                    code = "APPROVAL_DENIED",
                    message = "The local user did not approve this Android tool for one-time execution.",
                )
            }
        }
    }

    private fun approvalDetail(
        definition: AndroidToolDefinition,
        arguments: JsonObject,
        argumentsSha256: String,
    ): String {
        val revision = arguments.stringOrNull("revision")
        val ref = arguments.stringOrNull("ref")
            ?.takeIf { value -> value.matches(Regex("^n[0-9a-z]{1,3}$")) }
        return buildList {
            add("Authority: ${authorityProvider().take(64)}")
            add("Tool: ${definition.name}")
            add("Argument count: ${arguments.size.coerceAtMost(10_000)}")
            add("Arguments SHA-256: ${argumentsSha256.take(16)}…")
            revision?.let { value -> add("UI revision SHA-256: ${sha256Hex(value).take(16)}…") }
            ref?.let { value -> add("UI ref: $value") }
        }.joinToString(separator = "\n").take(1_024)
    }

    private fun JsonObject.stringOrNull(name: String): String? =
        (this[name] as? JsonPrimitive)
            ?.takeIf(JsonPrimitive::isString)
            ?.content
}
