package com.sovereign.runtime.android.gateway

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.Process
import android.os.SystemClock
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import com.sovereign.runtime.android.MainActivity
import com.sovereign.runtime.android.R
import com.sovereign.runtime.android.SovereignAndroidApplication
import com.sovereign.runtime.android.approval.AndroidApprovalBrokerState
import com.sovereign.runtime.android.approval.AndroidApprovalResolutionReason
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull

internal fun shouldTerminateGatewayProcess(
    listenerOwned: Boolean,
    approvalState: AndroidApprovalBrokerState,
): Boolean = listenerOwned || approvalState.active != null || approvalState.queuedCount > 0

class McpGatewayService : Service() {
    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var stateCollector: Job? = null
    private var visibilityWatchdog: Job? = null
    private var gatewayStartedByThisService = false
    private var lastApprovalNotificationRequestId: String? = null

    private val runtime
        get() = SovereignAndroidApplication.from(this).runtime

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    override fun onStartCommand(
        intent: Intent?,
        flags: Int,
        startId: Int,
    ): Int {
        when (resolveMcpGatewayServiceCommand(intent?.action)) {
            McpGatewayServiceCommand.START -> startGateway()
            McpGatewayServiceCommand.STOP -> requestGatewayStop()
            McpGatewayServiceCommand.REJECT -> {
                runtime.reportError(
                    IllegalStateException(
                        "The local MCP foreground service requires an explicit user Start or Stop action.",
                    ),
                )
                stopSelf(startId)
            }
        }
        return START_NOT_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        stateCollector?.cancel()
        stateCollector = null
        visibilityWatchdog?.cancel()
        visibilityWatchdog = null
        var listenerStillOwned = runtime.gateway.state.value.listenerOwned
        // Security boundary: neither an approval lease nor a loopback listener may
        // outlive the visible foreground service. Approval cancellation happens
        // first so waiting tool calls fail closed before their transports close.
        runBlocking(Dispatchers.IO) {
            withTimeoutOrNull(SERVICE_DESTROY_STOP_TIMEOUT_MS) {
                runtime.approvalBroker.cancelAll(
                    AndroidApprovalResolutionReason.GATEWAY_STOP,
                )
                if (gatewayStartedByThisService || listenerStillOwned) {
                    runCatching { runtime.gateway.stop() }
                }
                runtime.approvalBroker.cancelAll(
                    AndroidApprovalResolutionReason.GATEWAY_STOP,
                )
            }
        }
        listenerStillOwned = runtime.gateway.state.value.listenerOwned
        val approvalState = runtime.approvalBroker.state.value
        gatewayStartedByThisService = false
        getSystemService(NotificationManager::class.java).cancel(APPROVAL_NOTIFICATION_ID)
        lastApprovalNotificationRequestId = null
        serviceScope.cancel()
        super.onDestroy()
        if (shouldTerminateGatewayProcess(listenerStillOwned, approvalState)) {
            Process.killProcess(Process.myPid())
        }
    }

    private fun startGateway() {
        if (gatewayStartedByThisService) return
        if (!notificationsAreAvailable(this)) {
            runtime.reportError(
                IllegalStateException(
                    "Notification permission and visible notifications are required before starting the local MCP gateway.",
                ),
            )
            stopSelf()
            return
        }
        try {
            promoteToForeground(
                buildNotification(
                    title = getString(R.string.gateway_notification_starting_title),
                    detail = getString(R.string.gateway_notification_starting_detail),
                ),
            )
        } catch (error: Throwable) {
            runtime.reportError(error)
            ServiceCompat.stopForeground(
                this,
                ServiceCompat.STOP_FOREGROUND_REMOVE,
            )
            stopSelf()
            return
        }
        gatewayStartedByThisService = true
        stateCollector = serviceScope.launch {
            combine(
                runtime.gateway.state,
                runtime.approvalBroker.state,
            ) { gatewayState, approvalState ->
                gatewayState to approvalState
            }.collectLatest { (gatewayState, approvalState) ->
                if (
                    gatewayState.listenerOwned ||
                    gatewayState.phase in setOf(
                        McpGatewayPhase.STARTING,
                        McpGatewayPhase.RUNNING,
                    )
                ) {
                    updateNotification(gatewayState, approvalState)
                    updateApprovalNotification(approvalState)
                }
            }
        }
        visibilityWatchdog = serviceScope.launch {
            while (isActive && gatewayStartedByThisService) {
                delay(NOTIFICATION_VISIBILITY_CHECK_MS)
                if (!notificationsAreAvailable(this@McpGatewayService)) {
                    runtime.reportError(
                        IllegalStateException(
                            "The local MCP gateway stopped because its foreground notification is no longer visible.",
                        ),
                    )
                    stopGatewayAndService(
                        terminateProcessIfListenerRemains = true,
                    )
                    break
                }
            }
        }
        serviceScope.launch {
            runCatching { runtime.gateway.start() }
                .onFailure { error ->
                    runtime.reportError(error)
                    stopGatewayAndService()
                }
        }
    }

