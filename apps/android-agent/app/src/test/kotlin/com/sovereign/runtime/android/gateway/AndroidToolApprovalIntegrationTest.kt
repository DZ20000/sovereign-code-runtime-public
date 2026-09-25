package com.sovereign.runtime.android.gateway

import com.sovereign.runtime.android.approval.AndroidApprovalDecision
import com.sovereign.runtime.android.approval.AndroidApprovalRequestInput
import com.sovereign.runtime.android.approval.AndroidApprovalRequester
import com.sovereign.runtime.android.approval.AndroidApprovalResolutionReason
import com.sovereign.runtime.android.approval.AndroidApprovalResult
import com.sovereign.runtime.android.audit.AndroidAuditLedger
import com.sovereign.runtime.android.audit.AuditReceiptOutcome
import com.sovereign.runtime.android.audit.ImmutableAuditReceiptStore
import com.sovereign.runtime.android.runtime.AuthorityProfile
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
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AndroidToolApprovalIntegrationTest {
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
    fun allowOnceExecutesExactlyOnceAndLinksApprovalToBothReceipts() = runBlocking {
        val captured = AtomicReference<AndroidApprovalRequestInput?>()
        val requester = AndroidApprovalRequester { input ->
            captured.set(input)
            AndroidApprovalResult(
                requestId = input.requestId,
                decision = AndroidApprovalDecision.ALLOW_ONCE,
                reason = AndroidApprovalResolutionReason.LOCAL_ALLOW,
            )
        }
        val fixture = Fixture(requester)
        try {
            val body = fixture.callConsequentialTool(
                argumentsJson = """{"target":"private-value"}""",
            )
            assertTrue(body.contains("approved-result"))
            assertEquals(1, fixture.operationCount.get())

            val approval = requireNotNull(captured.get())
            assertEquals(TEST_TOOL_NAME, approval.toolName)
            assertFalse(approval.detail.contains("private-value"))
            assertTrue(approval.argumentsSha256.matches(Regex("^[a-f0-9]{64}$")))

            val receipts = fixture.ledger.recent(10)
            assertEquals(2, receipts.size)
            assertEquals(AuditReceiptOutcome.REQUESTED, receipts[0].outcome)
            assertEquals(AuditReceiptOutcome.SUCCEEDED, receipts[1].outcome)
            assertEquals(approval.requestId, receipts[0].approvalRequestId)
            assertEquals(approval.requestId, receipts[1].approvalRequestId)
            assertEquals(receipts[0].receiptSha256, receipts[1].previousReceiptSha256)

            val persisted = Files.readAllBytes(
                fixture.root.resolve("audit/receipt-0000000000000002.json"),
            ).toString(StandardCharsets.UTF_8)
            assertFalse(persisted.contains("private-value"))
            assertFalse(persisted.contains("approved-result"))
            assertFalse(persisted.contains(fixture.sessionId))
        } finally {
            fixture.close()
        }
    }

    @Test
    fun localDenialPreventsExecutionAndProducesADeniedResultReceipt() = runBlocking {
        val captured = AtomicReference<AndroidApprovalRequestInput?>()
        val requester = AndroidApprovalRequester { input ->
            captured.set(input)
            AndroidApprovalResult(
                requestId = input.requestId,
                decision = AndroidApprovalDecision.DENY,
                reason = AndroidApprovalResolutionReason.LOCAL_DENY,
            )
        }
        val fixture = Fixture(requester)
        try {
            val body = fixture.callConsequentialTool(
                argumentsJson = """{"target":"must-not-run"}""",
            )
            assertTrue(body.contains("APPROVAL_DENIED"))
            assertEquals(0, fixture.operationCount.get())

            val approval = requireNotNull(captured.get())
            val receipts = fixture.ledger.recent(10)
            assertEquals(2, receipts.size)
            assertEquals(AuditReceiptOutcome.DENIED, receipts[1].outcome)
            assertEquals("APPROVAL_DENIED", receipts[1].errorCode)
            assertEquals(approval.requestId, receipts[0].approvalRequestId)
            assertEquals(approval.requestId, receipts[1].approvalRequestId)
        } finally {
            fixture.close()
        }
    }

    @Test
    fun boundedBrokerDenialReasonsMapToDistinctToolErrors() = runBlocking {
        val cases = listOf(
            AndroidApprovalResolutionReason.TIMEOUT to "APPROVAL_TIMEOUT",
            AndroidApprovalResolutionReason.QUEUE_OVERFLOW to "APPROVAL_QUEUE_FULL",
            AndroidApprovalResolutionReason.DUPLICATE_REQUEST to "APPROVAL_DUPLICATE",
            AndroidApprovalResolutionReason.GATEWAY_STOP to "APPROVAL_CANCELLED",
        )
        for ((reason, expectedCode) in cases) {
            val fixture = Fixture(
                requester = AndroidApprovalRequester { input ->
                    AndroidApprovalResult(
                        requestId = input.requestId,
                        decision = AndroidApprovalDecision.DENY,
                        reason = reason,
                    )
                },
            )
            try {
                val body = fixture.callConsequentialTool(
                    argumentsJson = """{"target":"must-not-run"}""",
                )
                assertTrue("Expected $expectedCode for $reason", body.contains(expectedCode))
                assertEquals(0, fixture.operationCount.get())
                val receipts = fixture.ledger.recent(10)
                assertEquals(2, receipts.size)
                assertEquals(AuditReceiptOutcome.DENIED, receipts[1].outcome)
                assertEquals(expectedCode, receipts[1].errorCode)
            } finally {
                fixture.close()
            }
        }
    }

    @Test
    fun mismatchedBrokerRequestIdentityFailsClosed() = runBlocking {
        val fixture = Fixture(
            requester = AndroidApprovalRequester {
                AndroidApprovalResult(
                    requestId = java.util.UUID.randomUUID().toString(),
                    decision = AndroidApprovalDecision.ALLOW_ONCE,
                    reason = AndroidApprovalResolutionReason.LOCAL_ALLOW,
                )
            },
        )
        try {
            val body = fixture.callConsequentialTool(
                argumentsJson = """{"target":"must-not-run"}""",
            )
            assertTrue(body.contains("APPROVAL_MISMATCH"))
            assertEquals(0, fixture.operationCount.get())
            val receipts = fixture.ledger.recent(10)
            assertEquals(2, receipts.size)
            assertEquals(AuditReceiptOutcome.FAILED, receipts[1].outcome)
            assertEquals("APPROVAL_MISMATCH", receipts[1].errorCode)
        } finally {
            fixture.close()
        }
    }

    @Test
    fun approvalBrokerFailureFailsClosedWithoutInvokingTheOperation() = runBlocking {
        val fixture = Fixture(
            requester = AndroidApprovalRequester {
                throw IllegalStateException("simulated unavailable local surface")
            },
        )
        try {
            val body = fixture.callConsequentialTool(
                argumentsJson = """{"target":"must-not-run"}""",
            )
            assertTrue(body.contains("APPROVAL_UNAVAILABLE"))
            assertEquals(0, fixture.operationCount.get())

            val receipts = fixture.ledger.recent(10)
            assertEquals(2, receipts.size)
            assertEquals(AuditReceiptOutcome.FAILED, receipts[1].outcome)
            assertEquals("APPROVAL_UNAVAILABLE", receipts[1].errorCode)
            assertNotNull(receipts[0].approvalRequestId)
            assertEquals(receipts[0].approvalRequestId, receipts[1].approvalRequestId)
        } finally {
            fixture.close()
        }
    }

    private inner class Fixture(
        requester: AndroidApprovalRequester,
    ) {
        val root: Path = root()
        val ledger = AndroidAuditLedger(
            ImmutableAuditReceiptStore(root.resolve("audit")),
        )
        val operationCount = AtomicInteger()
        private val token = generateGatewayBearerToken()
        private val server = LocalMcpServer(
            bearerToken = token,
            serverFactory = { sessionContext ->
                testServer(
                    sessionContext = sessionContext,
                    requester = requester,
                    ledger = ledger,
                    operationCount = operationCount,
                )
            },
            onSessionCountChanged = {},
        )
        private val client = HttpClient(CIO) { expectSuccess = false }
        private val endpoint: String
        val sessionId: String

        init {
            val port = runBlocking { server.start() }
            endpoint = "http://127.0.0.1:$port/mcp"
            sessionId = runBlocking { initialize(client, endpoint, token) }
        }

        suspend fun callConsequentialTool(argumentsJson: String): String {
            val response = client.post(endpoint) {
                streamableHeaders(token, sessionId)
                setBody(
                    """{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"$TEST_TOOL_NAME","arguments":$argumentsJson}}""",
                )
            }
            assertEquals(HttpStatusCode.OK, response.status)
            return response.bodyAsText()
        }

        suspend fun close() {
            server.stop()
            client.close()
        }
    }

    private fun testServer(
        sessionContext: McpSessionContext,
        requester: AndroidApprovalRequester,
        ledger: AndroidAuditLedger,
        operationCount: AtomicInteger,
    ): Server {
        val definition = consequentialDefinition()
        val approval = AndroidToolApproval(
            requester = requester,
            sessionContext = sessionContext,
            authorityProvider = { AuthorityProfile.INTERACTION.displayName },
        )
        val audit = AndroidToolAudit(
            ledger = ledger,
            sessionContext = sessionContext,
            authorityProvider = { AuthorityProfile.INTERACTION.displayName },
            reportError = { error -> throw error },
        )
        return Server(
            serverInfo = Implementation(
                name = "sovereign-approval-test-server",
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
                inputSchema = ToolSchema(
                    properties = definition.properties,
                    required = definition.requiredArguments,
                ),
                outputSchema = ToolSchema(),
                toolAnnotations = ToolAnnotations(
                    title = definition.title,
                    readOnlyHint = false,
                    destructiveHint = true,
                    idempotentHint = false,
                    openWorldHint = true,
                ),
            ) { request ->
                val plan = approval.plan(definition, request)
                audit.execute(
                    definition = definition,
                    request = request,
                    approvalRequestId = plan.requestId,
                ) {
                    plan.authorize {
                        operationCount.incrementAndGet()
                        toolSuccess(
                            buildJsonObject {
                                put("ok", true)
                                put("value", "approved-result")
                            },
                        )
                    }
                }
            }
        }
    }

    private fun consequentialDefinition(): AndroidToolDefinition = AndroidToolDefinition(
        name = TEST_TOOL_NAME,
        title = "Test consequential action",
        description = "Execute one synthetic consequential action after explicit local approval.",
        authority = AuthorityProfile.INTERACTION,
        readOnly = false,
        destructive = true,
        openWorld = true,
        approvalMode = AndroidApprovalMode.SINGLE_USE,
        auditMode = AndroidAuditMode.INTENT_RESULT,
        requiredArguments = listOf("target"),
        properties = buildJsonObject {
            put("target", buildJsonObject {
                put("type", "string")
                put("maxLength", 128)
            })
        },
    )

    private suspend fun initialize(
        client: HttpClient,
        endpoint: String,
        token: String,
    ): String {
        val initialize = client.post(endpoint) {
            streamableHeaders(token)
            setBody(
                """{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"$LATEST_PROTOCOL_VERSION","capabilities":{},"clientInfo":{"name":"approval-test-client","version":"1.0.0"}}}""",
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

    private fun root(): Path = Files.createTempDirectory("sar-tool-approval-test-").also(cleanup::add)

    private companion object {
        const val TEST_TOOL_NAME = "android.test.consequential"
    }
}
