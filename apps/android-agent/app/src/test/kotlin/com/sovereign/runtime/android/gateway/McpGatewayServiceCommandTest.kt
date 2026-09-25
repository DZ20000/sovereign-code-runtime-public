package com.sovereign.runtime.android.gateway

import org.junit.Assert.assertEquals
import org.junit.Test

class McpGatewayServiceCommandTest {
    @Test
    fun onlyExplicitStartAndStopActionsAreAccepted() {
        assertEquals(
            McpGatewayServiceCommand.START,
            resolveMcpGatewayServiceCommand(MCP_GATEWAY_SERVICE_ACTION_START),
        )
        assertEquals(
            McpGatewayServiceCommand.STOP,
            resolveMcpGatewayServiceCommand(MCP_GATEWAY_SERVICE_ACTION_STOP),
        )
        for (action in listOf(null, "", "unexpected", MCP_GATEWAY_SERVICE_ACTION_START + ".extra")) {
            assertEquals(
                McpGatewayServiceCommand.REJECT,
                resolveMcpGatewayServiceCommand(action),
            )
        }
    }
}