    private fun requestGatewayStop() {
        serviceScope.launch {
            stopGatewayAndService()
        }
    }

    private suspend fun stopGatewayAndService(
        terminateProcessIfListenerRemains: Boolean = false,
    ) {
        runtime.approvalBroker.cancelAll(
            AndroidApprovalResolutionReason.GATEWAY_STOP,
        )
        getSystemService(NotificationManager::class.java).cancel(APPROVAL_NOTIFICATION_ID)
        lastApprovalNotificationRequestId = null
        runCatching { runtime.gateway.stop() }
            .onFailure(runtime::reportError)
        // Close the race where a request entered after the first cancellation
        // but before the listener finished retiring.
        runtime.approvalBroker.cancelAll(
            AndroidApprovalResolutionReason.GATEWAY_STOP,
        )
        val state = runtime.gateway.state.value
        if (state.listenerOwned) {
            runtime.reportError(
                IllegalStateException(
                    "The local MCP listener could not be confirmed stopped. " +
                        if (terminateProcessIfListenerRemains) {
                            "Sovereign will terminate this app process to close it fail-closed."
                        } else {
                            "The visible foreground service remains active; retry Stop."
                        },
                ),
            )
            if (terminateProcessIfListenerRemains) {
                ServiceCompat.stopForeground(
                    this,
                    ServiceCompat.STOP_FOREGROUND_REMOVE,
                )
                Process.killProcess(Process.myPid())
            } else {
                gatewayStartedByThisService = true
                updateNotification(
                    state = runtime.gateway.state.value,
                    approvalState = runtime.approvalBroker.state.value,
                )
            }
            return
        }
        gatewayStartedByThisService = false
        stateCollector?.cancel()
        stateCollector = null
        visibilityWatchdog?.cancel()
        visibilityWatchdog = null
        ServiceCompat.stopForeground(
            this,
            ServiceCompat.STOP_FOREGROUND_REMOVE,
        )
        stopSelf()
    }

    private fun promoteToForeground(notification: Notification) {
        val foregroundServiceType = if (Build.VERSION.SDK_INT >= 34) {
            ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
        } else {
            0
        }
        ServiceCompat.startForeground(
            this,
            NOTIFICATION_ID,
            notification,
            foregroundServiceType,
        )
    }

    private fun updateNotification(
        state: McpGatewayState,
        approvalState: AndroidApprovalBrokerState,
    ) {
        if (!notificationsAreAvailable(this)) return
        val approval = approvalState.active
        val title = when {
            approval != null -> getString(R.string.gateway_notification_approval_title)
            state.phase == McpGatewayPhase.RUNNING ->
                getString(R.string.gateway_notification_running_title)
            state.phase == McpGatewayPhase.ERROR && state.listenerOwned ->
                getString(R.string.gateway_notification_error_title)
            else -> getString(R.string.gateway_notification_starting_title)
        }
        val detail = when {
            approval != null -> approvalNotificationDetail(
                title = approval.title,
                expiresAtElapsedMs = approval.expiresAtElapsedMs,
            )
            state.phase == McpGatewayPhase.RUNNING -> resources.getQuantityString(
                R.plurals.gateway_notification_running_detail,
                state.activeSessions,
                state.port ?: 0,
                state.activeSessions,
                state.tokenFingerprint ?: "unknown",
            )
            state.phase == McpGatewayPhase.ERROR && state.listenerOwned ->
                state.errorMessage
                    ?: getString(R.string.gateway_notification_error_detail)
            else -> getString(R.string.gateway_notification_starting_detail)
        }
        getSystemService(NotificationManager::class.java).notify(
            NOTIFICATION_ID,
            buildNotification(title = title, detail = detail),
        )
    }

    private fun approvalRemainingSeconds(expiresAtElapsedMs: Long): Long {
        val remainingMs = expiresAtElapsedMs - SystemClock.elapsedRealtime()
        return if (remainingMs <= 0L) 0L else (remainingMs + 999L) / 1_000L
    }

    private fun approvalNotificationDetail(
        title: String,
        expiresAtElapsedMs: Long,
    ): String {
        val remainingSeconds = approvalRemainingSeconds(expiresAtElapsedMs)
            .coerceIn(0L, Int.MAX_VALUE.toLong())
            .toInt()
        return resources.getQuantityString(
            R.plurals.gateway_notification_approval_detail,
            remainingSeconds,
            title,
            remainingSeconds,
        )
    }

