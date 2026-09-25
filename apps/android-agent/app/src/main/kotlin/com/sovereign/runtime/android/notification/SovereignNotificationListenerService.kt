package com.sovereign.runtime.android.notification

import android.app.Notification
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification

class SovereignNotificationListenerService : NotificationListenerService() {
    override fun onListenerConnected() {
        super.onListenerConnected()
        AndroidNotificationRuntime.connected()
        refreshSnapshot()
    }

    override fun onListenerDisconnected() {
        AndroidNotificationRuntime.disconnected("NOTIFICATION_LISTENER_DISCONNECTED")
        super.onListenerDisconnected()
    }

    override fun onNotificationPosted(sbn: StatusBarNotification?) {
        super.onNotificationPosted(sbn)
        if (sbn != null) {
            refreshSnapshot()
        }
    }

    override fun onNotificationRemoved(sbn: StatusBarNotification?) {
        super.onNotificationRemoved(sbn)
        if (sbn != null) {
            refreshSnapshot()
        }
    }

    override fun onDestroy() {
        AndroidNotificationRuntime.disconnected("NOTIFICATION_LISTENER_STOPPED")
        super.onDestroy()
    }

    private fun refreshSnapshot() {
        try {
            val policy = AndroidNotificationRuntime.policyRegistry.current()
            val drafts = activeNotifications
                .orEmpty()
                .asSequence()
                .filter { notification -> notification.packageName != packageName }
                .map { status -> toDraft(status, policy) }
                .toList()
            AndroidNotificationRuntime.registry.publish(
                drafts = drafts,
                policyRevision = policy.revision,
            )
            AndroidNotificationRuntime.connected()
        } catch (error: Exception) {
            AndroidNotificationRuntime.failed(error)
        }
    }

    private fun toDraft(
        status: StatusBarNotification,
        policy: NotificationContentPolicySnapshot,
    ): NotificationDraft {
        val notification = status.notification
        val extras = notification.extras
        val category = notification.category
        val packageName = status.packageName.lowercase()
        return NotificationDraft(
            sourceKey = status.key,
            packageName = packageName,
            postedAtEpochMs = status.postTime.coerceAtLeast(0L),
            title = extras.getCharSequence(Notification.EXTRA_TITLE),
            text = extras.getCharSequence(Notification.EXTRA_BIG_TEXT)
                ?: extras.getCharSequence(Notification.EXTRA_TEXT),
            subText = extras.getCharSequence(Notification.EXTRA_SUB_TEXT),
            category = category,
            ongoing = status.isOngoing,
            clearable = status.isClearable,
            hasContentIntent = notification.contentIntent != null,
            actionCount = notification.actions?.size?.coerceAtMost(MAXIMUM_ACTIONS) ?: 0,
            sensitivity = AndroidNotificationRuntime.policyRegistry.classify(
                snapshot = policy,
                packageName = packageName,
                category = category,
            ),
        )
    }

    private companion object {
        const val MAXIMUM_ACTIONS = 64
    }
}
