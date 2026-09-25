package com.sovereign.runtime.android.gateway

import com.sovereign.runtime.android.runtime.AuthorityProfile
import java.security.MessageDigest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

const val ANDROID_TOOL_MANIFEST_SCHEMA_VERSION = "sar.tool-manifest/v1"
const val ANDROID_TOOL_VERSION = "1.5.0"

enum class AndroidApprovalMode(
    val wireName: String,
) {
    NONE("none"),
    SESSION("session"),
    SINGLE_USE("single-use"),
}

enum class AndroidAuditMode(
    val wireName: String,
) {
    NONE("none"),
    INTENT_RESULT("intent-result"),
}

internal data class AndroidToolDefinition(
    val name: String,
    val title: String,
    val description: String,
    val authority: AuthorityProfile,
    val readOnly: Boolean,
    val destructive: Boolean,
    val openWorld: Boolean,
    val approvalMode: AndroidApprovalMode,
    val auditMode: AndroidAuditMode,
    val requiredArguments: List<String> = emptyList(),
    val properties: JsonObject = JsonObject(emptyMap()),
) {
    val requiredAuthority: AuthorityProfile
        get() = authority

    init {
        require(
            approvalMode != AndroidApprovalMode.SINGLE_USE ||
                auditMode == AndroidAuditMode.INTENT_RESULT,
        ) {
            "Single-use Android tools must commit immutable intent and result receipts."
        }
    }
}