    private fun updateApprovalNotification(state: AndroidApprovalBrokerState) {
        val manager = getSystemService(NotificationManager::class.java)
        val approval = state.active
        if (approval == null) {
            manager.cancel(APPROVAL_NOTIFICATION_ID)
            lastApprovalNotificationRequestId = null
            return
        }
        if (lastApprovalNotificationRequestId != approval.requestId) {
            manager.cancel(APPROVAL_NOTIFICATION_ID)
            lastApprovalNotificationRequestId = approval.requestId
        }
        if (!notificationsAreAvailable(this)) return
        val remainingMs = (approval.expiresAtElapsedMs - SystemClock.elapsedRealtime())
            .coerceAtLeast(1_000L)
        val detail = approvalNotificationDetail(
            title = approval.title,
            expiresAtElapsedMs = approval.expiresAtElapsedMs,
        )
        val notification = NotificationCompat.Builder(
            this,
            APPROVAL_NOTIFICATION_CHANNEL_ID,
        )
            .setSmallIcon(R.drawable.ic_sovereign_runtime)
            .setContentTitle(getString(R.string.gateway_notification_approval_title))
            .setContentText(detail)
            .setStyle(NotificationCompat.BigTextStyle().bigText(detail))
            .setContentIntent(mainActivityPendingIntent(REQUEST_APPROVAL_OPEN))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setTimeoutAfter(remainingMs)
            .build()
        manager.notify(APPROVAL_NOTIFICATION_ID, notification)
    }

    private fun mainActivityPendingIntent(requestCode: Int): PendingIntent {
        val openIntent = Intent(this, MainActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        }
        return PendingIntent.getActivity(
            this,
            requestCode,
            openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    private fun buildNotification(
        title: String,
        detail: String,
    ): Notification {
        val openPendingIntent = mainActivityPendingIntent(REQUEST_OPEN)
        val stopIntent = Intent(this, McpGatewayService::class.java).apply {
            action = MCP_GATEWAY_SERVICE_ACTION_STOP
        }
        val stopPendingIntent = PendingIntent.getService(
            this,
            REQUEST_STOP,
            stopIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(this, NOTIFICATION_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_sovereign_runtime)
            .setContentTitle(title)
            .setContentText(detail)
            .setStyle(NotificationCompat.BigTextStyle().bigText(detail))
            .setContentIntent(openPendingIntent)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .addAction(
                R.drawable.ic_sovereign_runtime,
                getString(R.string.gateway_notification_stop_action),
                stopPendingIntent,
            )
            .build()
    }

    private fun createNotificationChannel() {
        val gatewayChannel = NotificationChannel(
            NOTIFICATION_CHANNEL_ID,
            getString(R.string.gateway_notification_channel_name),
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = getString(R.string.gateway_notification_channel_description)
            setShowBadge(false)
            lockscreenVisibility = Notification.VISIBILITY_PRIVATE
        }
        val approvalChannel = NotificationChannel(
            APPROVAL_NOTIFICATION_CHANNEL_ID,
            getString(R.string.approval_notification_channel_name),
            NotificationManager.IMPORTANCE_HIGH,
        ).apply {
            description = getString(R.string.approval_notification_channel_description)
            setShowBadge(false)
            lockscreenVisibility = Notification.VISIBILITY_PRIVATE
        }
        getSystemService(NotificationManager::class.java).createNotificationChannels(
            listOf(gatewayChannel, approvalChannel),
        )
    }

    companion object {
        private const val NOTIFICATION_CHANNEL_ID = "sovereign_local_mcp_v1"
        private const val APPROVAL_NOTIFICATION_CHANNEL_ID = "sovereign_local_approval_v1"
        private const val NOTIFICATION_ID = 4_101
        private const val APPROVAL_NOTIFICATION_ID = 4_102
        private const val REQUEST_OPEN = 4_103
        private const val REQUEST_STOP = 4_104
        private const val REQUEST_APPROVAL_OPEN = 4_105
        private const val NOTIFICATION_VISIBILITY_CHECK_MS = 5_000L
        private const val SERVICE_DESTROY_STOP_TIMEOUT_MS = 3_000L

        fun notificationsAreAvailable(context: Context): Boolean {
            val permissionGranted = Build.VERSION.SDK_INT < 33 ||
                ContextCompat.checkSelfPermission(
                    context,
                    Manifest.permission.POST_NOTIFICATIONS,
                ) == PackageManager.PERMISSION_GRANTED
            val notificationManager = context.getSystemService(NotificationManager::class.java)
            val channelVisible = notificationManager
                .getNotificationChannel(NOTIFICATION_CHANNEL_ID)
                ?.importance
                ?.let { importance -> importance != NotificationManager.IMPORTANCE_NONE }
                ?: true
            return permissionGranted &&
                notificationManager.areNotificationsEnabled() &&
                channelVisible
        }

        fun requestStart(context: Context) {
            ContextCompat.startForegroundService(
                context,
                Intent(context, McpGatewayService::class.java).apply {
                    action = MCP_GATEWAY_SERVICE_ACTION_START
                },
            )
        }

        fun requestStop(context: Context) {
            context.startService(
                Intent(context, McpGatewayService::class.java).apply {
                    action = MCP_GATEWAY_SERVICE_ACTION_STOP
                },
            )
        }
    }
}
