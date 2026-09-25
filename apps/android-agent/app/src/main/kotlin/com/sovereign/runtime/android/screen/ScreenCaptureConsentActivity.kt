package com.sovereign.runtime.android.screen

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.media.projection.MediaProjectionManager
import android.os.Bundle
import android.os.SystemClock
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import java.util.UUID

class ScreenCaptureConsentActivity : ComponentActivity() {
    private var pendingGeneration: Long? = null
    private var pendingRequestId: String? = null

    private val consentLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) { result ->
        handleConsentResult(result.resultCode, result.data)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        pendingGeneration = savedInstanceState?.getLong(KEY_GENERATION)
            ?.takeIf { savedInstanceState.containsKey(KEY_GENERATION) }
        pendingRequestId = savedInstanceState?.getString(KEY_REQUEST_ID)

        if (savedInstanceState != null) {
            val state = ScreenProjectionRuntime.state()
            if (
                state.lifecycle != ProjectionLifecycle.CONSENT_PENDING ||
                state.generation != pendingGeneration ||
                state.consentRequestId != pendingRequestId
            ) {
                finish()
            }
            return
        }

        val transition = ScreenProjectionRuntime.requestLocalConsent()
        val effect = transition.effect
        if (effect !is ProjectionEffect.PresentLocalConsent) {
            finish()
            return
        }
        pendingGeneration = effect.generation
        pendingRequestId = effect.requestId
        try {
            val manager = getSystemService(MediaProjectionManager::class.java)
                ?: throw IllegalStateException("MediaProjectionManager is unavailable.")
            consentLauncher.launch(manager.createScreenCaptureIntent())
        } catch (error: Exception) {
            ScreenProjectionRuntime.fail(
                generation = effect.generation,
                redactedReason = "MediaProjection consent surface could not be opened: ${error::class.java.simpleName}",
            )
            finish()
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        pendingGeneration?.let { generation -> outState.putLong(KEY_GENERATION, generation) }
        pendingRequestId?.let { requestId -> outState.putString(KEY_REQUEST_ID, requestId) }
        super.onSaveInstanceState(outState)
    }

    private fun handleConsentResult(resultCode: Int, resultData: Intent?) {
        val generation = pendingGeneration
        val requestId = pendingRequestId
        if (generation == null || requestId == null) {
            finish()
            return
        }
        val state = ScreenProjectionRuntime.state()
        if (
            state.lifecycle != ProjectionLifecycle.CONSENT_PENDING ||
            state.generation != generation ||
            state.consentRequestId != requestId
        ) {
            finish()
            return
        }
        val deadline = state.deadlineAtElapsedMs
        if (deadline == null || SystemClock.elapsedRealtime() >= deadline) {
            ScreenProjectionRuntime.consentDeadlineExpired(generation)
            finish()
            return
        }
        if (resultCode != Activity.RESULT_OK || resultData == null) {
            ScreenProjectionRuntime.consentDenied(generation, requestId)
            finish()
            return
        }

        val sessionId = UUID.randomUUID().toString()
        val serviceIntent = ScreenProjectionForegroundService.startIntent(
            context = this,
            resultCode = resultCode,
            resultData = Intent(resultData),
            generation = generation,
            requestId = requestId,
            projectionSessionId = sessionId,
        )
        try {
            ContextCompat.startForegroundService(this, serviceIntent)
        } catch (error: Exception) {
            ScreenProjectionRuntime.fail(
                generation = generation,
                redactedReason = "MediaProjection foreground service could not start: ${error::class.java.simpleName}",
            )
        } finally {
            finish()
        }
    }

    companion object {
        private const val KEY_GENERATION = "projection_generation"
        private const val KEY_REQUEST_ID = "projection_request_id"

        fun createIntent(context: Context): Intent = Intent(
            context,
            ScreenCaptureConsentActivity::class.java,
        ).addFlags(Intent.FLAG_ACTIVITY_NO_ANIMATION)
    }
}
