package com.sovereign.runtime.android.notification

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonObjectBuilder
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

internal const val NOTIFICATION_STATUS_SCHEMA_VERSION = "sar.notification-status/v1"
internal const val NOTIFICATION_LIST_SCHEMA_VERSION = "sar.notification-list/v1"

internal interface AndroidNotificationRuntimeView {
    fun listenerConnected(): Boolean
    fun policyRevision(): Long
    fun snapshot(): NotificationSnapshot?
    fun lastErrorCode(): String?
}

internal data class NotificationReadStatus(
    val listenerConnected: Boolean,
    val policyRevision: Long,
    val snapshotRevision: Long?,
    val recordCount: Int,
    val lastErrorCode: String?,
)

internal data class NotificationReadList(
    val available: Boolean,
    val policyRevision: Long,
    val snapshotRevision: Long?,
    val observedAtElapsedMs: Long?,
    val records: List<NotificationRecord>,
    val lastErrorCode: String?,
)

internal class NotificationReadFacade(
    private val source: AndroidNotificationRuntimeView,
) {
    fun status(): NotificationReadStatus {
        val snapshot = source.snapshot()
        return NotificationReadStatus(
            listenerConnected = source.listenerConnected(),
            policyRevision = source.policyRevision(),
            snapshotRevision = snapshot?.revision,
            recordCount = snapshot?.records?.size ?: 0,
            lastErrorCode = source.lastErrorCode()?.take(MAXIMUM_ERROR_CODE_CHARACTERS),
        )
    }

    fun list(limit: Int = MAXIMUM_PUBLIC_RECORDS): NotificationReadList {
        require(limit in 1..MAXIMUM_PUBLIC_RECORDS) {
            "Notification list limit must be from 1 through $MAXIMUM_PUBLIC_RECORDS."
        }
        val connected = source.listenerConnected()
        val snapshot = source.snapshot()
        val available = connected && snapshot != null
        return NotificationReadList(
            available = available,
            policyRevision = source.policyRevision(),
            snapshotRevision = snapshot?.revision,
            observedAtElapsedMs = snapshot?.observedAtElapsedMs,
            records = if (connected && snapshot != null) {
                snapshot.records.take(limit)
            } else {
                emptyList()
            },
            lastErrorCode = source.lastErrorCode()?.take(MAXIMUM_ERROR_CODE_CHARACTERS),
        )
    }

    private companion object {
        const val MAXIMUM_PUBLIC_RECORDS = 128
        const val MAXIMUM_ERROR_CODE_CHARACTERS = 128
    }
}

internal fun notificationStatusToJson(status: NotificationReadStatus): JsonObject = buildJsonObject {
    put("schemaVersion", NOTIFICATION_STATUS_SCHEMA_VERSION)
    put("listenerConnected", status.listenerConnected)
    put("policyRevision", status.policyRevision)
    putNullableLong("snapshotRevision", status.snapshotRevision)
    put("recordCount", status.recordCount)
    putNullableString("lastErrorCode", status.lastErrorCode)
}

internal fun notificationListToJson(result: NotificationReadList): JsonObject = buildJsonObject {
    put("schemaVersion", NOTIFICATION_LIST_SCHEMA_VERSION)
    put("available", result.available)
    put("policyRevision", result.policyRevision)
    putNullableLong("snapshotRevision", result.snapshotRevision)
    putNullableLong("observedAtElapsedMs", result.observedAtElapsedMs)
    put("count", result.records.size)
    put("notifications", JsonArray(result.records.map(::notificationRecordToJson)))
    putNullableString("lastErrorCode", result.lastErrorCode)
}

private fun notificationRecordToJson(record: NotificationRecord): JsonObject = buildJsonObject {
    put("ref", record.ref)
    put("packageName", record.packageName)
    put("postedAtEpochMs", record.postedAtEpochMs)
    putNullableString("title", record.title)
    putNullableString("text", record.text)
    putNullableString("subText", record.subText)
    putNullableString("category", record.category)
    put("ongoing", record.ongoing)
    put("clearable", record.clearable)
    put("hasContentIntent", record.hasContentIntent)
    put("actionCount", record.actionCount)
    put("redacted", record.redacted)
    putNullableString("redactionReason", record.redactionReason)
}

private fun JsonObjectBuilder.putNullableString(name: String, value: String?) {
    put(name, value?.let(::JsonPrimitive) ?: JsonNull)
}

private fun JsonObjectBuilder.putNullableLong(name: String, value: Long?) {
    put(name, value?.let(::JsonPrimitive) ?: JsonNull)
}
