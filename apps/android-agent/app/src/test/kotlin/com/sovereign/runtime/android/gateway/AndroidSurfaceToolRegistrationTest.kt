package com.sovereign.runtime.android.gateway

import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Structural guard until screen.read gains a real MCP ImageContent loopback test.
 * Runtime behavior is covered separately by the facade and notification tests.
 */
class AndroidSurfaceToolRegistrationTest {
    @Test
    fun screenAndNotificationToolsUseTheirSinglePolicyBoundDispatchPaths() {
        val sourceRoot = locateSourceRoot()
        val catalog = sourceText(
            sourceRoot,
            "main/kotlin/com/sovereign/runtime/android/gateway/AndroidToolCatalog.kt",
        )
        val server = sourceText(
            sourceRoot,
            "main/kotlin/com/sovereign/runtime/android/gateway/AndroidMcpToolServer.kt",
        )

        assertEquals(
            1,
            literalToolCount(catalog, AndroidSurfaceToolContract.SCREEN_CAPTURE),
        )
        assertEquals(
            1,
            literalToolCount(server, AndroidSurfaceToolContract.SCREEN_CAPTURE),
        )
        assertTrue(server.contains("screenCaptureMcpResult(runtime.captureScreen())"))
        assertFalse(server.contains("toolSuccess(AndroidSurfaceMcpFacade.captureScreenJson"))

        for (toolName in listOf(
            "android.notification.status",
            "android.notification.list",
        )) {
            assertEquals(1, literalToolCount(catalog, toolName))
            assertEquals(1, literalToolCount(server, toolName))
        }
        assertTrue(server.contains("notificationStatusToJson(runtime.notificationStatus())"))
        assertTrue(server.contains("notificationListToJson(runtime.listNotifications(limit))"))
        assertFalse(server.contains("runtime.openNotification("))
        assertFalse(server.contains("AndroidSurfaceMcpFacade.listNotificationsJson()"))

        assertFalse(catalog.contains("\"${AndroidSurfaceToolContract.SCREEN_READ}\""))
        assertFalse(server.contains("\"${AndroidSurfaceToolContract.SCREEN_READ}\""))
    }

    private fun literalToolCount(source: String, toolName: String): Int =
        Regex("\\\"${Regex.escape(toolName)}\\\"").findAll(source).count()

    private fun sourceText(sourceRoot: Path, relativePath: String): String = String(
        Files.readAllBytes(sourceRoot.resolve(relativePath)),
        StandardCharsets.UTF_8,
    )

    private fun locateSourceRoot(): Path {
        var current = Path.of(System.getProperty("user.dir")).toAbsolutePath().normalize()
        repeat(8) {
            val direct = current.resolve("src")
            if (Files.exists(direct.resolve(
                    "main/kotlin/com/sovereign/runtime/android/gateway/AndroidToolCatalog.kt",
                ))) {
                return direct
            }
            val module = current.resolve("app/src")
            if (Files.exists(module.resolve(
                    "main/kotlin/com/sovereign/runtime/android/gateway/AndroidToolCatalog.kt",
                ))) {
                return module
            }
            current = current.parent ?: return@repeat
        }
        error("Could not locate Android app source root for registration guard.")
    }
}

