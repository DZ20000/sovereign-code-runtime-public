package com.sovereign.runtime.android.gateway

import com.sovereign.runtime.android.audit.principalFingerprint as auditPrincipalFingerprint
import io.modelcontextprotocol.kotlin.sdk.server.Server
import io.modelcontextprotocol.kotlin.sdk.server.StreamableHttpServerTransport
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Semaphore
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

internal const val MCP_SESSION_ID_HEADER = "Mcp-Session-Id"
private val SESSION_ID_PATTERN = Regex("^[A-Za-z0-9._-]{1,128}$")

internal class McpSessionContext(
    private val reservationId: String,
) {
    private val sessionId = AtomicReference<String?>(null)

    init {
        require(runCatching { UUID.fromString(reservationId) }.isSuccess) {
            "MCP reservation identity must be a UUID."
        }
    }

    fun bindSession(value: String) {
        require(SESSION_ID_PATTERN.matches(value)) {
            "MCP session identity has an invalid shape."
        }
        val previous = sessionId.get()
        require(previous == null || previous == value) {
            "MCP session context cannot be rebound to another session."
        }
        sessionId.compareAndSet(null, value)
    }

    fun principalFingerprint(): String = auditPrincipalFingerprint(
        sessionId.get()?.let { value -> "session:$value" }
            ?: "reservation:$reservationId",
    )
}

internal class McpSessionRegistry(
    maximumSessions: Int = MCP_GATEWAY_MAX_SESSIONS,
    private val onCountChanged: (Int) -> Unit = {},
) {
    init {
        require(maximumSessions in 1..64) {
            "maximumSessions must be from 1 through 64."
        }
    }

    private class Reservation(
        val id: String,
        val context: McpSessionContext,
        val transport: StreamableHttpServerTransport,
        private val permits: Semaphore,
    ) {
        val initialized = AtomicBoolean(false)
        private val released = AtomicBoolean(false)

        fun releasePermitOnce() {
            if (released.compareAndSet(false, true)) {
                permits.release()
            }
        }
    }

    internal class ReservedTransport(
        val transport: StreamableHttpServerTransport,
        private val releaseIfUninitializedBlock: suspend () -> Unit,
    ) {
        suspend fun releaseIfUninitialized() {
            releaseIfUninitializedBlock()
        }
    }

    private val sessions = ConcurrentHashMap<String, StreamableHttpServerTransport>()
    private val reservations = ConcurrentHashMap<String, Reservation>()
    private val permits = Semaphore(maximumSessions, true)

    fun activeCount(): Int = sessions.size

    internal fun reservedCount(): Int = reservations.size

    fun find(sessionId: String?): StreamableHttpServerTransport? {
        if (sessionId == null || !SESSION_ID_PATTERN.matches(sessionId)) return null
        return sessions[sessionId]
    }

    fun isValidSessionId(sessionId: String?): Boolean =
        sessionId != null && SESSION_ID_PATTERN.matches(sessionId)

    suspend fun reserveAndCreate(
        serverFactory: (McpSessionContext) -> Server,
    ): ReservedTransport? {
        if (!permits.tryAcquire()) return null
        val transport = StreamableHttpServerTransport(
            StreamableHttpServerTransport.Configuration(
                enableJsonResponse = true,
                maxRequestBodySize = MCP_GATEWAY_MAX_REQUEST_BYTES,
            ),
        )
        val reservationId = UUID.randomUUID().toString()
        val reservation = Reservation(
            id = reservationId,
            context = McpSessionContext(reservationId),
            transport = transport,
            permits = permits,
        )
        check(reservations.putIfAbsent(reservation.id, reservation) == null) {
            "MCP transport reservation ID collided."
        }

        fun retireReservation() {
            reservations.remove(reservation.id, reservation)
            reservation.releasePermitOnce()
        }

        fun removeSession(sessionId: String?) {
            if (sessionId != null && sessions.remove(sessionId, transport)) {
                onCountChanged(sessions.size)
            }
        }

        transport.setOnSessionInitialized { sessionId ->
            if (!SESSION_ID_PATTERN.matches(sessionId)) {
                return@setOnSessionInitialized
            }
            val previous = sessions.putIfAbsent(sessionId, transport)
            if (previous == null) {
                reservation.context.bindSession(sessionId)
                reservation.initialized.set(true)
                onCountChanged(sessions.size)
            }
        }
        transport.setOnSessionClosed { sessionId ->
            removeSession(sessionId)
            retireReservation()
        }

        return try {
            val server = serverFactory(reservation.context)
            server.onClose {
                removeSession(transport.sessionId)
                retireReservation()
            }
            server.createSession(transport)
            ReservedTransport(
                transport = transport,
                releaseIfUninitializedBlock = {
                    if (!reservation.initialized.get()) {
                        runCatching { transport.close() }
                        removeSession(transport.sessionId)
                        retireReservation()
                    }
                },
            )
        } catch (error: Throwable) {
            runCatching { transport.close() }
            removeSession(transport.sessionId)
            retireReservation()
            throw error
        }
    }

    suspend fun closeAll() {
        val snapshot = reservations.values.toList()
        sessions.clear()
        onCountChanged(0)
        snapshot.forEach { reservation ->
            runCatching { reservation.transport.close() }
            reservations.remove(reservation.id, reservation)
            reservation.releasePermitOnce()
        }
    }
}
