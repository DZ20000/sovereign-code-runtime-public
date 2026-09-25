package com.sovereign.runtime.android.gateway

const val MCP_GATEWAY_STATE_SCHEMA_VERSION = "sar.mcp-gateway-state/v1"
const val MCP_GATEWAY_PATH = "/mcp"
const val MCP_GATEWAY_MAX_REQUEST_BYTES = 1_048_576L
const val MCP_GATEWAY_MAX_SESSIONS = 8

enum class McpGatewayPhase {
    STOPPED,
    STARTING,
    RUNNING,
    STOPPING,
    ERROR,
}

data class McpGatewayState(
    val schemaVersion: String = MCP_GATEWAY_STATE_SCHEMA_VERSION,
    val phase: McpGatewayPhase = McpGatewayPhase.STOPPED,
    val host: String = "127.0.0.1",
    val port: Int? = null,
    val endpoint: String? = null,
    val listenerOwned: Boolean = false,
    val tokenFingerprint: String? = null,
    val activeSessions: Int = 0,
    val startedAtEpochMs: Long? = null,
    val errorMessage: String? = null,
)

data class McpGatewayConnectionConfig(
    val endpoint: String,
    val authorizationHeader: String,
    val tokenFingerprint: String,
)
