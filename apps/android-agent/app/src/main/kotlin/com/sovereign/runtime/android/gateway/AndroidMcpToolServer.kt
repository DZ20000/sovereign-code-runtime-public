package com.sovereign.runtime.android.gateway

import android.os.Build
import com.sovereign.runtime.android.BuildConfig
import com.sovereign.runtime.android.accessibility.AccessibilityServiceUnavailableException
import com.sovereign.runtime.android.accessibility.AndroidUiAction
import com.sovereign.runtime.android.accessibility.StaleUiRevisionException
import com.sovereign.runtime.android.accessibility.UiActionRejectedException
import com.sovereign.runtime.android.accessibility.UnknownUiRefException
import com.sovereign.runtime.android.apps.AndroidAppInteractionDeniedException
import com.sovereign.runtime.android.apps.AndroidAppLaunchRejectedException
import com.sovereign.runtime.android.apps.AndroidAppListRequiredException
import com.sovereign.runtime.android.apps.AndroidAppNotFoundException
import com.sovereign.runtime.android.apps.AndroidAppQueryRejectedException
import com.sovereign.runtime.android.apps.StaleAndroidAppRevisionException
import com.sovereign.runtime.android.apps.UnknownAndroidAppRefException
import com.sovereign.runtime.android.audit.AuditStoreException
import com.sovereign.runtime.android.audit.receiptToJson
import com.sovereign.runtime.android.notification.notificationListToJson
import com.sovereign.runtime.android.notification.notificationStatusToJson
import com.sovereign.runtime.android.runtime.AndroidAgentRuntime
import com.sovereign.runtime.android.runtime.AuthorityDeniedException
import io.modelcontextprotocol.kotlin.sdk.server.Server
import io.modelcontextprotocol.kotlin.sdk.server.ServerOptions
import io.modelcontextprotocol.kotlin.sdk.types.CallToolRequest
import io.modelcontextprotocol.kotlin.sdk.types.CallToolResult
import io.modelcontextprotocol.kotlin.sdk.types.Implementation
import io.modelcontextprotocol.kotlin.sdk.types.ServerCapabilities
import io.modelcontextprotocol.kotlin.sdk.types.ToolAnnotations
import io.modelcontextprotocol.kotlin.sdk.types.ToolSchema
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