internal object AndroidToolCatalog {
    val definitions: List<AndroidToolDefinition> = listOf(
        diagnosticTool(
            name = "android.system.info",
            title = "Android device information",
            description = "Return bounded Android runtime, build, authority, Accessibility, local gateway, and audit-ledger status without a stable hardware identifier.",
        ),
        diagnosticTool(
            name = "android.system.tool_manifest",
            title = "Android tool manifest",
            description = "Return the versioned Sovereign Android tool catalog, authority requirements, approval behavior, and audit behavior.",
        ),
        diagnosticTool(
            name = "android.system.audit_status",
            title = "Android audit status",
            description = "Return bounded local immutable-audit-ledger health and the latest receipt sequence without reading receipt contents.",
        ),
        AndroidToolDefinition(
            name = "android.system.audit_receipts",
            title = "Android audit receipts",
            description = "Return recent immutable Android tool receipts. Receipts contain hashes and bounded metadata, never raw tool arguments, text input, Bearer credentials, or MCP session IDs.",
            authority = AuthorityProfile.OBSERVE,
            readOnly = true,
            destructive = false,
            openWorld = false,
            approvalMode = AndroidApprovalMode.NONE,
            auditMode = AndroidAuditMode.NONE,
            properties = buildJsonObject {
                put("limit", integerProperty(
                    description = "Maximum number of recent receipts to return.",
                    minimum = 1,
                    maximum = 100,
                ))
            },
        ),
        AndroidToolDefinition(
            name = "android.ui.observe",
            title = "Observe Android UI",
            description = "Capture a bounded and redacted Accessibility snapshot. Returned refs are valid only for the returned revision.",
            authority = AuthorityProfile.OBSERVE,
            readOnly = true,
            destructive = false,
            openWorld = false,
            approvalMode = AndroidApprovalMode.NONE,
            auditMode = AndroidAuditMode.INTENT_RESULT,
        ),
        AndroidToolDefinition(
            name = "android.screen.capture",
            title = "Capture Android screen",
            description = "Capture the current locally allowed Android surface into a bounded short-lived in-memory artifact. The response returns metadata and captureId only; raw pixels require the unregistered android.screen.read contract.",
            authority = AuthorityProfile.OBSERVE,
            readOnly = true,
            destructive = false,
            openWorld = false,
            approvalMode = AndroidApprovalMode.NONE,
            auditMode = AndroidAuditMode.INTENT_RESULT,
        ),
        AndroidToolDefinition(
            name = "android.app.list",
            title = "List launchable Android apps",
            description = "Return a bounded list of visible exported launcher apps. The list has a short-lived revision and opaque refs; QUERY_ALL_PACKAGES is not requested.",
            authority = AuthorityProfile.OBSERVE,
            readOnly = true,
            destructive = false,
            openWorld = false,
            approvalMode = AndroidApprovalMode.NONE,
            auditMode = AndroidAuditMode.INTENT_RESULT,
        ),
        AndroidToolDefinition(
            name = "android.app.current",
            title = "Inspect current Android app",
            description = "Return the package and local interaction policy for the current Accessibility surface without enumerating hidden components.",
            authority = AuthorityProfile.OBSERVE,
            readOnly = true,
            destructive = false,
            openWorld = false,
            approvalMode = AndroidApprovalMode.NONE,
            auditMode = AndroidAuditMode.INTENT_RESULT,
        ),
        AndroidToolDefinition(
            name = "android.surface.status",
            title = "Android surface status",
            description = "Report Android Accessibility, screenshot, notification-listener, active-surface, current-capture, Shizuku and Root capability status without granting any permission.",
            authority = AuthorityProfile.OBSERVE,
            readOnly = true,
            destructive = false,
            openWorld = false,
            approvalMode = AndroidApprovalMode.NONE,
            auditMode = AndroidAuditMode.INTENT_RESULT,
        ),
        AndroidToolDefinition(
            name = "android.app.launch",
            title = "Launch Android app",
            description = "Dispatch a launch request for one enabled exported launcher activity selected by a ref from the current short-lived android.app.list revision. Android/OEM background-start policy may still block foreground presentation; call android.app.current or android.ui.observe to confirm.",
            authority = AuthorityProfile.INTERACTION,
            readOnly = false,
            destructive = false,
            openWorld = true,
            approvalMode = AndroidApprovalMode.SESSION,
            auditMode = AndroidAuditMode.INTENT_RESULT,
            requiredArguments = listOf("revision", "ref"),
            properties = buildJsonObject {
                put("revision", appRevisionProperty())
                put("ref", appRefProperty())
            },
        ),
        AndroidToolDefinition(
            name = "android.notification.status",
            title = "Android notification status",
            description = "Report whether the locally granted Android Notification Listener is connected, together with bounded policy and current-snapshot status. This tool never grants notification access.",
            authority = AuthorityProfile.OBSERVE,
            readOnly = true,
            destructive = false,
            openWorld = false,
            approvalMode = AndroidApprovalMode.NONE,
            auditMode = AndroidAuditMode.INTENT_RESULT,
        ),
        AndroidToolDefinition(
            name = "android.notification.list",
            title = "List active Android notifications",
            description = "Return a bounded read-only current notification list after fail-closed local package policy, full sensitive-category redaction, and contextual OTP redaction. Raw notification keys, PendingIntents, history, replies, actions, dismissal, and notification extras are never returned.",
            authority = AuthorityProfile.OBSERVE,
            readOnly = true,
            destructive = false,
            openWorld = false,
            approvalMode = AndroidApprovalMode.NONE,
            auditMode = AndroidAuditMode.INTENT_RESULT,
            properties = buildJsonObject {
                put("limit", integerProperty(
                    description = "Maximum number of current redacted notifications to return.",
                    minimum = 1,
                    maximum = 128,
                ))
            },
        ),
        referencedAction(
            name = "android.ui.click",
            title = "Click Android UI element",
            description = "Click a verified element from the current Accessibility revision. May trigger application side effects.",
        ),
        referencedAction(
            name = "android.ui.long_press",
            title = "Long-press Android UI element",
            description = "Long-press a verified element from the current Accessibility revision. May trigger application side effects.",
            extraProperties = buildJsonObject {
                put("durationMs", integerProperty(
                    description = "Press duration in milliseconds.",
                    minimum = 500,
                    maximum = 2_000,
                ))
            },
        ),
        referencedAction(
            name = "android.ui.set_text",
            title = "Set Android text field",
            description = "Replace text in a verified, enabled, non-password editable node using ACTION_SET_TEXT. Clipboard fallback is disabled.",
            extraProperties = buildJsonObject {
                put("text", stringProperty(
                    description = "Replacement text. NUL is rejected. Receipt storage includes only its digest and argument name.",
                    minLength = 0,
                    maxLength = 4_000,
                ))
            },
            additionalRequired = listOf("text"),
        ),
        AndroidToolDefinition(
            name = "android.ui.swipe",
            title = "Swipe Android screen",
            description = "Submit one bounded single-stroke swipe against the current UI revision. May trigger application side effects.",
            authority = AuthorityProfile.INTERACTION,
            readOnly = false,
            destructive = true,
            openWorld = true,
            approvalMode = AndroidApprovalMode.SESSION,
            auditMode = AndroidAuditMode.INTENT_RESULT,
            requiredArguments = listOf(
                "revision",
                "startX",
                "startY",
                "endX",
                "endY",
                "durationMs",
            ),
            properties = buildJsonObject {
                put("revision", revisionProperty())
                for (name in listOf("startX", "startY", "endX", "endY")) {
                    put(name, numberProperty("Screen coordinate in physical pixels."))
                }
                put("durationMs", integerProperty(
                    description = "Swipe duration in milliseconds.",
                    minimum = 100,
                    maximum = 2_000,
                ))
            },
        ),
        globalAction(
            name = "android.global.back",
            title = "Android Back",
            description = "Perform the Android Back global action after validating the current revision and protected-surface policy.",
        ),
        globalAction(
            name = "android.global.home",
            title = "Android Home",
            description = "Perform the Android Home global action after validating the current revision and protected-surface policy.",
        ),
        globalAction(
            name = "android.global.recents",
            title = "Android Recents",
            description = "Open Android Recents after validating the current revision and protected-surface policy.",
        ),
    ).also { tools ->
        require(tools.map(AndroidToolDefinition::name).toSet().size == tools.size) {
            "Android tool catalog contains a duplicate name."
        }
    }

