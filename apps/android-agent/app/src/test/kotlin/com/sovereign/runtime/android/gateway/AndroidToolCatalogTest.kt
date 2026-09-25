package com.sovereign.runtime.android.gateway

import com.sovereign.runtime.android.runtime.AuthorityProfile
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AndroidToolCatalogTest {
    @Test
    fun catalogIsUniqueVersionedAndDeterministic() {
        val definitions = AndroidToolCatalog.definitions
        assertEquals(19, definitions.size)
        assertEquals(definitions.size, definitions.map { it.name }.toSet().size)
        assertEquals(64, AndroidToolCatalog.catalogRevision.length)
        assertEquals(
            AndroidToolCatalog.catalogRevision,
            (AndroidToolCatalog.manifest["catalogRevision"] as JsonPrimitive).content,
        )
        assertEquals(
            ANDROID_TOOL_MANIFEST_SCHEMA_VERSION,
            (AndroidToolCatalog.manifest["schemaVersion"] as JsonPrimitive).content,
        )
        assertEquals(
            definitions.size,
            (AndroidToolCatalog.manifest["tools"] as JsonArray).size,
        )
    }

    @Test
    fun currentCatalogContainsOnlyL1AndL2Facades() {
        val definitions = AndroidToolCatalog.definitions
        assertTrue(definitions.any { it.authority == AuthorityProfile.OBSERVE })
        assertTrue(definitions.any { it.authority == AuthorityProfile.INTERACTION })
        assertFalse(definitions.any { it.authority == AuthorityProfile.SYSTEM })
        assertFalse(definitions.any { definition ->
            definition.name.contains("root", ignoreCase = true) ||
                definition.name.contains("shell", ignoreCase = true) ||
                definition.name.contains("shizuku", ignoreCase = true) ||
                definition.name.contains("adb", ignoreCase = true)
        })
    }

    @Test
    fun observationAndInteractionToolsDeclareAuthorityApprovalAndAuditBehavior() {
        for (definition in AndroidToolCatalog.definitions) {
            when (definition.authority) {
                AuthorityProfile.OBSERVE -> {
                    assertTrue(definition.readOnly)
                    assertFalse(definition.destructive)
                    assertFalse(definition.openWorld)
                    assertEquals(AndroidApprovalMode.NONE, definition.approvalMode)
                    if (definition.name in setOf(
                            "android.ui.observe",
                            "android.screen.capture",
                            "android.app.list",
                            "android.app.current",
                            "android.surface.status",
                            "android.notification.status",
                            "android.notification.list",
                        )
                    ) {
                        assertEquals(AndroidAuditMode.INTENT_RESULT, definition.auditMode)
                    } else {
                        assertEquals(AndroidAuditMode.NONE, definition.auditMode)
                    }
                }
                AuthorityProfile.INTERACTION -> {
                    assertFalse(definition.readOnly)
                    if (definition.name == "android.app.launch"
                    ) {
                        assertFalse(definition.destructive)
                    } else {
                        assertTrue(definition.destructive)
                    }
                    assertTrue(definition.openWorld)
                    assertEquals(AndroidApprovalMode.SESSION, definition.approvalMode)
                    assertEquals(AndroidAuditMode.INTENT_RESULT, definition.auditMode)
                }
                AuthorityProfile.SYSTEM -> error("L3 tool unexpectedly entered M4 catalog")
            }
        }
    }

    @Test
    fun diagnosticsIncludeAuditStatusAndBoundedReceiptListing() {
        assertNotNull(AndroidToolCatalog.definition("android.system.audit_status"))
        val receipts = AndroidToolCatalog.definition("android.system.audit_receipts")
        assertNotNull(receipts.properties["limit"])
        assertTrue(receipts.requiredArguments.isEmpty())
        assertEquals(AndroidAuditMode.NONE, receipts.auditMode)
    }

    @Test
    fun screenCaptureIsMetadataOnlyAuditedAndReadOnly() {
        val capture = AndroidToolCatalog.definition("android.screen.capture")
        assertEquals(AuthorityProfile.OBSERVE, capture.authority)
        assertTrue(capture.readOnly)
        assertFalse(capture.destructive)
        assertFalse(capture.openWorld)
        assertEquals(AndroidApprovalMode.NONE, capture.approvalMode)
        assertEquals(AndroidAuditMode.INTENT_RESULT, capture.auditMode)
        assertTrue(capture.requiredArguments.isEmpty())
        assertTrue(capture.description.contains("metadata"))
        assertTrue(capture.description.contains("captureId"))
        assertTrue(capture.description.contains("unregistered android.screen.read"))
    }

    @Test
    fun surfaceStatusIsReadOnlyAuditedAndDoesNotClaimPrivilegeEscalation() {
        val status = AndroidToolCatalog.definition("android.surface.status")
        assertEquals(AuthorityProfile.OBSERVE, status.authority)
        assertTrue(status.readOnly)
        assertFalse(status.destructive)
        assertFalse(status.openWorld)
        assertEquals(AndroidApprovalMode.NONE, status.approvalMode)
        assertEquals(AndroidAuditMode.INTENT_RESULT, status.auditMode)
        assertTrue(status.requiredArguments.isEmpty())
        assertTrue(status.description.contains("Shizuku"))
        assertTrue(status.description.contains("Root"))
        assertTrue(status.description.contains("without granting"))
    }

    @Test
    fun appFacadesUseBoundedVisibilityAndRevisionBoundLaunch() {
        val list = AndroidToolCatalog.definition("android.app.list")
        val current = AndroidToolCatalog.definition("android.app.current")
        val launch = AndroidToolCatalog.definition("android.app.launch")

        assertEquals(AuthorityProfile.OBSERVE, list.authority)
        assertEquals(AndroidAuditMode.INTENT_RESULT, list.auditMode)
        assertTrue(list.requiredArguments.isEmpty())
        assertEquals(AuthorityProfile.OBSERVE, current.authority)
        assertTrue(current.requiredArguments.isEmpty())
        assertEquals(AuthorityProfile.INTERACTION, launch.authority)
        assertEquals(AndroidApprovalMode.SESSION, launch.approvalMode)
        assertFalse(launch.destructive)
        assertTrue("revision" in launch.requiredArguments)
        assertTrue("ref" in launch.requiredArguments)
        val revision = launch.properties["revision"] as JsonObject
        val ref = launch.properties["ref"] as JsonObject
        assertEquals(23, (revision["minLength"] as JsonPrimitive).content.toInt())
        assertEquals(38, (revision["maxLength"] as JsonPrimitive).content.toInt())
        assertEquals(19, (ref["minLength"] as JsonPrimitive).content.toInt())
        assertEquals(32, (ref["maxLength"] as JsonPrimitive).content.toInt())
    }

    @Test
    fun notificationFacadesAreBoundedRedactedAndReadOnly() {
        val status = AndroidToolCatalog.definition("android.notification.status")
        val list = AndroidToolCatalog.definition("android.notification.list")

        for (definition in listOf(status, list)) {
            assertEquals(AuthorityProfile.OBSERVE, definition.authority)
            assertTrue(definition.readOnly)
            assertFalse(definition.destructive)
            assertFalse(definition.openWorld)
            assertEquals(AndroidApprovalMode.NONE, definition.approvalMode)
            assertEquals(AndroidAuditMode.INTENT_RESULT, definition.auditMode)
            assertTrue(definition.requiredArguments.isEmpty())
        }
        assertTrue(status.description.contains("never grants"))
        assertTrue(list.description.contains("Raw notification keys"))
        assertTrue(list.description.contains("replies"))
        assertTrue(list.description.contains("actions"))
        val limit = list.properties["limit"] as JsonObject
        assertEquals(1, (limit["minimum"] as JsonPrimitive).content.toInt())
        assertEquals(128, (limit["maximum"] as JsonPrimitive).content.toInt())
        assertFalse(
            AndroidToolCatalog.definitions.any {
                definition -> definition.name == "android.notification.open"
            },
        )
    }

    @Test
    fun singleUseToolDefinitionsRequireImmutableIntentAndResultReceipts() {
        val error = runCatching {
            AndroidToolDefinition(
                name = "android.test.invalid_single_use",
                title = "Invalid single-use tool",
                description = "Synthetic invalid definition for invariant coverage.",
                authority = AuthorityProfile.INTERACTION,
                readOnly = false,
                destructive = true,
                openWorld = true,
                approvalMode = AndroidApprovalMode.SINGLE_USE,
                auditMode = AndroidAuditMode.NONE,
            )
        }.exceptionOrNull()
        assertTrue(error is IllegalArgumentException)
        assertTrue(error?.message.orEmpty().contains("immutable intent and result receipts"))
    }

    @Test
    fun schemasRequireRevisionBoundReferencesForElementActions() {
        for (name in listOf(
            "android.ui.click",
            "android.ui.long_press",
            "android.ui.set_text",
        )) {
            val definition = AndroidToolCatalog.definition(name)
            assertTrue("$name must require revision", "revision" in definition.requiredArguments)
            assertTrue("$name must require ref", "ref" in definition.requiredArguments)
            assertNotNull(definition.properties["revision"])
            assertNotNull(definition.properties["ref"])
        }
        for (name in listOf(
            "android.ui.swipe",
            "android.global.back",
            "android.global.home",
            "android.global.recents",
        )) {
            assertTrue(
                "$name must require revision",
                "revision" in AndroidToolCatalog.definition(name).requiredArguments,
            )
        }
    }
}
