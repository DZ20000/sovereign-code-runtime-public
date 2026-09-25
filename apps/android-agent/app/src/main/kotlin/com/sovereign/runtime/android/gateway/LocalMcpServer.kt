package com.sovereign.runtime.android.gateway

import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.ApplicationCallPipeline
import io.ktor.server.application.install
import io.ktor.server.cio.CIO
import io.ktor.server.engine.embeddedServer
import io.ktor.server.plugins.bodylimit.RequestBodyLimit
import io.ktor.server.plugins.contentnegotiation.ContentNegotiation
import io.ktor.server.request.header
import io.ktor.server.request.httpMethod
import io.ktor.server.request.uri
import io.ktor.server.response.header
import io.ktor.server.response.respondText
import io.ktor.server.routing.delete
import io.ktor.server.routing.post
import io.ktor.server.routing.route
import io.ktor.server.routing.routing
import io.ktor.server.sse.SSE
import io.ktor.server.sse.sse
import io.ktor.serialization.kotlinx.json.json
import io.modelcontextprotocol.kotlin.sdk.server.DnsRebindingProtection
import io.modelcontextprotocol.kotlin.sdk.server.Server
import io.modelcontextprotocol.kotlin.sdk.types.McpJson
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

internal interface McpListener {
    suspend fun start(): Int

    suspend fun stop()
}

internal class LocalMcpServer(
    private val bearerToken: String,
    private val serverFactory: (McpSessionContext) -> Server,
    private val onSessionCountChanged: (Int) -> Unit,
) : McpListener {
    private val lifecycleMutex = Mutex()
    private var stopAction: (suspend () -> Unit)? = null

    override suspend fun start(): Int = lifecycleMutex.withLock {
        check(stopAction == null) { "Local MCP server is already running." }
        val requestPolicy = GatewayRequestPolicy(bearerToken)
        val sessions = McpSessionRegistry(
            maximumSessions = MCP_GATEWAY_MAX_SESSIONS,
            onCountChanged = onSessionCountChanged,
        )
        val ktorServer = embeddedServer(
            factory = CIO,
            host = "127.0.0.1",
            port = 0,
        ) {
            install(ContentNegotiation) {
                json(McpJson)
            }
            install(SSE)
            routing {
                route(MCP_GATEWAY_PATH) {
                    install(RequestBodyLimit) {
                        bodyLimit { MCP_GATEWAY_MAX_REQUEST_BYTES }
                    }
                    install(DnsRebindingProtection) {
                        allowedHosts = listOf("localhost", "127.0.0.1", "[::1]")
                        allowedOrigins = listOf(
                            "http://localhost",
                            "https://localhost",
                            "http://127.0.0.1",
                            "https://127.0.0.1",
                            "http://[::1]",
                            "https://[::1]",
                        )
                    }
                    intercept(ApplicationCallPipeline.Plugins) {
                        val decision = requestPolicy.evaluate(
                            GatewayRequestMetadata(
                                method = context.request.httpMethod.value,
                                path = context.request.uri,
                                hostHeaders = context.request.headers.getAll(HttpHeaders.Host).orEmpty(),
                                originHeaders = context.request.headers.getAll(HttpHeaders.Origin).orEmpty(),
                                authorizationHeaders = context.request.headers
                                    .getAll(HttpHeaders.Authorization)
                                    .orEmpty(),
                            ),
                        )
                        if (!decision.allowed) {
                            if (decision.httpStatus == HttpStatusCode.Unauthorized.value) {
                                context.response.header(
                                    HttpHeaders.WWWAuthenticate,
                                    "Bearer realm=\"sovereign-android-runtime\"",
                                )
                            }
                            context.respondText(
                                text = decision.publicMessage,
                                contentType = ContentType.Text.Plain,
                                status = HttpStatusCode.fromValue(decision.httpStatus),
                            )
                            finish()
                        }
                    }
                    sse {
                        val sessionId = call.request.header(MCP_SESSION_ID_HEADER)
                        val transport = sessions.find(sessionId)
                        if (transport == null) {
                            call.respondText(
                                text = if (sessions.isValidSessionId(sessionId)) {
                                    "Session not found."
                                } else {
                                    "A valid MCP session ID is required."
                                },
                                status = if (sessions.isValidSessionId(sessionId)) {
                                    HttpStatusCode.NotFound
                                } else {
                                    HttpStatusCode.BadRequest
                                },
                            )
                            return@sse
                        }
                        call.response.header(MCP_SESSION_ID_HEADER, sessionId!!)
                        transport.handleRequest(this, call)
                    }
                    post {
                        val sessionId = call.request.header(MCP_SESSION_ID_HEADER)
                        if (sessionId != null) {
                            val transport = sessions.find(sessionId)
                            if (transport == null) {
                                call.respondText(
                                    text = if (sessions.isValidSessionId(sessionId)) {
                                        "Session not found."
                                    } else {
                                        "The MCP session ID is invalid."
                                    },
                                    status = if (sessions.isValidSessionId(sessionId)) {
                                        HttpStatusCode.NotFound
                                    } else {
                                        HttpStatusCode.BadRequest
                                    },
                                )
                                return@post
                            }
                            transport.handleRequest(null, call)
                            return@post
                        }

                        val reserved = sessions.reserveAndCreate(serverFactory)
                        if (reserved == null) {
                            call.respondText(
                                text = "The local MCP session limit has been reached.",
                                status = HttpStatusCode.TooManyRequests,
                            )
                            return@post
                        }
                        try {
                            reserved.transport.handleRequest(null, call)
                        } finally {
                            reserved.releaseIfUninitialized()
                        }
                    }
                    delete {
                        val sessionId = call.request.header(MCP_SESSION_ID_HEADER)
                        val transport = sessions.find(sessionId)
                        if (transport == null) {
                            call.respondText(
                                text = if (sessions.isValidSessionId(sessionId)) {
                                    "Session not found."
                                } else {
                                    "A valid MCP session ID is required."
                                },
                                status = if (sessions.isValidSessionId(sessionId)) {
                                    HttpStatusCode.NotFound
                                } else {
                                    HttpStatusCode.BadRequest
                                },
                            )
                            return@delete
                        }
                        transport.handleRequest(null, call)
                    }
                }
            }
        }

        try {
            withContext(Dispatchers.IO) {
                ktorServer.start(wait = false)
            }
            val connector = ktorServer.engine.resolvedConnectors().singleOrNull()
                ?: error("Local MCP server did not expose exactly one connector.")
            check(connector.host == "127.0.0.1") {
                "Local MCP server escaped the loopback binding."
            }
            val port = connector.port
            check(port in 1..65535) { "Local MCP server returned an invalid port." }
            stopAction = {
                sessions.closeAll()
                withContext(Dispatchers.IO) {
                    ktorServer.stop(
                        gracePeriodMillis = 500,
                        timeoutMillis = 2_000,
                    )
                }
            }
            port
        } catch (error: Throwable) {
            runCatching {
                sessions.closeAll()
                withContext(Dispatchers.IO) {
                    ktorServer.stop(
                        gracePeriodMillis = 0,
                        timeoutMillis = 1_000,
                    )
                }
            }
            throw error
        }
    }

    override suspend fun stop() {
        lifecycleMutex.withLock {
            val action = stopAction ?: return
            action()
            stopAction = null
            onSessionCountChanged(0)
        }
    }
}