    val manifest: JsonObject by lazy {
        val tools = buildJsonArray {
            definitions.forEach { definition ->
                add(
                    buildJsonObject {
                        put("name", definition.name)
                        put("version", ANDROID_TOOL_VERSION)
                        put("title", definition.title)
                        put("description", definition.description)
                        put("authority", definition.authority.displayName)
                        put("approvalMode", definition.approvalMode.wireName)
                        put("auditMode", definition.auditMode.wireName)
                        put("readOnly", definition.readOnly)
                        put("destructive", definition.destructive)
                        put("openWorld", definition.openWorld)
                        put("inputSchema", buildJsonObject {
                            put("type", "object")
                            put("additionalProperties", false)
                            put("properties", definition.properties)
                            put("required", buildJsonArray {
                                definition.requiredArguments.forEach { argument ->
                                    add(JsonPrimitive(argument))
                                }
                            })
                        })
                    },
                )
            }
        }
        val revision = sha256Hex(tools.toString())
        buildJsonObject {
            put("schemaVersion", ANDROID_TOOL_MANIFEST_SCHEMA_VERSION)
            put("catalogRevision", revision)
            put("toolCount", definitions.size)
            put("tools", tools)
        }
    }

    val catalogRevision: String
        get() = manifest.getValue("catalogRevision").let { element ->
            (element as JsonPrimitive).content
        }

    fun definition(name: String): AndroidToolDefinition = definitions.first { it.name == name }

    private fun diagnosticTool(
        name: String,
        title: String,
        description: String,
    ): AndroidToolDefinition = AndroidToolDefinition(
        name = name,
        title = title,
        description = description,
        authority = AuthorityProfile.OBSERVE,
        readOnly = true,
        destructive = false,
        openWorld = false,
        approvalMode = AndroidApprovalMode.NONE,
        auditMode = AndroidAuditMode.NONE,
    )

    private fun referencedAction(
        name: String,
        title: String,
        description: String,
        extraProperties: JsonObject = JsonObject(emptyMap()),
        additionalRequired: List<String> = emptyList(),
    ): AndroidToolDefinition = AndroidToolDefinition(
        name = name,
        title = title,
        description = description,
        authority = AuthorityProfile.INTERACTION,
        readOnly = false,
        destructive = true,
        openWorld = true,
        approvalMode = AndroidApprovalMode.SESSION,
        auditMode = AndroidAuditMode.INTENT_RESULT,
        requiredArguments = listOf("revision", "ref") + additionalRequired,
        properties = buildJsonObject {
            put("revision", revisionProperty())
            put("ref", stringProperty(
                description = "Element ref returned by android.ui.observe for the same revision.",
                minLength = 1,
                maxLength = 32,
            ))
            extraProperties.forEach { (key, value) -> put(key, value) }
        },
    )

    private fun globalAction(
        name: String,
        title: String,
        description: String,
    ): AndroidToolDefinition = AndroidToolDefinition(
        name = name,
        title = title,
        description = description,
        authority = AuthorityProfile.INTERACTION,
        readOnly = false,
        destructive = true,
        openWorld = true,
        approvalMode = AndroidApprovalMode.SESSION,
        auditMode = AndroidAuditMode.INTENT_RESULT,
        requiredArguments = listOf("revision"),
        properties = buildJsonObject {
            put("revision", revisionProperty())
        },
    )

    private fun revisionProperty(): JsonObject = stringProperty(
        description = "Opaque current UI revision returned by android.ui.observe.",
        minLength = 1,
        maxLength = 96,
    )

    private fun appRevisionProperty(): JsonObject = stringProperty(
        description = "Opaque short-lived app-list revision returned by android.app.list.",
        minLength = 23,
        maxLength = 38,
    )

    private fun appRefProperty(): JsonObject = stringProperty(
        description = "Opaque app ref returned by android.app.list for the same revision.",
        minLength = 19,
        maxLength = 32,
    )

    private fun stringProperty(
        description: String,
        minLength: Int,
        maxLength: Int,
    ): JsonObject = buildJsonObject {
        put("type", "string")
        put("description", description)
        put("minLength", minLength)
        put("maxLength", maxLength)
    }

    private fun numberProperty(description: String): JsonObject = buildJsonObject {
        put("type", "number")
        put("description", description)
    }

    private fun integerProperty(
        description: String,
        minimum: Int,
        maximum: Int,
    ): JsonObject = buildJsonObject {
        put("type", "integer")
        put("description", description)
        put("minimum", minimum)
        put("maximum", maximum)
    }

    private fun sha256Hex(value: String): String = MessageDigest.getInstance("SHA-256")
        .digest(value.toByteArray(Charsets.UTF_8))
        .joinToString(separator = "") { byte -> "%02x".format(byte) }
}
