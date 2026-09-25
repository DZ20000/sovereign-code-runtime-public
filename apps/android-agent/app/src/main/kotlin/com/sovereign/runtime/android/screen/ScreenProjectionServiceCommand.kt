package com.sovereign.runtime.android.screen

import java.util.UUID

internal const val SCREEN_PROJECTION_ACTION_START =
    "com.sovereign.runtime.android.action.START_SCREEN_PROJECTION"
internal const val SCREEN_PROJECTION_ACTION_STOP =
    "com.sovereign.runtime.android.action.STOP_SCREEN_PROJECTION"

internal const val SCREEN_PROJECTION_EXTRA_RESULT_CODE =
    "com.sovereign.runtime.android.extra.PROJECTION_RESULT_CODE"
internal const val SCREEN_PROJECTION_EXTRA_RESULT_DATA =
    "com.sovereign.runtime.android.extra.PROJECTION_RESULT_DATA"
internal const val SCREEN_PROJECTION_EXTRA_GENERATION =
    "com.sovereign.runtime.android.extra.PROJECTION_GENERATION"
internal const val SCREEN_PROJECTION_EXTRA_REQUEST_ID =
    "com.sovereign.runtime.android.extra.PROJECTION_REQUEST_ID"
internal const val SCREEN_PROJECTION_EXTRA_SESSION_ID =
    "com.sovereign.runtime.android.extra.PROJECTION_SESSION_ID"

internal enum class ScreenProjectionServiceCommand {
    START,
    STOP,
    REJECT,
}

internal data class ScreenProjectionStartMetadata(
    val resultCode: Int,
    val generation: Long,
    val requestId: String?,
    val projectionSessionId: String?,
    val hasResultData: Boolean,
)

internal sealed interface ScreenProjectionStartValidation {
    data class Accepted(
        val generation: Long,
        val requestId: String,
        val projectionSessionId: String,
    ) : ScreenProjectionStartValidation

    data class Rejected(
        val reasonCode: String,
    ) : ScreenProjectionStartValidation
}

internal fun resolveScreenProjectionServiceCommand(action: String?): ScreenProjectionServiceCommand =
    when (action) {
        SCREEN_PROJECTION_ACTION_START -> ScreenProjectionServiceCommand.START
        SCREEN_PROJECTION_ACTION_STOP -> ScreenProjectionServiceCommand.STOP
        else -> ScreenProjectionServiceCommand.REJECT
    }

internal fun validateScreenProjectionStartMetadata(
    metadata: ScreenProjectionStartMetadata,
    successfulResultCode: Int,
): ScreenProjectionStartValidation {
    if (metadata.resultCode != successfulResultCode) {
        return ScreenProjectionStartValidation.Rejected("projection_result_not_granted")
    }
    if (metadata.generation < 1) {
        return ScreenProjectionStartValidation.Rejected("projection_generation_invalid")
    }
    if (!metadata.hasResultData) {
        return ScreenProjectionStartValidation.Rejected("projection_result_data_missing")
    }
    val requestId = metadata.requestId
    if (requestId == null || runCatching { UUID.fromString(requestId) }.isFailure) {
        return ScreenProjectionStartValidation.Rejected("projection_request_id_invalid")
    }
    val projectionSessionId = metadata.projectionSessionId
    if (
        projectionSessionId == null ||
        runCatching { UUID.fromString(projectionSessionId) }.isFailure
    ) {
        return ScreenProjectionStartValidation.Rejected("projection_session_id_invalid")
    }
    return ScreenProjectionStartValidation.Accepted(
        generation = metadata.generation,
        requestId = requestId,
        projectionSessionId = projectionSessionId,
    )
}
