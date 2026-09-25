package com.sovereign.runtime.android.gateway

import com.sovereign.runtime.android.audit.AndroidAuditLedger
import com.sovereign.runtime.android.audit.AuditReceiptOutcome
import com.sovereign.runtime.android.audit.AuditReceiptPhase
import com.sovereign.runtime.android.audit.ImmutableAuditReceiptStore
import io.ktor.client.HttpClient
import io.ktor.client.engine.cio.CIO
import io.ktor.client.request.HttpRequestBuilder
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
import io.modelcontextprotocol.kotlin.sdk.types.Implementation
import io.modelcontextprotocol.kotlin.sdk.types.LATEST_PROTOCOL_VERSION
import io.modelcontextprotocol.kotlin.sdk.types.ServerCapabilities
import io.modelcontextprotocol.kotlin.sdk.types.ToolAnnotations
import io.modelcontextprotocol.kotlin.sdk.types.ToolSchema
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AndroidToolAuditIntegrationTest {
    private val cleanup = mutableListOf<Path>()

    @After
    fun tearDown() {
        cleanup.asReversed().forEach { path ->
            runCatching {
                Files.walk(path).sorted(Comparator.reverseOrder()).forEach(Files::deleteIfExists)
            }
        }
        cleanup.clear()
    }

    @Test
    fun auditedToolCallWritesIntentAndResultWithoutRawPayloadOrSessionId() = runBlocking {
        val root = root()
        val ledger = AndroidAuditLedger(
            ImmutableAuditReceiptStore(root.resolve("audit")),
        )
        val operationCount = AtomicInteger()
        val errors = mutableListOf<Throwable>()
        val token = generateGatewayBearerToken()
        val server = LocalMcpServer(
            bearerToken = token,
            serverFactory = { sessionContext ->
                auditedServer(
                    sessionContext = sessionContext,
                    ledger = ledger,
                    operationCount = operationCount,
                    errors = errors,
                )
            },
            onSessionCountChanged = {},
        )
        val client = HttpClient(CIO) { expectSuccess = false }
        try {
            val port = server.start()
            val endpoint = "http://127.0.0.1:$port/mcp"
            val sessionId = initialize(client, endpoint, token)
            val result = client.post(endpoint) {
                streamableHeaders(token, sessionId)
                setBody(
                    """{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"android.ui.observe","arguments":{}}}""",
                )
            }
            assertEquals(HttpStatusCode.OK, result.status)
            assertTrue(result.bodyAsText().contains("sensitive-result-value"))
            assertEquals(1, operationCount.get())
            assertTrue(errors.isEmpty())

            val receipts = ledger.recent(10)
            assertEquals(2, receipts.size)
            assertEquals(AuditReceiptPhase.INTENT, receipts[0].phase)
            assertEquals(AuditReceiptOutcome.REQUESTED, receipts[0].outcome)
            assertEquals(AuditReceiptPhase.RESULT, receipts[1].phase)
            assertEquals(AuditReceiptOutcome.SUCCEEDED, receipts[1].outcome)
            assertEquals("android.ui.observe", receipts[0].toolName)
            assertEquals(receipts[0].principalFingerprint, receipts[1].principalFingerprint)
            assertEquals(receipts[0].receiptSha256, receipts[1].previousReceiptSha256)

            val persisted = Files.readAllBytes(
                root.resolve("audit/receipt-0000000000000002.json"),
            ).toString(StandardCharsets.UTF_8)
            assertFalse(persisted.contains("sensitive-result-value"))
            assertFalse(persisted.contains(sessionId))
        } finally {
            server.stop()
            client.close()
        }
    }

    @Test
    fun malformedArgumentNamesAreHashedWithoutTurningValidationIntoAuditFailure() = runBlocking {
        val root = root()
        val ledger = AndroidAuditLedger(
            ImmutableAuditReceiptStore(root.resolve("audit")),
        )
        val operationCount = AtomicInteger()
        val errors = mutableListOf<Throwable>()
        val token = generateGatewayBearerToken()
        val server = LocalMcpServer(
            bearerToken = token,
            serverFactory = { sessionContext ->
                auditedServer(
                    sessionContext = sessionContext,
                    ledger = ledger,
                    operationCount = operationCount,
                    errors = errors,
                )
            },
            onSessionCountChanged = {},
        )
        val client = HttpClient(CIO) { expectSuccess = false }
        try {
            val port = server.start()
            val endpoint = "http://127.0.0.1:$port/mcp"
            val sessionId = initialize(client, endpoint, token)
            val result = client.post(endpoint) {
                streamableHeaders(token, sessionId)
                setBody(
                    """{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"android.ui.observe","arguments":{"--invalid argument":"secret"}}}""",
                )
            }
            assertEquals(HttpStatusCode.OK, result.status)
            val body = result.bodyAsText()
            assertTrue(body.contains("INVALID_ARGUMENT"))
            assertFalse(body.contains("AUDIT_UNAVAILABLE"))
            assertEquals(0, operationCount.get())
            assertTrue(errors.isEmpty())

            val receipts = ledger.recent(10)
            assertEquals(2, receipts.size)
            assertEquals(AuditReceiptOutcome.REQUESTED, receipts[0].outcome)
            assertEquals(AuditReceiptOutcome.DENIED, receipts[1].outcome)
            assertEquals("INVALID_ARGUMENT", receipts[1].errorCode)
            assertEquals(1, receipts[0].argumentNames.size)
            assertTrue(receipts[0].argumentNames.single().startsWith("x0_"))

            val persisted = Files.readAllBytes(
                root.resolve("audit/receipt-0000000000000001.json"),
            ).toString(StandardCharsets.UTF_8)
            assertFalse(persisted.contains("--invalid argument"))
            assertFalse(persisted.contains("secret"))
        } finally {
            server.stop()
            client.close()
        }
    }

    @Test
    fun resultReceiptFailureReportsUncertainOutcomeAndNextIntentFailsClosed() = runBlocking {
        val root = root()
        val ledger = AndroidAuditLedger(
            ImmutableAuditReceiptStore(
                directoryPath = root.resolve("audit"),
                maximumReceipts = 1,
            ),
        )
        val operationCount = AtomicInteger()
        val errors = mutableListOf<Throwable>()
        val token = generateGatewayBearerToken()
        val server = LocalMcpServer(
            bearerToken = token,
            serverFactory = { sessionContext ->
                auditedServer(
                    sessionContext = sessionContext,
                    ledger = ledger,
                    operationCount = operationCount,
                    errors = errors,
                )
            },
            onSessionCountChanged = {},
        )
        val client = HttpClient(CIO) { expectSuccess = false }
        try {
            val port = server.start()
            val endpoint = "http://127.0.0.1:$port/mcp"
            val sessionId = initialize(client, endpoint, token)

            val first = client.post(endpoint) {
                streamableHeaders(token, sessionId)
                setBody(
                    """{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"android.ui.observe","arguments":{}}}""",
                )
            }
            assertEquals(HttpStatusCode.OK, first.status)
            assertTrue(first.bodyAsText().contains("AUDIT_RESULT_UNAVAILABLE"))
            assertEquals(1, operationCount.get())

            val second = client.post(endpoint) {
                streamableHeaders(token, sessionId)
                setBody(
                    """{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"android.ui.observe","arguments":{}}}""",
                )
            }
            assertEquals(HttpStatusCode.OK, second.status)
            assertTrue(second.bodyAsText().contains("AUDIT_UNAVAILABLE"))
            assertEquals(1, operationCount.get())
            assertTrue(errors.size >= 2)
        } finally {
            server.stop()
            client.close()
        }
    }

    private fun auditedServer(
        sessionContext: McpSessionContext,
        ledger: AndroidAuditLedger,
        operationCount: AtomicInteger,
        errors: MutableList<Throwable>,
    ): Server {
        val definition = AndroidToolCatalog.definition("android.ui.observe")
        val audit = AndroidToolAudit(
            ledger = ledger,
            sessionContext = sessionContext,
            authorityProvider = { "L1 Observe" },
            reportError = errors::add,
        )
        return Server(
            serverInfo = Implementation(
                name = "sovereign-audit-test-server",
                version = "1.0.0",
            ),
            options = ServerOptions(
                capabilities = ServerCapabilities(
                    tools = ServerCapabilities.Tools(listChanged = false),
                ),
            ),
        ).apply {
            addTool(
                name = definition.name,
                title = definition.title,
                description = definition.description,
                inputSchema = ToolSchema(),
                outputSchema = ToolSchema(),
                toolAnnotations = ToolAnnotations(
                    title = definition.title,
                    readOnlyHint = true,
                    destructiveHint = false,
                    idempotentHint = true,
                    openWorldHint = false,
                ),
            ) { request ->
                audit.execute(definition, request) {
                    if (request.arguments?.isNotEmpty() == true) {
                        toolFailure(
                            code = "INVALID_ARGUMENT",
                            message = "android.ui.observe does not accept arguments.",
                        )
                    } else {
                        operationCount.incrementAndGet()
                        toolSuccess(
                            buildJsonObject {
                                put("ok", true)
                                put("value", "sensitive-result-value")
                            },
                        )
                    }
                }
            }
        }
    }

    private suspend fun initialize(
        client: HttpClient,
        endpoint: String,
        token: String,
    ): String {
        val initialize = client.post(endpoint) {
            streamableHeaders(token)
            setBody(
                """{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"$LATEST_PROTOCOL_VERSION","capabilities":{},"clientInfo":{"name":"audit-test-client","version":"1.0.0"}}}""",
            )
        }
        assertEquals(HttpStatusCode.OK, initialize.status)
        val sessionId = initialize.headers[MCP_SESSION_ID_HEADER]
        assertNotNull(sessionId)
        val initialized = client.post(endpoint) {
            streamableHeaders(token, sessionId)
            setBody("""{"jsonrpc":"2.0","method":"notifications/initialized"}""")
        }
        assertTrue(initialized.status.value in 200..299)
        return sessionId!!
    }

    private fun HttpRequestBuilder.streamableHeaders(
        token: String,
        sessionId: String? = null,
    ) {
        header(
            HttpHeaders.Accept,
            "${ContentType.Application.Json}, ${ContentType.Text.EventStream}",
        )
        contentType(ContentType.Application.Json)
        header(HttpHeaders.Authorization, "Bearer $token")
        if (sessionId != null) {
            header(MCP_SESSION_ID_HEADER, sessionId)
            header("MCP-Protocol-Version", LATEST_PROTOCOL_VERSION)
        }
    }

    private fun root(): Path = Files.createTempDirectory("sar-tool-audit-test-").also(cleanup::add)
}
