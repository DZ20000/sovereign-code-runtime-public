package com.sovereign.runtime.android.gateway

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class McpGatewayControllerTest {
    private val primaryToken = "A".repeat(GATEWAY_BEARER_TOKEN_CHARACTERS)
    private val rotatedToken = "B".repeat(GATEWAY_BEARER_TOKEN_CHARACTERS)

    @Test
    fun successfulLifecycleOwnsOneListenerAndRevealsOnlyWhileRunning() = runTest {
        val listener = FakeListener(port = 43123)
        var sessionCountChanged: ((Int) -> Unit)? = null
        val controller = controller(
            listener = listener,
            onFactorySessionCallback = { callback -> sessionCountChanged = callback },
        )

        val running = controller.start()
        assertEquals(McpGatewayPhase.RUNNING, running.phase)
        assertTrue(running.listenerOwned)
        assertEquals("http://127.0.0.1:43123/mcp", running.endpoint)
        assertEquals(1, listener.startCalls)

        sessionCountChanged?.invoke(99)
        assertEquals(MCP_GATEWAY_MAX_SESSIONS, controller.state.value.activeSessions)

        val config = controller.revealConnectionConfig()
        assertEquals(running.endpoint, config.endpoint)
        assertEquals("Bearer $primaryToken", config.authorizationHeader)
        assertEquals(gatewayBearerFingerprint(primaryToken), config.tokenFingerprint)

        val stopped = controller.stop()
        assertEquals(McpGatewayPhase.STOPPED, stopped.phase)
        assertFalse(stopped.listenerOwned)
        assertNull(stopped.endpoint)
        assertEquals(1, listener.stopCalls)
        assertTrue(runCatching { controller.revealConnectionConfig() }.isFailure)
    }

    @Test
    fun firstStopFailureCanRecoverOnTheBuiltInSecondAttempt() = runTest {
        val listener = FakeListener(stopFailuresRemaining = 1)
        val controller = controller(listener)
        controller.start()

        val stopped = controller.stop()
        assertEquals(McpGatewayPhase.STOPPED, stopped.phase)
        assertFalse(stopped.listenerOwned)
        assertEquals(2, listener.stopCalls)
    }

    @Test
    fun repeatedStopFailureRetainsOwnershipAndBlocksRestartAndRotation() = runTest {
        val listener = FakeListener(stopFailuresRemaining = 2)
        val controller = controller(listener)
        controller.start()

        val stopFailure = runCatching { controller.stop() }.exceptionOrNull()
        assertNotNull(stopFailure)
        val errorState = controller.state.value
        assertEquals(McpGatewayPhase.ERROR, errorState.phase)
        assertTrue(errorState.listenerOwned)
        assertTrue(errorState.errorMessage.orEmpty().contains("shutdown was not confirmed"))
        assertEquals(2, listener.stopCalls)

        assertTrue(runCatching { controller.start() }.isFailure)
        assertTrue(runCatching { controller.rotateCredential() }.isFailure)
        assertEquals(1, listener.startCalls)

        listener.stopFailuresRemaining = 0
        val recovered = controller.stop()
        assertEquals(McpGatewayPhase.STOPPED, recovered.phase)
        assertFalse(recovered.listenerOwned)
        assertEquals(3, listener.stopCalls)
    }

    @Test
    fun startFailureWithFailedCleanupKeepsTheFailedListenerOwned() = runTest {
        val listener = FakeListener(
            startFailure = IllegalStateException("simulated bind failure"),
            stopFailuresRemaining = 2,
        )
        val controller = controller(listener)

        val startFailure = runCatching { controller.start() }.exceptionOrNull()
        assertNotNull(startFailure)
        val state = controller.state.value
        assertEquals(McpGatewayPhase.ERROR, state.phase)
        assertTrue(state.listenerOwned)
        assertTrue(state.errorMessage.orEmpty().contains("simulated bind failure"))
        assertTrue(state.errorMessage.orEmpty().contains("shutdown was not confirmed"))
        assertTrue(runCatching { controller.start() }.isFailure)

        listener.startFailure = null
        listener.stopFailuresRemaining = 0
        controller.stop()
        val restarted = controller.start()
        assertEquals(McpGatewayPhase.RUNNING, restarted.phase)
        assertEquals(2, listener.startCalls)
        controller.stop()
    }

    @Test
    fun cancellationDuringStartRunsNonCancellableListenerCleanup() = runTest {
        val listener = BlockingListener()
        val controller = controller(listener)
        val startJob = launch { controller.start() }

        listener.startEntered.await()
        startJob.cancelAndJoin()

        assertEquals(1, listener.stopCalls)
        assertEquals(McpGatewayPhase.STOPPED, controller.state.value.phase)
        assertFalse(controller.state.value.listenerOwned)
    }

    @Test
    fun auditVerificationFailurePreventsCredentialAndListenerStartup() = runTest {
        val listener = FakeListener()
        var credentialLoads = 0
        var listenerCreates = 0
        val controller = McpGatewayController(
            prepareAudit = {
                throw IllegalStateException("simulated corrupt audit ledger")
            },
            loadCredential = {
                credentialLoads += 1
                GatewayBearerCredential(
                    token = primaryToken,
                    newlyCreated = false,
                    recoveredFromInvalidStorage = false,
                )
            },
            rotateCredential = {
                GatewayBearerCredential(
                    token = rotatedToken,
                    newlyCreated = true,
                    recoveredFromInvalidStorage = false,
                )
            },
            createListener = { _, _, _ ->
                listenerCreates += 1
                listener
            },
        )

        val error = runCatching { controller.start() }.exceptionOrNull()
        assertNotNull(error)
        assertEquals(0, credentialLoads)
        assertEquals(0, listenerCreates)
        assertEquals(0, listener.startCalls)
        assertEquals(McpGatewayPhase.ERROR, controller.state.value.phase)
        assertFalse(controller.state.value.listenerOwned)
        assertTrue(controller.state.value.errorMessage.orEmpty().contains("corrupt audit ledger"))
    }

    @Test
    fun recoveredCredentialReportsStatusAndRotationRequiresNoOwnedListener() = runTest {
        val listener = FakeListener()
        val statuses = mutableListOf<String>()
        var rotateCalls = 0
        val controller = McpGatewayController(
            loadCredential = {
                GatewayBearerCredential(
                    token = primaryToken,
                    newlyCreated = true,
                    recoveredFromInvalidStorage = true,
                )
            },
            rotateCredential = {
                rotateCalls += 1
                GatewayBearerCredential(
                    token = rotatedToken,
                    newlyCreated = true,
                    recoveredFromInvalidStorage = false,
                )
            },
            createListener = { _, _, _ -> listener },
            reportStatus = statuses::add,
        )

        controller.start()
        assertEquals(1, statuses.size)
        assertTrue(statuses.single().contains("rotated locally"))
        assertTrue(runCatching { controller.rotateCredential() }.isFailure)
        assertEquals(0, rotateCalls)

        controller.stop()
        val fingerprint = controller.rotateCredential()
        assertEquals(1, rotateCalls)
        assertEquals(gatewayBearerFingerprint(rotatedToken), fingerprint)
    }

    private fun controller(
        listener: McpListener,
        onFactorySessionCallback: ((Int) -> Unit) -> Unit = {},
        prepareAudit: suspend () -> Unit = {},
    ): McpGatewayController = McpGatewayController(
        prepareAudit = prepareAudit,
        loadCredential = {
            GatewayBearerCredential(
                token = primaryToken,
                newlyCreated = false,
                recoveredFromInvalidStorage = false,
            )
        },
        rotateCredential = {
            GatewayBearerCredential(
                token = rotatedToken,
                newlyCreated = true,
                recoveredFromInvalidStorage = false,
            )
        },
        createListener = { bearerToken, stateProvider, onSessionCountChanged ->
            assertEquals(primaryToken, bearerToken)
            assertNotNull(stateProvider())
            onFactorySessionCallback(onSessionCountChanged)
            listener
        },
    )

    private class FakeListener(
        private val port: Int = 43111,
        var startFailure: Throwable? = null,
        var stopFailuresRemaining: Int = 0,
    ) : McpListener {
        var startCalls = 0
            private set
        var stopCalls = 0
            private set

        override suspend fun start(): Int {
            startCalls += 1
            startFailure?.let { error -> throw error }
            return port
        }

        override suspend fun stop() {
            stopCalls += 1
            if (stopFailuresRemaining > 0) {
                stopFailuresRemaining -= 1
                throw IllegalStateException("simulated listener stop failure")
            }
        }
    }

    private class BlockingListener : McpListener {
        val startEntered = CompletableDeferred<Unit>()
        var stopCalls = 0
            private set

        override suspend fun start(): Int {
            startEntered.complete(Unit)
            awaitCancellation()
        }

        override suspend fun stop() {
            stopCalls += 1
        }
    }
}
