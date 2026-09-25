package com.sovereign.runtime.android.screen

import org.junit.Assert.assertEquals
import org.junit.Test

internal class ScreenProjectionServiceCommandTest {
    @Test
    fun onlyExactExplicitStartAndStopActionsAreAccepted() {
        assertEquals(
            ScreenProjectionServiceCommand.START,
            resolveScreenProjectionServiceCommand(SCREEN_PROJECTION_ACTION_START),
        )
        assertEquals(
            ScreenProjectionServiceCommand.STOP,
            resolveScreenProjectionServiceCommand(SCREEN_PROJECTION_ACTION_STOP),
        )
        for (action in listOf(
            null,
            "",
            "unexpected",
            "$SCREEN_PROJECTION_ACTION_START.extra",
            SCREEN_PROJECTION_ACTION_START.lowercase(),
        )) {
            assertEquals(
                ScreenProjectionServiceCommand.REJECT,
                resolveScreenProjectionServiceCommand(action),
            )
        }
    }

    @Test
    fun acceptsOnlyCompleteGrantedStartMetadata() {
        val requestId = java.util.UUID.randomUUID().toString()
        val sessionId = java.util.UUID.randomUUID().toString()
        val accepted = validateScreenProjectionStartMetadata(
            metadata = ScreenProjectionStartMetadata(
                resultCode = -1,
                generation = 1,
                requestId = requestId,
                projectionSessionId = sessionId,
                hasResultData = true,
            ),
            successfulResultCode = -1,
        )
        assertEquals(
            ScreenProjectionStartValidation.Accepted(
                generation = 1,
                requestId = requestId,
                projectionSessionId = sessionId,
            ),
            accepted,
        )
    }

    @Test
    fun rejectsEachMalformedStartMetadataField() {
        val requestId = java.util.UUID.randomUUID().toString()
        val sessionId = java.util.UUID.randomUUID().toString()
        val base = ScreenProjectionStartMetadata(
            resultCode = -1,
            generation = 1,
            requestId = requestId,
            projectionSessionId = sessionId,
            hasResultData = true,
        )
        val cases = listOf(
            base.copy(resultCode = 0) to "projection_result_not_granted",
            base.copy(generation = 0) to "projection_generation_invalid",
            base.copy(hasResultData = false) to "projection_result_data_missing",
            base.copy(requestId = null) to "projection_request_id_invalid",
            base.copy(requestId = "not-a-uuid") to "projection_request_id_invalid",
            base.copy(projectionSessionId = null) to "projection_session_id_invalid",
            base.copy(projectionSessionId = "not-a-uuid") to "projection_session_id_invalid",
        )
        for ((metadata, reason) in cases) {
            assertEquals(
                ScreenProjectionStartValidation.Rejected(reason),
                validateScreenProjectionStartMetadata(metadata, successfulResultCode = -1),
            )
        }
    }
}
