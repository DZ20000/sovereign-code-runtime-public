package com.sovereign.runtime.android.screen

import android.app.Activity
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat

class ScreenProjectionForegroundService : Service() {
    private val mainHandler = Handler(Looper.getMainLooper())
    private var projection: MediaProjection? = null
    private var projectionCallback: MediaProjection.Callback? = null
    private var frameProducer: MediaProjectionFrameProducer? = null
    private var projectionGeneration: Long? = null
    private var projectionSessionId: String? = null
    private var expiryRunnable: Runnable? = null

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (resolveScreenProjectionServiceCommand(intent?.action)) {
            ScreenProjectionServiceCommand.START -> {
                val startIntent = intent
                if (startIntent == null) {
                    rejectInvalidCommand(startId)
                } else {
                    startProjection(startIntent, startId)
                }
            }
            ScreenProjectionServiceCommand.STOP -> {
                stopProjection("operator_stop", incrementGeneration = true)
                stopSelf(startId)
            }
            ScreenProjectionServiceCommand.REJECT -> rejectInvalidCommand(startId)
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        stopProjection("service_destroyed", incrementGeneration = true)
        super.onDestroy()
    }

    private fun rejectInvalidCommand(startId: Int) {
        val state = ScreenProjectionRuntime.state()
        if (state.lifecycle == ProjectionLifecycle.CONSENT_PENDING) {
            ScreenProjectionRuntime.fail(
                generation = state.generation,
                redactedReason = "Screen projection service received an invalid command.",
            )
        }
        stopSelf(startId)
    }

    private fun startProjection(intent: Intent, startId: Int) {
        val request = parseStartRequest(intent)
        if (request == null) {
            val state = ScreenProjectionRuntime.state()
            if (state.lifecycle == ProjectionLifecycle.CONSENT_PENDING) {
                ScreenProjectionRuntime.fail(
                    generation = state.generation,
                    redactedReason = "Screen projection service start data was invalid.",
                )
            }
            stopSelf(startId)
            return
        }
        val state = ScreenProjectionRuntime.state()
        if (
            state.lifecycle != ProjectionLifecycle.CONSENT_PENDING ||
            state.generation != request.generation ||
            state.consentRequestId != request.requestId ||
            state.deadlineAtElapsedMs == null
        ) {
            stopSelf(startId)
            return
        }

        startProjectionForeground(request.projectionSessionId)
        try {
            val manager = getSystemService(MediaProjectionManager::class.java)
                ?: throw IllegalStateException("MediaProjectionManager is unavailable.")
            val candidate = manager.getMediaProjection(
                request.resultCode,
                request.resultData,
            ) ?: throw IllegalStateException("Android returned no MediaProjection instance.")

            projectionGeneration = request.generation
            projectionSessionId = request.projectionSessionId
            val callback = object : MediaProjection.Callback() {
                override fun onStop() {
                    handleProjectionStopped(
                        generation = request.generation,
                        sessionId = request.projectionSessionId,
                    )
                }

                override fun onCapturedContentResize(width: Int, height: Int) {
                    if (
                        projectionGeneration == request.generation &&
                        projectionSessionId == request.projectionSessionId
                    ) {
                        frameProducer?.updateCapturedContentSize(width, height)
                    }
                }

                override fun onCapturedContentVisibilityChanged(isVisible: Boolean) {
                    if (
                        projectionGeneration == request.generation &&
                        projectionSessionId == request.projectionSessionId
                    ) {
                        frameProducer?.updateCapturedContentVisibility(isVisible)
                    }
                }
            }
            projectionCallback = callback
            candidate.registerCallback(callback, mainHandler)
            projection = candidate
            val frameProducer = MediaProjectionFrameProducer.create(
                context = this,
                projection = candidate,
                generation = request.generation,
                projectionSessionId = request.projectionSessionId,
            )
            this.frameProducer = frameProducer

            val transition = ScreenProjectionRuntime.consentGranted(
                generation = request.generation,
                requestId = request.requestId,
                projectionSessionId = request.projectionSessionId,
                frameSource = frameProducer,
            )
            if (transition.effect !is ProjectionEffect.ActivateProjection) {
                this.frameProducer = null
                stopProjection("consent_state_mismatch", incrementGeneration = false)
                stopSelf(startId)
                return
            }
            scheduleSessionExpiry()
        } catch (_: OutOfMemoryError) {
            ScreenProjectionRuntime.fail(
                generation = request.generation,
                redactedReason = "Screen projection activation exceeded its memory limit.",
            )
            stopProjection("activation_failed", incrementGeneration = false)
            stopSelf(startId)
        } catch (error: Exception) {
            ScreenProjectionRuntime.fail(
                generation = request.generation,
                redactedReason = "Screen projection activation failed: ${error::class.java.simpleName}",
            )
            stopProjection("activation_failed", incrementGeneration = false)
            stopSelf(startId)
        }
    }

