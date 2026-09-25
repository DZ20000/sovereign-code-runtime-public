package com.sovereign.runtime.android.gateway

import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AndroidToolApprovalPlanTest {
    @Test
    fun planCanAuthorizeItsOperationOnlyOnce() = runTest {
        val operationCount = AtomicInteger()
        val plan = AndroidToolApprovalPlan(
            requestId = "11111111-1111-4111-8111-111111111111",
        ) { operation -> operation() }

        val first = plan.authorize {
            operationCount.incrementAndGet()
            toolSuccess(buildJsonObject {
                put("ok", true)
                put("value", "first")
            })
        }
        val second = plan.authorize {
            operationCount.incrementAndGet()
            toolSuccess(buildJsonObject {
                put("ok", true)
                put("value", "second")
            })
        }

        assertFalse(first.isError == true)
        assertTrue(second.isError == true)
        assertEquals(1, operationCount.get())
        val error = (second.structuredContent as JsonObject)["error"] as JsonObject
        assertEquals("APPROVAL_REPLAY", (error["code"] as JsonPrimitive).content)
    }
}
