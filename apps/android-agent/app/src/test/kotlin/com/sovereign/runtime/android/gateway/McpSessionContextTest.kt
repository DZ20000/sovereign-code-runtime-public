package com.sovereign.runtime.android.gateway

import java.util.UUID
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class McpSessionContextTest {
    @Test
    fun fingerprintChangesFromReservationToBoundSessionWithoutExposingIdentity() {
        val context = McpSessionContext(UUID.randomUUID().toString())
        val reservationFingerprint = context.principalFingerprint()
        assertTrue(reservationFingerprint.matches(Regex("^[a-f0-9]{16}$")))

        context.bindSession("session_123")
        val sessionFingerprint = context.principalFingerprint()
        assertTrue(sessionFingerprint.matches(Regex("^[a-f0-9]{16}$")))
        assertNotEquals(reservationFingerprint, sessionFingerprint)

        context.bindSession("session_123")
        assertEquals(sessionFingerprint, context.principalFingerprint())
        assertTrue(runCatching { context.bindSession("other_session") }.isFailure)
    }

    @Test
    fun rejectsInvalidReservationAndSessionShapes() {
        assertTrue(runCatching { McpSessionContext("not-a-uuid") }.isFailure)
        val context = McpSessionContext(UUID.randomUUID().toString())
        assertTrue(runCatching { context.bindSession("contains space") }.isFailure)
        assertTrue(runCatching { context.bindSession("x".repeat(129)) }.isFailure)
    }
}
