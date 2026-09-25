package com.sovereign.runtime.android.gateway

import com.sovereign.runtime.android.accessibility.AndroidActionResult
import com.sovereign.runtime.android.accessibility.UiBounds
import com.sovereign.runtime.android.accessibility.UiNodeSnapshot
import com.sovereign.runtime.android.accessibility.UiSnapshot
import com.sovereign.runtime.android.approval.AndroidApprovalBrokerState
import com.sovereign.runtime.android.apps.AndroidAppLaunchResult
import com.sovereign.runtime.android.apps.AndroidAppListResult
import com.sovereign.runtime.android.apps.AndroidCurrentAppResult
import com.sovereign.runtime.android.apps.AndroidLaunchableApp
import com.sovereign.runtime.android.audit.AndroidAuditLedgerState
import com.sovereign.runtime.android.screen.ScreenCaptureMetadata
import com.sovereign.runtime.android.surface.AndroidSurfaceStatus
import io.modelcontextprotocol.kotlin.sdk.types.CallToolResult
import io.modelcontextprotocol.kotlin.sdk.types.TextContent
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

private val REVISION_PATTERN = Regex("^ui_[a-f0-9]{24}_[0-9a-z]+$")
private val REF_PATTERN = Regex("^n[0-9a-z]{1,3}$")
private val APP_REVISION_PATTERN = Regex("^apps_[1-9][0-9]{0,15}_[A-Za-z0-9_-]{16}$")
private val APP_REF_PATTERN = Regex("^a[0-9a-z]{1,3}_[A-Za-z0-9_-]{16}$")

internal class ToolArgumentException(
    val code: String,
    message: String,
) : IllegalArgumentException(message)

internal class ToolArguments(
    arguments: JsonObject?,
    allowedNames: Set<String>,
) {
    private val values = arguments ?: JsonObject(emptyMap())

    init {
        val unexpected = values.keys - allowedNames
        if (unexpected.isNotEmpty()) {
            throw ToolArgumentException(
                code = "INVALID_ARGUMENT",
                message = "Unexpected tool argument(s): ${unexpected.sorted().joinToString()}.",
            )
        }
    }

    fun requiredRevision(): String = requiredString(
        name = "revision",
        maximumCharacters = 96,
        pattern = REVISION_PATTERN,
    )

    fun requiredRef(): String = requiredString(
        name = "ref",
        maximumCharacters = 32,
        pattern = REF_PATTERN,
    )

    fun requiredAppRevision(): String = requiredString(
        name = "revision",
        maximumCharacters = 64,
        pattern = APP_REVISION_PATTERN,
    )

    fun requiredAppRef(): String = requiredString(
        name = "ref",
        maximumCharacters = 32,
        pattern = APP_REF_PATTERN,
    )

    fun requiredString(
        name: String,
        maximumCharacters: Int,
        pattern: Regex? = null,
        allowEmpty: Boolean = false,
    ): String {
        val primitive = values[name] as? JsonPrimitive
            ?: throw missing(name)
        if (!primitive.isString) {
            throw invalid(name, "must be a string")
        }
        val value = primitive.content
        if ((!allowEmpty && value.isEmpty()) || value.length > maximumCharacters || value.contains('\u0000')) {
            throw invalid(name, "has an invalid length or contains a NUL character")
        }
        if (pattern != null && !pattern.matches(value)) {
            throw invalid(name, "has an invalid shape")
        }
        return value
    }

    fun requiredLong(
        name: String,
        minimum: Long,
        maximum: Long,
    ): Long {
        val primitive = values[name] as? JsonPrimitive
            ?: throw missing(name)
        if (primitive.isString) throw invalid(name, "must be an integer")
        val value = primitive.longOrNull ?: throw invalid(name, "must be an integer")
        if (value !in minimum..maximum) {
            throw invalid(name, "must be from $minimum through $maximum")
        }
        return value
    }

    fun optionalLong(
        name: String,
        defaultValue: Long,
        minimum: Long,
        maximum: Long,
    ): Long {
        if (values[name] == null || values[name] is JsonNull) return defaultValue
        return requiredLong(name, minimum, maximum)
    }

    fun requiredFloat(name: String): Float {
        val primitive = values[name] as? JsonPrimitive
            ?: throw missing(name)
        if (primitive.isString) throw invalid(name, "must be a number")
        val value = primitive.doubleOrNull ?: throw invalid(name, "must be a number")
        if (!value.isFinite() || value < -1_000_000.0 || value > 1_000_000.0) {
            throw invalid(name, "is outside the bounded numeric range")
        }
        return value.toFloat()
    }

    private fun missing(name: String): ToolArgumentException = ToolArgumentException(
        code = "MISSING_ARGUMENT",
        message = "Required tool argument '$name' is missing.",
    )

    private fun invalid(
        name: String,
        reason: String,
    ): ToolArgumentException = ToolArgumentException(
        code = "INVALID_ARGUMENT",
        message = "Tool argument '$name' $reason.",
    )
}

