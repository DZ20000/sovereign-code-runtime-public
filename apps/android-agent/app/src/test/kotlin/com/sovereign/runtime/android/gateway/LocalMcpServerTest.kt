package com.sovereign.runtime.android.gateway

import io.ktor.client.HttpClient
import io.ktor.client.engine.cio.CIO
import io.ktor.client.request.HttpRequestBuilder
import io.ktor.client.request.delete
import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import io.modelcontextprotocol.kotlin.sdk.server.Server
import io.modelcontextprotocol.kotlin.sdk.server.ServerOptions
import io.modelcontextprotocol.kotlin.sdk.types.CallToolResult
import io.modelcontextprotocol.kotlin.sdk.types.Implementation
import io.modelcontextprotocol.kotlin.sdk.types.LATEST_PROTOCOL_VERSION
import io.modelcontextprotocol.kotlin.sdk.types.ServerCapabilities
import io.modelcontextprotocol.kotlin.sdk.types.TextContent
import io.modelcontextprotocol.kotlin.sdk.types.ToolAnnotations
import io.modelcontextprotocol.kotlin.sdk.types.ToolSchema
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LocalMcpServerTest {
    @Test
    fun realLoopbackServerEnforcesBearerAndCompletesMcpLifecycle() = runBlocking {
        val token = generateGatewayBearerToken()
        val sessionCounts = CopyOnWriteArrayList<Int>()
        val server = LocalMcpServer(
            bearerToken = token,
            serverFactory = ::testToolServer,
            onSessionCountChanged = sessionCounts::add,
        )
        val client = HttpClient(CIO) { expectSuccess = false }
        try {
            val port = server.start()
            val endpoint = "http://127.0.0.1:$port/mcp"

            val unauthenticated = client.post(endpoint) {
                streamableHeaders(token = null)
                setBody(initializeBody())
            }
            assertEquals(HttpStatusCode.Unauthorized, unauthenticated.status)
            assertEquals(
                "Bearer realm=\"sovereign-android-runtime\"",
                unauthenticated.headers[HttpHeaders.WWWAuthenticate],
            )

            val wrongOrigin = client.post(endpoint) {
                streamableHeaders(token)
                header(HttpHeaders.Origin, "https://evil.example")
                setBody(initializeBody())
            }
            assertEquals(HttpStatusCode.Forbidden, wrongOrigin.status)

            val initialize = client.post(endpoint) {
                streamableHeaders(token)
                header(HttpHeaders.Origin, "http://127.0.0.1:$port")
                setBody(initializeBody())
            }
            assertEquals(HttpStatusCode.OK, initialize.status)
            val sessionId = initialize.headers[MCP_SESSION_ID_HEADER]
            assertNotNull(sessionId)
            assertTrue(sessionId!!.matches(Regex("^[A-Za-z0-9._-]{1,128}$")))
            assertTrue(initialize.bodyAsText().contains("sovereign-test-server"))
            awaitSessionCount(sessionCounts, 1)

            val initialized = client.post(endpoint) {
                streamableHeaders(token, sessionId)
                setBody(
                    """{"jsonrpc":"2.0","method":"notifications/initialized"}""",
                )
            }
            assertTrue(initialized.status.value in 200..299)

            val tools = client.post(endpoint) {
                streamableHeaders(token, sessionId)
                setBody(
                    """{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}""",
                )
            }
            assertEquals(HttpStatusCode.OK, tools.status)
            val toolsBody = tools.bodyAsText()
            assertTrue(toolsBody.contains("test.echo"))
            assertFalse(toolsBody.contains(token))

            val call = client.post(endpoint) {
                streamableHeaders(token, sessionId)
                setBody(
                    """{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"test.echo","arguments":{}}}""",
                )
            }
            assertEquals(HttpStatusCode.OK, call.status)
            assertTrue(call.bodyAsText().contains("echo-ok"))

            val closed = client.delete(endpoint) {
                streamableHeaders(token, sessionId)
            }
            assertTrue(closed.status.value in 200..299)
            awaitSessionCount(sessionCounts, 0)

            val stale = client.post(endpoint) {
                streamableHeaders(token, sessionId)
                setBody(
                    """{"jsonrpc":"2.0","id":4,"method":"tools/list","params":{}}""",
                )
            }
            assertEquals(HttpStatusCode.NotFound, stale.status)
        } finally {
            server.stop()
            client.close()
        }
    }

    @Test
    fun invalidHostAndOversizedBodyFailBeforeMcpSessionCreation() = runBlocking {
        val token = generateGatewayBearerToken()
        val sessionCounts = CopyOnWriteArrayList<Int>()
        val server = LocalMcpServer(
            bearerToken = token,
            serverFactory = ::testToolServer,
            onSessionCountChanged = sessionCounts::add,
        )
        val client = HttpClient(CIO) { expectSuccess = false }
        try {
            val port = server.start()
            val endpoint = "http://127.0.0.1:$port/mcp"

            val badHost = client.post(endpoint) {
                streamableHeaders(token)
                header(HttpHeaders.Host, "evil.example")
                setBody(initializeBody())
            }
            assertTrue(badHost.status.value in setOf(403, 421))

            val queryString = client.post("$endpoint?unexpected=1") {
                streamableHeaders(token)
                setBody("{}")
            }
            assertEquals(HttpStatusCode.NotFound, queryString.status)
            assertNull(queryString.headers[MCP_SESSION_ID_HEADER])

            val oversized = client.post(endpoint) {
                streamableHeaders(token)
                setBody("x".repeat(MCP_GATEWAY_MAX_REQUEST_BYTES.toInt() + 1))
            }
            assertEquals(413, oversized.status.value)
            assertTrue(sessionCounts.none { it > 0 })
        } finally {
            server.stop()
            client.close()
        }
    }

    @Test
    fun sessionLimitRejectsTheNinthLiveSessionAndStopClearsAll() = runBlocking {
        val token = generateGatewayBearerToken()
        val sessionCounts = CopyOnWriteArrayList<Int>()
        val server = LocalMcpServer(
            bearerToken = token,
            serverFactory = ::testToolServer,
            onSessionCountChanged = sessionCounts::add,
        )
        val client = HttpClient(CIO) { expectSuccess = false }
        try {
            val port = server.start()
            val endpoint = "http://127.0.0.1:$port/mcp"
            val sessions = mutableListOf<String>()
            repeat(MCP_GATEWAY_MAX_SESSIONS) {
                val response = client.post(endpoint) {
                    streamableHeaders(token)
                    setBody(initializeBody(id = it + 1))
                }
                assertEquals(HttpStatusCode.OK, response.status)
                sessions += response.headers[MCP_SESSION_ID_HEADER]
                    ?: error("Initialize response omitted its session ID.")
            }
            awaitSessionCount(sessionCounts, MCP_GATEWAY_MAX_SESSIONS)

            val rejected = client.post(endpoint) {
                streamableHeaders(token)
                setBody(initializeBody(id = 100))
            }
            assertEquals(HttpStatusCode.TooManyRequests, rejected.status)

            server.stop()
            awaitSessionCount(sessionCounts, 0)
            assertEquals(MCP_GATEWAY_MAX_SESSIONS, sessions.toSet().size)
        } finally {
            server.stop()
            client.close()
        }
    }

    @Test
    fun malformedUninitializedRequestsDoNotLeakSessionPermits() = runBlocking {
        val token = generateGatewayBearerToken()
        val server = LocalMcpServer(
            bearerToken = token,
            serverFactory = ::testToolServer,
            onSessionCountChanged = {},
        )
        val client = HttpClient(CIO) { expectSuccess = false }
        try {
            val port = server.start()
            val endpoint = "http://127.0.0.1:$port/mcp"
            repeat(MCP_GATEWAY_MAX_SESSIONS * 2) {
                val malformed = client.post(endpoint) {
                    streamableHeaders(token)
                    setBody("{")
                }
                assertTrue(malformed.status.value in 400..499)
            }
            val valid = client.post(endpoint) {
                streamableHeaders(token)
                setBody(initializeBody(id = 500))
            }
            assertEquals(HttpStatusCode.OK, valid.status)
            assertNotNull(valid.headers[MCP_SESSION_ID_HEADER])
        } finally {
            server.stop()
            client.close()
        }
    }

    private fun testToolServer(
        @Suppress("UNUSED_PARAMETER") sessionContext: McpSessionContext,
    ): Server = Server(
        serverInfo = Implementation(
            name = "sovereign-test-server",
            version = "1.0.0",
        ),
        options = ServerOptions(
            capabilities = ServerCapabilities(
                tools = ServerCapabilities.Tools(listChanged = false),
            ),
        ),
    ).apply {
        addTool(
            name = "test.echo",
            title = "Echo",
            description = "Return a fixed bounded test result.",
            inputSchema = ToolSchema(),
            outputSchema = ToolSchema(),
            toolAnnotations = ToolAnnotations(
                title = "Echo",
                readOnlyHint = true,
                destructiveHint = false,
                idempotentHint = true,
                openWorldHint = false,
            ),
        ) {
            CallToolResult(
                content = listOf(TextContent("echo-ok")),
                isError = false,
                structuredContent = buildJsonObject {
                    put("ok", true)
                    put("value", "echo-ok")
                },
            )
        }
    }

    private fun HttpRequestBuilder.streamableHeaders(
        token: String?,
        sessionId: String? = null,
    ) {
        header(
            HttpHeaders.Accept,
            "${ContentType.Application.Json}, ${ContentType.Text.EventStream}",
        )
        contentType(ContentType.Application.Json)
        if (token != null) header(HttpHeaders.Authorization, "Bearer $token")
        if (sessionId != null) {
            header(MCP_SESSION_ID_HEADER, sessionId)
            header("MCP-Protocol-Version", LATEST_PROTOCOL_VERSION)
        }
    }

    private fun initializeBody(id: Int = 1): String =
        """{"jsonrpc":"2.0","id":$id,"method":"initialize","params":{"protocolVersion":"$LATEST_PROTOCOL_VERSION","capabilities":{},"clientInfo":{"name":"sovereign-test-client","version":"1.0.0"}}}"""

    private suspend fun awaitSessionCount(
        values: List<Int>,
        expected: Int,
    ) {
        repeat(100) {
            if (values.lastOrNull() == expected) return
            delay(10)
        }
        assertEquals(expected, values.lastOrNull())
    }
}

