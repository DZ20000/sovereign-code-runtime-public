package com.sovereign.runtime.android.gateway

internal const val MCP_GATEWAY_SERVICE_ACTION_START =
    "com.sovereign.runtime.android.action.START_LOCAL_MCP"
internal const val MCP_GATEWAY_SERVICE_ACTION_STOP =
    "com.sovereign.runtime.android.action.STOP_LOCAL_MCP"

internal enum class McpGatewayServiceCommand {
    START,
    STOP,
    REJECT,
}

internal fun resolveMcpGatewayServiceCommand(action: String?): McpGatewayServiceCommand =
    when (action) {
        MCP_GATEWAY_SERVICE_ACTION_START -> McpGatewayServiceCommand.START
        MCP_GATEWAY_SERVICE_ACTION_STOP -> McpGatewayServiceCommand.STOP
        else -> McpGatewayServiceCommand.REJECT
    }