internal fun toolSuccess(result: JsonObject): CallToolResult = CallToolResult(
    content = listOf(TextContent(result.toString())),
    isError = false,
    structuredContent = result,
)

internal fun toolFailure(
    code: String,
    message: String,
): CallToolResult {
    val boundedMessage = message
        .replace(Regex("[\\r\\n\\u0000]+"), " ")
        .replace(Regex("\\s+"), " ")
        .trim()
        .let { normalized ->
            when {
                normalized.isEmpty() -> "The Android tool call failed."
                normalized.length <= 512 -> normalized
                else -> normalized.take(511) + "…"
            }
        }
    val result = buildJsonObject {
        put("ok", false)
        putJsonObject("error") {
            put("code", code)
            put("message", boundedMessage)
        }
    }
    return CallToolResult(
        content = listOf(TextContent("$code: $boundedMessage")),
        isError = true,
        structuredContent = result,
    )
}

internal fun UiSnapshot.toJson(): JsonObject = buildJsonObject {
    put("schemaVersion", schemaVersion)
    put("revision", revision)
    put("capturedAtEpochMs", capturedAtEpochMs)
    put("windowId", windowId)
    putNullableString("packageName", packageName)
    put("truncated", truncated)
    put("redactionCount", redactionCount)
    put("nodeCount", nodes.size)
    put("nodes", JsonArray(nodes.map(UiNodeSnapshot::toJson)))
}

internal fun UiNodeSnapshot.toJson(): JsonObject = buildJsonObject {
    put("ref", ref)
    putNullableString("parentRef", parentRef)
    put("depth", depth)
    put("role", role.name.lowercase())
    putNullableString("text", text)
    putNullableString("contentDescription", contentDescription)
    putNullableString("viewId", viewId)
    putNullableString("className", className)
    putNullableString("packageName", packageName)
    put("bounds", bounds.toJson())
    put("clickable", clickable)
    put("longClickable", longClickable)
    put("editable", editable)
    put("scrollable", scrollable)
    put("checkable", checkable)
    put("checked", checked)
    put("enabled", enabled)
    put("password", password)
    put("redacted", redacted)
    put("interactionDenied", interactionDenied)
    putNullableString("interactionDeniedReason", interactionDeniedReason)
}

internal fun UiBounds.toJson(): JsonObject = buildJsonObject {
    put("left", left)
    put("top", top)
    put("right", right)
    put("bottom", bottom)
    put("width", width)
    put("height", height)
}

internal fun AndroidActionResult.toJson(): JsonObject = buildJsonObject {
    put("ok", succeeded)
    put("action", action.name.lowercase())
    put("revision", revision)
    putNullableString("ref", ref)
    putNullableString("packageName", packageName)
    put("performedAtEpochMs", performedAtEpochMs)
    put("detail", detail)
}

internal fun AndroidAppListResult.toJson(): JsonObject = buildJsonObject {
    put("schemaVersion", schemaVersion)
    put("revision", revision)
    put("capturedAtEpochMs", capturedAtEpochMs)
    put("validForMs", validForMs)
    put("count", apps.size)
    put("truncated", truncated)
    put("apps", JsonArray(apps.map(AndroidLaunchableApp::toJson)))
}

internal fun AndroidLaunchableApp.toJson(): JsonObject = buildJsonObject {
    put("ref", ref)
    put("packageName", packageName)
    put("label", label)
    put("interactionDenied", interactionDenied)
    putNullableString("interactionDeniedReason", interactionDeniedReason)
}

internal fun AndroidCurrentAppResult.toJson(): JsonObject = buildJsonObject {
    put("schemaVersion", schemaVersion)
    putNullableString("packageName", packageName)
    putNullableString("label", label)
    put("launchable", launchable)
    put("interactionDenied", interactionDenied)
    putNullableString("interactionDeniedReason", interactionDeniedReason)
}

