package com.sovereign.runtime.android.gateway

import android.content.Context
import com.sovereign.runtime.android.runtime.AndroidAgentRuntime
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

internal data class McpGatewayControllerDependencies(
    val prepareAudit: suspend () -> Unit,
    val loadCredential: suspend () -> GatewayBearerCredential,
    val rotateCredential: suspend () -> GatewayBearerCredential,
    val createListener: (
        bearerToken: String,
        gatewayStateProvider: () -> McpGatewayState,
        onSessionCountChanged: (Int) -> Unit,
    ) -> McpListener,
    val reportStatus: (String) -> Unit,
)

class McpGatewayController private constructor(
    private val dependencies: McpGatewayControllerDependencies,
) {
    private val lifecycleMutex = Mutex()
    private var server: McpListener? = null
    private var activeToken: String? = null
    private val mutableState = MutableStateFlow(McpGatewayState())

    internal constructor(
        context: Context,
        runtime: AndroidAgentRuntime,
    ) : this(productionDependencies(context, runtime))

    internal constructor(
        prepareAudit: suspend () -> Unit = {},
        loadCredential: suspend () -> GatewayBearerCredential,
        rotateCredential: suspend () -> GatewayBearerCredential,
        createListener: (
            bearerToken: String,
            gatewayStateProvider: () -> McpGatewayState,
            onSessionCountChanged: (Int) -> Unit,
        ) -> McpListener,
        reportStatus: (String) -> Unit = {},
    ) : this(
        McpGatewayControllerDependencies(
            prepareAudit = prepareAudit,
            loadCredential = loadCredential,
            rotateCredential = rotateCredential,
            createListener = createListener,
            reportStatus = reportStatus,
        ),
    )

    val state: StateFlow<McpGatewayState> = mutableState.asStateFlow()

    suspend fun start(): McpGatewayState = lifecycleMutex.withLock {
        val current = mutableState.value
        if (current.phase == McpGatewayPhase.RUNNING) return current
        check(current.phase !in setOf(McpGatewayPhase.STARTING, McpGatewayPhase.STOPPING)) {
            "The local MCP gateway is already changing state."
        }
        check(server == null) {
            "A previous local MCP listener is still owned. Stop it before starting another listener."
        }
        mutableState.value = current.copy(
            phase = McpGatewayPhase.STARTING,
            port = null,
            endpoint = null,
            listenerOwned = false,
            activeSessions = 0,
            startedAtEpochMs = null,
            errorMessage = null,
        )
        try {
            dependencies.prepareAudit()
            val credential = dependencies.loadCredential()
            val tokenFingerprint = gatewayBearerFingerprint(credential.token)
            val localServer = dependencies.createListener(
                credential.token,
                { mutableState.value },
                { count ->
                    mutableState.update { state ->
                        state.copy(
                            activeSessions = count.coerceIn(0, MCP_GATEWAY_MAX_SESSIONS),
                        )
                    }
                },
            )
            server = localServer
            activeToken = credential.token
            mutableState.update { state ->
                state.copy(
                    listenerOwned = true,
                    tokenFingerprint = tokenFingerprint,
                )
            }
            val port = localServer.start()
            mutableState.value = McpGatewayState(
                phase = McpGatewayPhase.RUNNING,
                port = port,
                endpoint = "http://127.0.0.1:$port$MCP_GATEWAY_PATH",
                listenerOwned = true,
                tokenFingerprint = tokenFingerprint,
                activeSessions = 0,
                startedAtEpochMs = System.currentTimeMillis(),
                errorMessage = null,
            )
            if (credential.recoveredFromInvalidStorage) {
                dependencies.reportStatus(
                    "The previous protected gateway credential was invalid and was rotated locally.",
                )
            }
            mutableState.value
        } catch (error: CancellationException) {
            withContext(NonCancellable) {
                val cleanupFailure = retireServerWithRetry()
                mutableState.value = if (cleanupFailure == null) {
                    McpGatewayState()
                } else {
                    failureState(error, cleanupFailure)
                }
            }
            throw error
        } catch (error: Throwable) {
            withContext(NonCancellable) {
                val cleanupFailure = retireServerWithRetry()
                mutableState.value = failureState(error, cleanupFailure)
            }
            throw error
        }
    }

    suspend fun stop(): McpGatewayState = lifecycleMutex.withLock {
        if (server == null && mutableState.value.phase == McpGatewayPhase.STOPPED) {
            return mutableState.value
        }
        mutableState.update { state ->
            state.copy(
                phase = McpGatewayPhase.STOPPING,
                listenerOwned = server != null,
                activeSessions = 0,
                errorMessage = null,
            )
        }
        withContext(NonCancellable) {
            val cleanupFailure = retireServerWithRetry()
            if (cleanupFailure == null) {
                mutableState.value = McpGatewayState()
                return@withContext mutableState.value
            }
            mutableState.value = failureState(
                primaryError = IllegalStateException(
                    "The local MCP listener could not be confirmed stopped.",
                ),
                cleanupFailure = cleanupFailure,
            )
            throw cleanupFailure
        }
    }

    suspend fun rotateCredential(): String = lifecycleMutex.withLock {
        check(server == null) {
            "A local MCP listener is still owned. Stop it before rotating the Bearer credential."
        }
        check(mutableState.value.phase in setOf(McpGatewayPhase.STOPPED, McpGatewayPhase.ERROR)) {
            "Stop the local MCP gateway before rotating its Bearer credential."
        }
        val credential = dependencies.rotateCredential()
        val fingerprint = gatewayBearerFingerprint(credential.token)
        mutableState.update { state ->
            state.copy(
                tokenFingerprint = fingerprint,
                errorMessage = null,
            )
        }
        fingerprint
    }

    suspend fun revealConnectionConfig(): McpGatewayConnectionConfig = lifecycleMutex.withLock {
        val current = mutableState.value
        check(
            current.phase == McpGatewayPhase.RUNNING &&
                current.listenerOwned &&
                current.endpoint != null,
        ) {
            "Start the local MCP gateway before revealing its connection configuration."
        }
        val token = activeToken ?: error("The running gateway Bearer credential is unavailable.")
        McpGatewayConnectionConfig(
            endpoint = current.endpoint,
            authorizationHeader = "Bearer $token",
            tokenFingerprint = gatewayBearerFingerprint(token),
        )
    }

    private suspend fun retireServerWithRetry(): Throwable? {
        if (server == null) {
            activeToken = null
            return null
        }
        var latestFailure: Throwable? = null
        repeat(STOP_ATTEMPTS) {
            try {
                retireServer()
                return null
            } catch (error: Throwable) {
                latestFailure = error
            }
        }
        return latestFailure ?: IllegalStateException(
            "The local MCP listener could not be confirmed stopped.",
        )
    }

    private suspend fun retireServer() {
        val activeServer = server ?: run {
            activeToken = null
            return
        }
        activeServer.stop()
        if (server === activeServer) {
            server = null
            activeToken = null
        }
    }

    private fun failureState(
        primaryError: Throwable,
        cleanupFailure: Throwable?,
    ): McpGatewayState {
        val current = mutableState.value
        val listenerOwned = server != null
        val message = if (cleanupFailure == null) {
            boundedError(primaryError)
        } else {
            boundedError(
                IllegalStateException(
                    "${boundedError(primaryError)} Listener shutdown was not confirmed: " +
                        boundedError(cleanupFailure),
                    cleanupFailure,
                ),
            )
        }
        return current.copy(
            phase = McpGatewayPhase.ERROR,
            port = current.port.takeIf { listenerOwned },
            endpoint = current.endpoint.takeIf { listenerOwned },
            listenerOwned = listenerOwned,
            activeSessions = current.activeSessions.takeIf { listenerOwned } ?: 0,
            startedAtEpochMs = current.startedAtEpochMs.takeIf { listenerOwned },
            errorMessage = message,
        )
    }

    private fun boundedError(error: Throwable): String = (error.message ?: error::class.java.simpleName)
        .replace(Regex("[\\r\\n\\u0000]+"), " ")
        .replace(Regex("\\s+"), " ")
        .trim()
        .let { value ->
            when {
                value.isEmpty() -> "The local MCP gateway failed."
                value.length <= 512 -> value
                else -> value.take(511) + "…"
            }
        }

    companion object {
        private const val STOP_ATTEMPTS = 2

        private fun productionDependencies(
            context: Context,
            runtime: AndroidAgentRuntime,
        ): McpGatewayControllerDependencies {
            val credentialStore = GatewayCredentialStore(context.applicationContext)
            return McpGatewayControllerDependencies(
                prepareAudit = {
                    runtime.auditLedger.verify()
                },
                loadCredential = {
                    withContext(Dispatchers.IO) {
                        credentialStore.getOrCreate()
                    }
                },
                rotateCredential = {
                    withContext(Dispatchers.IO) {
                        credentialStore.rotate()
                    }
                },
                createListener = { bearerToken, gatewayStateProvider, onCountChanged ->
                    val toolServerFactory = AndroidMcpToolServerFactory(
                        runtime = runtime,
                        gatewayStateProvider = gatewayStateProvider,
                    )
                    LocalMcpServer(
                        bearerToken = bearerToken,
                        serverFactory = toolServerFactory::create,
                        onSessionCountChanged = onCountChanged,
                    )
                },
                reportStatus = runtime::reportStatus,
            )
        }
    }
}