internal class AndroidMcpToolServerFactory(
    private val runtime: AndroidAgentRuntime,
    private val gatewayStateProvider: () -> McpGatewayState,
) {
    fun create(sessionContext: McpSessionContext): Server {
        val toolAudit = AndroidToolAudit(
            ledger = runtime.auditLedger,
            sessionContext = sessionContext,
            authorityProvider = { runtime.profile.value.displayName },
            reportError = runtime::reportError,
        )
        val toolApproval = AndroidToolApproval(
            requester = runtime.approvalBroker,
            sessionContext = sessionContext,
            authorityProvider = { runtime.profile.value.displayName },
        )
        val server = Server(
            serverInfo = Implementation(
                name = "sovereign-android-runtime",
                version = BuildConfig.VERSION_NAME,
            ),
            options = ServerOptions(
                capabilities = ServerCapabilities(
                    tools = ServerCapabilities.Tools(listChanged = false),
                ),
            ),
        )
        AndroidToolCatalog.definitions.forEach { definition ->
            server.addTool(
                name = definition.name,
                title = definition.title,
                description = definition.description,
                inputSchema = ToolSchema(
                    properties = definition.properties,
                    required = definition.requiredArguments.takeIf(List<String>::isNotEmpty),
                ),
                outputSchema = ToolSchema(),
                toolAnnotations = ToolAnnotations(
                    title = definition.title,
                    readOnlyHint = definition.readOnly,
                    destructiveHint = definition.destructive,
                    idempotentHint = definition.readOnly,
                    openWorldHint = definition.openWorld,
                ),
                meta = buildJsonObject {
                    put("sar.toolVersion", ANDROID_TOOL_VERSION)
                    put("sar.catalogRevision", AndroidToolCatalog.catalogRevision)
                    put("sar.authority", definition.authority.displayName)
                    put("sar.approvalMode", definition.approvalMode.wireName)
                    put("sar.auditMode", definition.auditMode.wireName)
                },
            ) { request ->
                val approvalPlan = toolApproval.plan(definition, request)
                toolAudit.execute(
                    definition = definition,
                    request = request,
                    approvalRequestId = approvalPlan.requestId,
                ) {
                    approvalPlan.authorize {
                        executeTool(request)
                    }
                }
            }
        }
        return server
    }

    private suspend fun executeTool(request: CallToolRequest): CallToolResult = try {
        when (request.name) {
            "android.system.info" -> {
                requireNoArguments(request)
                toolSuccess(deviceInfo())
            }
            "android.system.tool_manifest" -> {
                requireNoArguments(request)
                toolSuccess(AndroidToolCatalog.manifest)
            }
            "android.system.audit_status" -> {
                requireNoArguments(request)
                toolSuccess(runtime.auditLedger.state.value.toJson())
            }
            "android.system.audit_receipts" -> {
                val arguments = ToolArguments(
                    request.arguments,
                    allowedNames = setOf("limit"),
                )
                val limit = arguments.optionalLong(
                    name = "limit",
                    defaultValue = 20L,
                    minimum = 1L,
                    maximum = 100L,
                ).toInt()
                val receipts = runtime.auditLedger.recent(limit)
                toolSuccess(
                    buildJsonObject {
                        put("schemaVersion", "sar.audit-receipt-list/v1")
                        put("count", receipts.size)
                        put("receipts", JsonArray(receipts.map(::receiptToJson)))
                    },
                )
            }
            "android.ui.observe" -> {
                requireNoArguments(request)
                toolSuccess(runtime.observe().toJson())
            }
            "android.screen.capture" -> {
                requireNoArguments(request)
                screenCaptureMcpResult(runtime.captureScreen())
            }
            "android.app.list" -> {
                requireNoArguments(request)
                toolSuccess(runtime.listApps().toJson())
            }
            "android.app.current" -> {
                requireNoArguments(request)
                toolSuccess(runtime.currentApp().toJson())
            }
            "android.surface.status" -> {
                requireNoArguments(request)
                toolSuccess(runtime.surfaceStatus().toJson())
            }
            "android.app.launch" -> {
                val arguments = ToolArguments(
                    request.arguments,
                    allowedNames = setOf("revision", "ref"),
                )
                toolSuccess(
                    runtime.launchApp(
                        revision = arguments.requiredAppRevision(),
                        ref = arguments.requiredAppRef(),
                    ).toJson(),
                )
            }
            "android.notification.status" -> {
                requireNoArguments(request)
                toolSuccess(notificationStatusToJson(runtime.notificationStatus()))
            }
            "android.notification.list" -> {
                val arguments = ToolArguments(
                    request.arguments,
                    allowedNames = setOf("limit"),
                )
                val limit = arguments.optionalLong(
                    name = "limit",
                    defaultValue = 128L,
                    minimum = 1L,
                    maximum = 128L,
                ).toInt()
                toolSuccess(notificationListToJson(runtime.listNotifications(limit)))
            }
            "android.ui.click" -> {
                val arguments = ToolArguments(
                    request.arguments,
                    allowedNames = setOf("revision", "ref"),
                )
                toolSuccess(
                    runtime.click(
                        revision = arguments.requiredRevision(),
                        ref = arguments.requiredRef(),
                    ).toJson(),
                )
            }
            "android.ui.long_press" -> {
                val arguments = ToolArguments(
                    request.arguments,
                    allowedNames = setOf("revision", "ref", "durationMs"),
                )
                toolSuccess(
                    runtime.longPress(
                        revision = arguments.requiredRevision(),
                        ref = arguments.requiredRef(),
                        durationMs = arguments.optionalLong(
                            name = "durationMs",
                            defaultValue = 800L,
                            minimum = 500L,
                            maximum = 2_000L,
                        ),
                    ).toJson(),
                )
            }
            "android.ui.set_text" -> {
                val arguments = ToolArguments(
                    request.arguments,
                    allowedNames = setOf("revision", "ref", "text"),
                )
                toolSuccess(
                    runtime.setText(
                        revision = arguments.requiredRevision(),
                        ref = arguments.requiredRef(),
                        text = arguments.requiredString(
                            name = "text",
                            maximumCharacters = 4_000,
                            allowEmpty = true,
                        ),
                    ).toJson(),
                )
            }
            "android.ui.swipe" -> {
                val arguments = ToolArguments(
                    request.arguments,
                    allowedNames = setOf(
                        "revision",
                        "startX",
                        "startY",
                        "endX",
                        "endY",
                        "durationMs",
                    ),
                )
                toolSuccess(
                    runtime.swipe(
                        revision = arguments.requiredRevision(),
                        startX = arguments.requiredFloat("startX"),
                        startY = arguments.requiredFloat("startY"),
                        endX = arguments.requiredFloat("endX"),
                        endY = arguments.requiredFloat("endY"),
                        durationMs = arguments.requiredLong(
                            name = "durationMs",
                            minimum = 100L,
                            maximum = 2_000L,
                        ),
                    ).toJson(),
                )
            }
            "android.global.back" -> globalAction(
                request = request,
                action = AndroidUiAction.GLOBAL_BACK,
            )
            "android.global.home" -> globalAction(
                request = request,
                action = AndroidUiAction.GLOBAL_HOME,
            )
            "android.global.recents" -> globalAction(
                request = request,
                action = AndroidUiAction.GLOBAL_RECENTS,
            )
            else -> toolFailure(
                code = "UNKNOWN_TOOL",
                message = "The requested Android tool is not registered.",
            )
        }
    } catch (error: CancellationException) {
        throw error
    } catch (error: ToolArgumentException) {
        toolFailure(error.code, error.message ?: "Tool arguments are invalid.")
    } catch (error: AuthorityDeniedException) {
        toolFailure("AUTHORITY_DENIED", error.message ?: "Authority denied.")
    } catch (error: AccessibilityServiceUnavailableException) {
        toolFailure("ADAPTER_UNAVAILABLE", error.message ?: "Accessibility adapter unavailable.")
    } catch (error: StaleUiRevisionException) {
        toolFailure("STALE_REVISION", error.message ?: "UI revision is stale.")
    } catch (error: UnknownUiRefException) {
        toolFailure("UNKNOWN_REF", error.message ?: "UI ref is unknown.")
    } catch (error: UiActionRejectedException) {
        toolFailure("ACTION_REJECTED", error.message ?: "Android rejected the action.")
    } catch (error: AndroidAppListRequiredException) {
        toolFailure("APP_LIST_REQUIRED", error.message ?: "Call android.app.list first.")
    } catch (error: StaleAndroidAppRevisionException) {
        toolFailure("STALE_APP_REVISION", error.message ?: "The app-list revision is stale.")
    } catch (error: UnknownAndroidAppRefException) {
        toolFailure("UNKNOWN_APP_REF", error.message ?: "The app ref is unknown.")
    } catch (error: AndroidAppInteractionDeniedException) {
        toolFailure("APP_INTERACTION_DENIED", error.message ?: "Local app policy denied launch.")
    } catch (error: AndroidAppQueryRejectedException) {
        toolFailure("APP_QUERY_FAILED", error.message ?: "Android app visibility query failed.")
    } catch (error: AndroidAppNotFoundException) {
        toolFailure("APP_NOT_FOUND", error.message ?: "The selected app is unavailable.")
    } catch (error: AndroidAppLaunchRejectedException) {
        toolFailure("APP_LAUNCH_REJECTED", error.message ?: "Android rejected app launch.")
    } catch (error: AuditStoreException) {
        toolFailure("AUDIT_UNAVAILABLE", error.message ?: "The Android audit ledger is unavailable.")
    } catch (error: IllegalArgumentException) {
        toolFailure("INVALID_ARGUMENT", error.message ?: "The tool arguments are invalid.")
    } catch (_: Throwable) {
        toolFailure(
            code = "INTERNAL_ERROR",
            message = "The Android runtime failed to complete the tool call.",
        )
    }

    private suspend fun globalAction(
        request: CallToolRequest,
        action: AndroidUiAction,
    ): CallToolResult {
        val arguments = ToolArguments(
            request.arguments,
            allowedNames = setOf("revision"),
        )
        return toolSuccess(
            runtime.globalAction(
                revision = arguments.requiredRevision(),
                action = action,
            ).toJson(),
        )
    }

    private fun requireNoArguments(request: CallToolRequest) {
        ToolArguments(request.arguments, allowedNames = emptySet())
    }

    private fun deviceInfo(): JsonObject = buildJsonObject {
        put("schemaVersion", "sar.device-info/v1")
        put("manufacturer", boundedDeviceValue(Build.MANUFACTURER))
        put("model", boundedDeviceValue(Build.MODEL))
        put("product", boundedDeviceValue(Build.PRODUCT))
        put("sdkInt", Build.VERSION.SDK_INT)
        put("release", boundedDeviceValue(Build.VERSION.RELEASE))
        put("supportedAbis", buildJsonArray {
            Build.SUPPORTED_ABIS.take(8).forEach { abi ->
                add(JsonPrimitive(boundedDeviceValue(abi)))
            }
        })
        put("applicationId", BuildConfig.APPLICATION_ID)
        put("applicationVersion", BuildConfig.VERSION_NAME)
        put("authority", runtime.profile.value.displayName)
        put("accessibilityConnected", runtime.serviceRegistry.connected.value)
        put(
            "notificationListenerConnected",
            runtime.notificationListenerConnected.value,
        )
        put("currentUiRevision", runtime.snapshotRegistry.currentRevision())
        put("gateway", gatewayStateProvider().toJson())
        put("approval", runtime.approvalBroker.state.value.toJson())
        put("audit", runtime.auditLedger.state.value.toJson())
    }

    private fun boundedDeviceValue(value: String?): String = value
        .orEmpty()
        .replace(Regex("[\\r\\n\\u0000]+"), " ")
        .replace(Regex("\\s+"), " ")
        .trim()
        .take(128)
}