    private fun handleProjectionStopped(generation: Long, sessionId: String) {
        if (
            projectionGeneration != generation ||
            projectionSessionId != sessionId
        ) {
            return
        }
        cancelSessionExpiry()
        val activeFrameProducer = frameProducer
        projection?.let { activeProjection ->
            projectionCallback?.let(activeProjection::unregisterCallback)
        }
        projection = null
        projectionCallback = null
        frameProducer = null
        projectionGeneration = null
        projectionSessionId = null
        runCatching { activeFrameProducer?.close() }
        ScreenProjectionRuntime.projectionStopped(generation, sessionId)
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun stopProjection(reasonCode: String, incrementGeneration: Boolean) {
        cancelSessionExpiry()
        val activeProjection = projection
        val callback = projectionCallback
        val activeFrameProducer = frameProducer
        projection = null
        projectionCallback = null
        frameProducer = null
        projectionGeneration = null
        projectionSessionId = null
        if (callback != null && activeProjection != null) {
            runCatching { activeProjection.unregisterCallback(callback) }
        }
        runCatching { activeFrameProducer?.close() }
        if (incrementGeneration) {
            runCatching { ScreenProjectionRuntime.stop() }
        }
        runCatching { activeProjection?.stop() }
        stopForeground(STOP_FOREGROUND_REMOVE)
        if (reasonCode == "session_expired") {
            stopSelf()
        }
    }

    private fun scheduleSessionExpiry() {
        cancelSessionExpiry()
        val task = Runnable {
            stopProjection("session_expired", incrementGeneration = true)
        }
        expiryRunnable = task
        mainHandler.postDelayed(task, MAXIMUM_SESSION_AGE_MS)
    }

    private fun cancelSessionExpiry() {
        expiryRunnable?.let(mainHandler::removeCallbacks)
        expiryRunnable = null
    }

    private fun startProjectionForeground(sessionId: String) {
        val stopIntent = PendingIntent.getService(
            this,
            STOP_REQUEST_CODE,
            stopIntent(this),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_menu_view)
            .setContentTitle(getString(com.sovereign.runtime.android.R.string.screen_projection_notification_title))
            .setContentText(getString(com.sovereign.runtime.android.R.string.screen_projection_notification_text))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setVisibility(NotificationCompat.VISIBILITY_SECRET)
            .addAction(
                0,
                getString(com.sovereign.runtime.android.R.string.screen_projection_notification_stop),
                stopIntent,
            )
            .setSubText(sessionId.take(8))
            .build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION,
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun createNotificationChannel() {
        val manager = getSystemService(NotificationManager::class.java) ?: return
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(com.sovereign.runtime.android.R.string.screen_projection_channel_name),
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = getString(
                com.sovereign.runtime.android.R.string.screen_projection_channel_description,
            )
            setShowBadge(false)
            lockscreenVisibility = NotificationCompat.VISIBILITY_SECRET
        }
        manager.createNotificationChannel(channel)
    }

    private fun parseStartRequest(intent: Intent): StartRequest? {
        val resultCode = intent.getIntExtra(
            SCREEN_PROJECTION_EXTRA_RESULT_CODE,
            Int.MIN_VALUE,
        )
        val generation = intent.getLongExtra(
            SCREEN_PROJECTION_EXTRA_GENERATION,
            Long.MIN_VALUE,
        )
        val requestId = intent.getStringExtra(SCREEN_PROJECTION_EXTRA_REQUEST_ID)
        val sessionId = intent.getStringExtra(SCREEN_PROJECTION_EXTRA_SESSION_ID)
        val resultData = intent.intentExtra(SCREEN_PROJECTION_EXTRA_RESULT_DATA)
        val validation = validateScreenProjectionStartMetadata(
            metadata = ScreenProjectionStartMetadata(
                resultCode = resultCode,
                generation = generation,
                requestId = requestId,
                projectionSessionId = sessionId,
                hasResultData = resultData != null,
            ),
            successfulResultCode = Activity.RESULT_OK,
        )
        val accepted = validation as? ScreenProjectionStartValidation.Accepted
            ?: return null
        return StartRequest(
            resultCode = resultCode,
            resultData = resultData ?: return null,
            generation = accepted.generation,
            requestId = accepted.requestId,
            projectionSessionId = accepted.projectionSessionId,
        )
    }

    @Suppress("DEPRECATION")
    private fun Intent.intentExtra(name: String): Intent? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            getParcelableExtra(name, Intent::class.java)
        } else {
            getParcelableExtra(name)
        }

    private data class StartRequest(
        val resultCode: Int,
        val resultData: Intent,
        val generation: Long,
        val requestId: String,
        val projectionSessionId: String,
    )

    companion object {
        private const val CHANNEL_ID = "sovereign_screen_projection"
        private const val NOTIFICATION_ID = 0x5343
        private const val STOP_REQUEST_CODE = 0x5344
        private const val MAXIMUM_SESSION_AGE_MS = 5 * 60 * 1_000L

        fun startIntent(
            context: Context,
            resultCode: Int,
            resultData: Intent,
            generation: Long,
            requestId: String,
            projectionSessionId: String,
        ): Intent = Intent(
            context,
            ScreenProjectionForegroundService::class.java,
        ).apply {
            action = SCREEN_PROJECTION_ACTION_START
            putExtra(SCREEN_PROJECTION_EXTRA_RESULT_CODE, resultCode)
            putExtra(SCREEN_PROJECTION_EXTRA_RESULT_DATA, resultData)
            putExtra(SCREEN_PROJECTION_EXTRA_GENERATION, generation)
            putExtra(SCREEN_PROJECTION_EXTRA_REQUEST_ID, requestId)
            putExtra(SCREEN_PROJECTION_EXTRA_SESSION_ID, projectionSessionId)
        }

        fun stopIntent(context: Context): Intent = Intent(
            context,
            ScreenProjectionForegroundService::class.java,
        ).apply {
            action = SCREEN_PROJECTION_ACTION_STOP
        }
    }
}