internal fun AndroidSurfaceStatus.toJson(): JsonObject = buildJsonObject {
    put("schemaVersion", schemaVersion)
    put("accessibilityConnected", accessibilityConnected)
    put("screenshotApiSupported", screenshotApiSupported)
    put("notificationListenerConnected", notificationListenerConnected)
    putNullableString("activePackageName", activePackageName)
    putNullableNumber("activeWindowId", activeWindowId)
    putNullableNumber("activeSurfaceRevision", activeSurfaceRevision)
    putNullableString("activeSurfaceCategory", activeSurfaceCategory)
    putNullableBoolean(
        "screenshotAllowedForActiveSurface",
        screenshotAllowedForActiveSurface,
    )
    putNullableString("surfaceReasonCode", surfaceReasonCode)
    putNullableString("notificationSnapshotRevision", notificationSnapshotRevision)
    put("notificationCount", notificationCount)
    put(
        "currentCapture",
        currentCapture?.toSurfaceStatusJson() ?: JsonNull,
    )
    put("shizukuImplemented", shizukuImplemented)
    put("rootImplemented", rootImplemented)
}

private fun ScreenCaptureMetadata.toSurfaceStatusJson(): JsonObject = buildJsonObject {
    put("captureId", captureId)
    put("revision", revision)
    put("packageName", packageName)
    put("windowId", windowId)
    put("capturedAtElapsedMs", capturedAtElapsedMs)
    put("width", width)
    put("height", height)
    put("mimeType", mimeType)
    put("byteLength", byteLength)
    put("sha256", sha256)
}

internal fun AndroidAppLaunchResult.toJson(): JsonObject = buildJsonObject {
    put("schemaVersion", schemaVersion)
    put("revision", revision)
    put("ref", ref)
    put("packageName", packageName)
    put("dispatchAccepted", dispatchAccepted)
    put("dispatchedAtEpochMs", dispatchedAtEpochMs)
    put("confirmationRequired", confirmationRequired)
}

internal fun McpGatewayState.toJson(): JsonObject = buildJsonObject {
    put("schemaVersion", schemaVersion)
    put("phase", phase.name.lowercase())
    put("host", host)
    putNullableNumber("port", port)
    putNullableString("endpoint", endpoint)
    put("listenerOwned", listenerOwned)
    putNullableString("tokenFingerprint", tokenFingerprint)
    put("activeSessions", activeSessions)
    putNullableNumber("startedAtEpochMs", startedAtEpochMs)
    putNullableString("errorMessage", errorMessage)
}

internal fun AndroidApprovalBrokerState.toJson(): JsonObject = buildJsonObject {
    put("schemaVersion", schemaVersion)
    put("active", active != null)
    put("queuedCount", queuedCount)
    put("burstDetected", active?.burstDetected ?: false)
}

internal fun AndroidAuditLedgerState.toJson(): JsonObject = buildJsonObject {
    put("schemaVersion", schemaVersion)
    put("phase", phase.name.lowercase())
    putNullableNumber("lastSequence", lastSequence)
    putNullableString("lastReceiptSha256", lastReceiptSha256)
    if (directorySyncCompleted == null) {
        put("directorySyncCompleted", JsonNull)
    } else {
        put("directorySyncCompleted", directorySyncCompleted)
    }
    putNullableString("errorCode", errorCode)
    putNullableString("errorMessage", errorMessage)
}

private fun kotlinx.serialization.json.JsonObjectBuilder.putNullableString(
    name: String,
    value: String?,
) {
    put(name, value?.let(::JsonPrimitive) ?: JsonNull)
}

private fun kotlinx.serialization.json.JsonObjectBuilder.putNullableBoolean(
    name: String,
    value: Boolean?,
) {
    put(name, value?.let(::JsonPrimitive) ?: JsonNull)
}

private fun kotlinx.serialization.json.JsonObjectBuilder.putNullableNumber(
    name: String,
    value: Number?,
) {
    put(name, value?.let(::JsonPrimitive) ?: JsonNull)
}

private fun kotlinx.serialization.json.JsonObjectBuilder.putJsonObject(
    name: String,
    builder: kotlinx.serialization.json.JsonObjectBuilder.() -> Unit,
) {
    put(name, buildJsonObject(builder))
}
