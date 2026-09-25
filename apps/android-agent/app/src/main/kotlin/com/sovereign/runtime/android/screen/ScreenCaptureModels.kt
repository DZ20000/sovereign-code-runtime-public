package com.sovereign.runtime.android.screen

import java.security.MessageDigest
import java.util.UUID

internal enum class ScreenCaptureStatus {
    READY,
    DENIED,
    UNSUPPORTED,
    SECURE_WINDOW,
    FAILED,
}

internal data class ScreenCaptureArtifact(
    val captureId: String,
    val revision: Long,
    val packageName: String,
    val windowId: Int,
    val capturedAtElapsedMs: Long,
    val width: Int,
    val height: Int,
    val mimeType: String,
    val bytes: ByteArray,
    val sha256: String,
    val status: ScreenCaptureStatus = ScreenCaptureStatus.READY,
    val reasonCode: String? = null,
) {
    init {
        require(runCatching { UUID.fromString(captureId) }.isSuccess) {
            "Screen capture ID must be a UUID."
        }
        require(revision >= 1) { "Screen capture revision must be positive." }
        require(PACKAGE_PATTERN.matches(packageName)) {
            "Screen capture package has an invalid shape."
        }
        require(capturedAtElapsedMs >= 0) {
            "Screen capture elapsed timestamp must be non-negative."
        }
        require(width in 1..8_192 && height in 1..8_192) {
            "Screen capture dimensions exceed their limits."
        }
        require(width.toLong() * height.toLong() <= MAX_PIXELS) {
            "Screen capture pixel count exceeds its limit."
        }
        require(mimeType in setOf("image/png", "image/jpeg")) {
            "Screen capture MIME type is unsupported."
        }
        require(bytes.isNotEmpty() && bytes.size <= MAX_ENCODED_BYTES) {
            "Screen capture byte length exceeds its limit."
        }
        require(SHA256_PATTERN.matches(sha256) && secureSha256(bytes) == sha256) {
            "Screen capture digest verification failed."
        }
        require(status == ScreenCaptureStatus.READY && reasonCode == null) {
            "Stored screen capture artifacts must be ready and have no error reason."
        }
    }

    fun metadata(): ScreenCaptureMetadata = ScreenCaptureMetadata(
        captureId = captureId,
        revision = revision,
        packageName = packageName,
        windowId = windowId,
        capturedAtElapsedMs = capturedAtElapsedMs,
        width = width,
        height = height,
        mimeType = mimeType,
        byteLength = bytes.size,
        sha256 = sha256,
    )

    companion object {
        const val MAX_ENCODED_BYTES = 8 * 1024 * 1024
        const val MAX_PIXELS = 16_777_216L
        val PACKAGE_PATTERN = Regex("^[a-z0-9_]+(?:\\.[a-z0-9_]+)+$")
        val SHA256_PATTERN = Regex("^[a-f0-9]{64}$")
    }
}

data class ScreenCaptureMetadata(
    val captureId: String,
    val revision: Long,
    val packageName: String,
    val windowId: Int,
    val capturedAtElapsedMs: Long,
    val width: Int,
    val height: Int,
    val mimeType: String,
    val byteLength: Int,
    val sha256: String,
)

internal data class ScreenCaptureFailure(
    val status: ScreenCaptureStatus,
    val reasonCode: String,
    val explanation: String,
) {
    init {
        require(status != ScreenCaptureStatus.READY) {
            "A screen capture failure cannot use READY status."
        }
        require(REASON_PATTERN.matches(reasonCode)) {
            "Screen capture failure reason has an invalid shape."
        }
        require(explanation.length in 1..512 && explanation == explanation.trim()) {
            "Screen capture failure explanation has an invalid shape."
        }
    }

    companion object {
        val REASON_PATTERN = Regex("^[a-z][a-z0-9_]{0,63}$")
    }
}

internal sealed interface ScreenCaptureResult {
    data class Success(val artifact: ScreenCaptureArtifact) : ScreenCaptureResult
    data class Failure(val failure: ScreenCaptureFailure) : ScreenCaptureResult
}

internal fun secureSha256(bytes: ByteArray): String = MessageDigest
    .getInstance("SHA-256")
    .digest(bytes)
    .joinToString(separator = "") { byte -> "%02x".format(byte) }
