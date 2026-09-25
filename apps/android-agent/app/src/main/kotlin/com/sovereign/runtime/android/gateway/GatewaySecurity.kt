package com.sovereign.runtime.android.gateway

import java.net.URI
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64

const val GATEWAY_BEARER_TOKEN_BYTES = 32
const val GATEWAY_BEARER_TOKEN_CHARACTERS = 43

private val BEARER_PATTERN = Regex(
    pattern = "^Bearer ([A-Za-z0-9_-]{$GATEWAY_BEARER_TOKEN_CHARACTERS})$",
    option = RegexOption.IGNORE_CASE,
)
private val LOOPBACK_HOST_PATTERN = Regex(
    pattern = "^(localhost|127\\.0\\.0\\.1)(?::([0-9]{1,5}))?$",
    option = RegexOption.IGNORE_CASE,
)
private val IPV6_LOOPBACK_HOST_PATTERN = Regex(
    pattern = "^\\[::1](?::([0-9]{1,5}))?$",
    option = RegexOption.IGNORE_CASE,
)

fun generateGatewayBearerToken(
    secureRandom: SecureRandom = SecureRandom(),
): String {
    val bytes = ByteArray(GATEWAY_BEARER_TOKEN_BYTES)
    secureRandom.nextBytes(bytes)
    return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes).also { token ->
        check(token.length == GATEWAY_BEARER_TOKEN_CHARACTERS) {
            "Generated gateway token has an unexpected encoded length."
        }
    }
}

fun gatewayBearerFingerprint(token: String): String {
    require(isValidGatewayBearerToken(token)) { "Gateway bearer token has an invalid shape." }
    val digest = MessageDigest.getInstance("SHA-256")
        .digest(token.toByteArray(Charsets.UTF_8))
    return digest.take(8).joinToString(separator = "") { byte -> "%02x".format(byte) }
}

fun isValidGatewayBearerToken(token: String): Boolean =
    token.length == GATEWAY_BEARER_TOKEN_CHARACTERS &&
        token.all { character ->
            character.isLetterOrDigit() || character == '_' || character == '-'
        }

enum class GatewayRequestRejectionCode {
    METHOD_NOT_ALLOWED,
    PATH_NOT_FOUND,
    INVALID_HOST,
    INVALID_ORIGIN,
    MISSING_AUTHORIZATION,
    INVALID_AUTHORIZATION,
}

data class GatewayRequestMetadata(
    val method: String,
    val path: String,
    val hostHeaders: List<String>,
    val originHeaders: List<String>,
    val authorizationHeaders: List<String>,
)

data class GatewayRequestDecision(
    val allowed: Boolean,
    val httpStatus: Int,
    val rejectionCode: GatewayRequestRejectionCode?,
    val publicMessage: String,
)

class GatewayRequestPolicy(
    bearerToken: String,
) {
    private val expectedToken = bearerToken.also { token ->
        require(isValidGatewayBearerToken(token)) {
            "Gateway bearer token has an invalid shape."
        }
    }.toByteArray(Charsets.UTF_8)

    fun evaluate(request: GatewayRequestMetadata): GatewayRequestDecision {
        if (request.path != "/mcp") {
            return denied(
                status = 404,
                code = GatewayRequestRejectionCode.PATH_NOT_FOUND,
                message = "Not found.",
            )
        }
        if (request.method.uppercase() !in setOf("GET", "POST", "DELETE")) {
            return denied(
                status = 405,
                code = GatewayRequestRejectionCode.METHOD_NOT_ALLOWED,
                message = "Method not allowed.",
            )
        }
        if (request.hostHeaders.size != 1 || !isAllowedLoopbackHost(request.hostHeaders.single())) {
            return denied(
                status = 421,
                code = GatewayRequestRejectionCode.INVALID_HOST,
                message = "Misdirected request.",
            )
        }
        if (!isAllowedOriginHeaders(request.originHeaders)) {
            return denied(
                status = 403,
                code = GatewayRequestRejectionCode.INVALID_ORIGIN,
                message = "Origin is not allowed.",
            )
        }
        if (request.authorizationHeaders.isEmpty()) {
            return denied(
                status = 401,
                code = GatewayRequestRejectionCode.MISSING_AUTHORIZATION,
                message = "Bearer authentication is required.",
            )
        }
        if (request.authorizationHeaders.size != 1) {
            return denied(
                status = 401,
                code = GatewayRequestRejectionCode.INVALID_AUTHORIZATION,
                message = "Bearer authentication failed.",
            )
        }
        val match = BEARER_PATTERN.matchEntire(request.authorizationHeaders.single())
            ?: return denied(
                status = 401,
                code = GatewayRequestRejectionCode.INVALID_AUTHORIZATION,
                message = "Bearer authentication failed.",
            )
        val supplied = match.groupValues[1].toByteArray(Charsets.UTF_8)
        if (!MessageDigest.isEqual(expectedToken, supplied)) {
            return denied(
                status = 401,
                code = GatewayRequestRejectionCode.INVALID_AUTHORIZATION,
                message = "Bearer authentication failed.",
            )
        }
        return GatewayRequestDecision(
            allowed = true,
            httpStatus = 200,
            rejectionCode = null,
            publicMessage = "Authorized.",
        )
    }

    private fun denied(
        status: Int,
        code: GatewayRequestRejectionCode,
        message: String,
    ): GatewayRequestDecision = GatewayRequestDecision(
        allowed = false,
        httpStatus = status,
        rejectionCode = code,
        publicMessage = message,
    )

    private fun isAllowedOriginHeaders(headers: List<String>): Boolean {
        if (headers.isEmpty()) return true
        if (headers.size != 1) return false
        val raw = headers.single()
        if (raw != raw.trim() || raw.length !in 1..512) return false
        val uri = runCatching { URI(raw) }.getOrNull() ?: return false
        if (uri.scheme?.lowercase() !in setOf("http", "https")) return false
        if (uri.userInfo != null || uri.query != null || uri.fragment != null) return false
        if (uri.path !in listOf("", "/")) return false
        if (uri.port !in -1..65535 || uri.port == 0) return false
        val host = uri.host?.lowercase()?.removePrefix("[")?.removeSuffix("]") ?: return false
        return host == "localhost" || host == "127.0.0.1" || host == "::1"
    }

    private fun isAllowedLoopbackHost(raw: String): Boolean {
        if (
            raw != raw.trim() ||
            raw.length !in 1..128 ||
            raw.any { character -> character.isWhitespace() || character.isISOControl() } ||
            raw.any { character -> character in listOf('/', '\\', '@', ',', '#', '?') }
        ) {
            return false
        }
        val match = LOOPBACK_HOST_PATTERN.matchEntire(raw)
        if (match != null) {
            return validOptionalPort(match.groupValues[2])
        }
        val ipv6Match = IPV6_LOOPBACK_HOST_PATTERN.matchEntire(raw) ?: return false
        return validOptionalPort(ipv6Match.groupValues[1])
    }

    private fun validOptionalPort(portText: String): Boolean {
        if (portText.isEmpty()) return true
        val port = portText.toIntOrNull() ?: return false
        return port in 1..65535
    }
}
