package com.sovereign.runtime.android.gateway

import com.sovereign.runtime.android.apps.AndroidAppLaunchResult
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class McpToolJsonTest {
    @Test
    fun parsesStrictRevisionRefTextAndNumericArguments() {
        val arguments = ToolArguments(
            arguments = buildJsonObject {
                put("revision", "ui_0123456789abcdef01234567_a")
                put("ref", "n1z")
                put("text", "")
                put("durationMs", 800)
                put("startX", 42.5)
            },
            allowedNames = setOf(
                "revision",
                "ref",
                "text",
                "durationMs",
                "startX",
            ),
        )
        assertEquals("ui_0123456789abcdef01234567_a", arguments.requiredRevision())
        assertEquals("n1z", arguments.requiredRef())
        assertEquals(
            "",
            arguments.requiredString(
                name = "text",
                maximumCharacters = 4_000,
                allowEmpty = true,
            ),
        )
        assertEquals(800L, arguments.requiredLong("durationMs", 500, 2_000))
        assertEquals(42.5f, arguments.requiredFloat("startX"))
    }

    @Test
    fun rejectsUnknownMissingWrongTypeAndMalformedReferenceArguments() {
        assertToolArgument("INVALID_ARGUMENT") {
            ToolArguments(
                arguments = buildJsonObject { put("unexpected", true) },
                allowedNames = emptySet(),
            )
        }
        assertToolArgument("MISSING_ARGUMENT") {
            ToolArguments(null, setOf("revision")).requiredRevision()
        }
        assertToolArgument("INVALID_ARGUMENT") {
            ToolArguments(
                buildJsonObject { put("revision", 42) },
                setOf("revision"),
            ).requiredRevision()
        }
        for (revision in listOf(
            "ui_short_1",
            "UI_0123456789abcdef01234567_a",
            "ui_0123456789abcdef01234567_A",
            "ui_0123456789abcdef01234567_a\n",
        )) {
            assertToolArgument("INVALID_ARGUMENT") {
                ToolArguments(
                    buildJsonObject { put("revision", revision) },
                    setOf("revision"),
                ).requiredRevision()
            }
        }
        for (ref in listOf("", "node1", "N1", "n1/escape", "n1\n")) {
            assertToolArgument("INVALID_ARGUMENT") {
                ToolArguments(
                    buildJsonObject { put("ref", ref) },
                    setOf("ref"),
                ).requiredRef()
            }
        }
    }

    @Test
    fun appLaunchArgumentsRequireOpaqueRevisionAndRefShapes() {
        val arguments = ToolArguments(
            arguments = buildJsonObject {
                put("revision", "apps_42_abcdefghijklmnop")
                put("ref", "a1z_abcdefghijklmnop")
            },
            allowedNames = setOf("revision", "ref"),
        )
        assertEquals("apps_42_abcdefghijklmnop", arguments.requiredAppRevision())
        assertEquals("a1z_abcdefghijklmnop", arguments.requiredAppRef())

        for (revision in listOf(
            "apps_0_abcdefghijklmnop",
            "apps_42_short",
            "Apps_42_abcdefghijklmnop",
            "apps_42_abcdefghijklmnop\n",
        )) {
            assertToolArgument("INVALID_ARGUMENT") {
                ToolArguments(
                    buildJsonObject { put("revision", revision) },
                    setOf("revision"),
                ).requiredAppRevision()
            }
        }
        for (ref in listOf(
            "a_abcdefghijklmnop",
            "a1000_abcdefghijklmnop",
            "A1_abcdefghijklmnop",
            "a1_short",
            "a1_abcdefghijklmnop\n",
        )) {
            assertToolArgument("INVALID_ARGUMENT") {
                ToolArguments(
                    buildJsonObject { put("ref", ref) },
                    setOf("ref"),
                ).requiredAppRef()
            }
        }
    }

    @Test
    fun integerAndFloatingPointArgumentsAreBoundedAndNotStringCoerced() {
        for (value in listOf(-1, 2_001)) {
            assertToolArgument("INVALID_ARGUMENT") {
                ToolArguments(
                    buildJsonObject { put("duration", value) },
                    setOf("duration"),
                ).requiredLong("duration", 0, 2_000)
            }
        }
        assertToolArgument("INVALID_ARGUMENT") {
            ToolArguments(
                buildJsonObject { put("duration", 1.5) },
                setOf("duration"),
            ).requiredLong("duration", 0, 2_000)
        }
        assertToolArgument("INVALID_ARGUMENT") {
            ToolArguments(
                buildJsonObject { put("duration", "800") },
                setOf("duration"),
            ).requiredLong("duration", 0, 2_000)
        }
        for (value in listOf(Double.NaN, Double.POSITIVE_INFINITY, 1_000_001.0)) {
            assertToolArgument("INVALID_ARGUMENT") {
                ToolArguments(
                    buildJsonObject { put("x", value) },
                    setOf("x"),
                ).requiredFloat("x")
            }
        }
    }

    @Test
    fun appLaunchSerializationRequiresForegroundConfirmation() {
        val json = AndroidAppLaunchResult(
            revision = "apps_42_abcdefghijklmnop",
            ref = "a1_abcdefghijklmnop",
            packageName = "com.example.app",
            dispatchedAtEpochMs = 9_000L,
        ).toJson()

        assertTrue((json["dispatchAccepted"] as JsonPrimitive).content.toBoolean())
        assertTrue((json["confirmationRequired"] as JsonPrimitive).content.toBoolean())
        assertEquals("9000", (json["dispatchedAtEpochMs"] as JsonPrimitive).content)
        assertFalse(json.containsKey("launchedAtEpochMs"))
    }

    @Test
    fun gatewayStateSerializationExposesListenerOwnership() {
        val json = McpGatewayState(
            phase = McpGatewayPhase.ERROR,
            listenerOwned = true,
            errorMessage = "shutdown not confirmed",
        ).toJson()
        assertTrue((json["listenerOwned"] as JsonPrimitive).content.toBoolean())
        assertEquals(
            "error",
            (json["phase"] as JsonPrimitive).content,
        )
    }

    @Test
    fun failureResultsFlattenAndBoundPublicMessages() {
        val result = toolFailure(
            code = "TEST_ERROR",
            message = "first\nsecond ${"x".repeat(1_000)}",
        )
        assertTrue(result.isError == true)
        val text = result.content.single().toString()
        assertFalse(text.contains("\n"))
        assertTrue(text.length < 700)
        val structured = result.structuredContent!!
        assertEquals(false, (structured["ok"] as JsonPrimitive).content.toBoolean())
    }

    private fun assertToolArgument(
        code: String,
        operation: () -> Unit,
    ) {
        val error = assertThrows(ToolArgumentException::class.java, operation)
        assertEquals(code, error.code)
    }
}
