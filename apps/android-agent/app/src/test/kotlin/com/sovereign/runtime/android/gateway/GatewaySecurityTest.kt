package com.sovereign.runtime.android.gateway

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class GatewaySecurityTest {
    private val token = generateGatewayBearerToken()
    private val policy = GatewayRequestPolicy(token)

    @Test
    fun generatedTokensAreBoundedUrlSafeAndDistinct() {
        val tokens = List(32) { generateGatewayBearerToken() }
        assertEquals(32, tokens.toSet().size)
        tokens.forEach { value ->
            assertEquals(GATEWAY_BEARER_TOKEN_CHARACTERS, value.length)
            assertTrue(isValidGatewayBearerToken(value))
            assertTrue(value.all { it.isLetterOrDigit() || it == '_' || it == '-' })
        }
        assertEquals(16, gatewayBearerFingerprint(tokens.first()).length)
        assertNotEquals(
            gatewayBearerFingerprint(tokens.first()),
            gatewayBearerFingerprint(tokens.last()),
        )
    }

    @Test
    fun validLoopbackPostWithoutBrowserOriginIsAuthorized() {
        val decision = evaluate()
        assertTrue(decision.allowed)
        assertEquals(200, decision.httpStatus)
        assertNull(decision.rejectionCode)
    }

    @Test
    fun allSupportedMethodsUseTheSameSecurityBoundary() {
        for (method in listOf("GET", "POST", "DELETE")) {
            assertTrue(evaluate(method = method).allowed)
        }
        val rejected = evaluate(method = "PUT")
        assertFalse(rejected.allowed)
        assertEquals(405, rejected.httpStatus)
        assertEquals(
            GatewayRequestRejectionCode.METHOD_NOT_ALLOWED,
            rejected.rejectionCode,
        )
    }

    @Test
    fun missingDuplicateMalformedAndWrongBearerAreRejected() {
        val cases = listOf(
            emptyList(),
            listOf("Bearer $token", "Bearer $token"),
            listOf(token),
            listOf("Basic $token"),
            listOf("Bearer ${generateGatewayBearerToken()}"),
            listOf("Bearer $token "),
        )
        cases.forEachIndexed { index, headers ->
            val decision = evaluate(authorization = headers)
            assertFalse("case $index should be rejected", decision.allowed)
            assertEquals(401, decision.httpStatus)
            assertTrue(
                decision.rejectionCode in setOf(
                    GatewayRequestRejectionCode.MISSING_AUTHORIZATION,
                    GatewayRequestRejectionCode.INVALID_AUTHORIZATION,
                ),
            )
        }
    }

    @Test
    fun hostMustBeExactlyOneValidatedLoopbackAuthority() {
        for (host in listOf(
            "localhost",
            "localhost:3210",
            "LOCALHOST:65535",
            "127.0.0.1",
            "127.0.0.1:1",
            "[::1]",
            "[::1]:443",
        )) {
            assertTrue("expected $host to be allowed", evaluate(host = listOf(host)).allowed)
        }
        for (headers in listOf(
            emptyList(),
            listOf("localhost", "localhost"),
            listOf("evil.example"),
            listOf("0.0.0.0"),
            listOf("127.0.0.1:0"),
            listOf("127.0.0.1:65536"),
            listOf("127.0.0.1,evil.example"),
            listOf("user@localhost"),
            listOf("localhost/path"),
            listOf(" localhost"),
        )) {
            val decision = evaluate(host = headers)
            assertFalse("expected $headers to be rejected", decision.allowed)
            assertEquals(GatewayRequestRejectionCode.INVALID_HOST, decision.rejectionCode)
            assertEquals(421, decision.httpStatus)
        }
    }

    @Test
    fun originMayBeAbsentOrOneCanonicalLoopbackHttpOrigin() {
        for (origin in listOf(
            "http://localhost",
            "https://localhost:8443",
            "http://127.0.0.1:3210",
            "https://[::1]",
            "http://[::1]:1234/",
        )) {
            assertTrue("expected $origin to be allowed", evaluate(origin = listOf(origin)).allowed)
        }
        for (headers in listOf(
            listOf("https://evil.example"),
            listOf("file://localhost"),
            listOf("http://user@localhost"),
            listOf("http://localhost/path"),
            listOf("http://localhost/?query=1"),
            listOf("http://localhost/#fragment"),
            listOf("null"),
            listOf("http://localhost", "http://localhost"),
            listOf(" http://localhost"),
        )) {
            val decision = evaluate(origin = headers)
            assertFalse("expected $headers to be rejected", decision.allowed)
            assertEquals(GatewayRequestRejectionCode.INVALID_ORIGIN, decision.rejectionCode)
            assertEquals(403, decision.httpStatus)
        }
    }

    @Test
    fun requestPathCannotEscapeTheMcpEndpoint() {
        for (path in listOf("/", "/mcp/", "/mcp?x=1", "/healthz")) {
            val decision = evaluate(path = path)
            assertFalse(decision.allowed)
            assertEquals(404, decision.httpStatus)
            assertEquals(GatewayRequestRejectionCode.PATH_NOT_FOUND, decision.rejectionCode)
        }
    }

    private fun evaluate(
        method: String = "POST",
        path: String = "/mcp",
        host: List<String> = listOf("127.0.0.1:3210"),
        origin: List<String> = emptyList(),
        authorization: List<String> = listOf("Bearer $token"),
    ): GatewayRequestDecision = policy.evaluate(
        GatewayRequestMetadata(
            method = method,
            path = path,
            hostHeaders = host,
            originHeaders = origin,
            authorizationHeaders = authorization,
        ),
    )
}
