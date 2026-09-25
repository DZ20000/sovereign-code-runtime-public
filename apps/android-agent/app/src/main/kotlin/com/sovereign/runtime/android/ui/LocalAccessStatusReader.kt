package com.sovereign.runtime.android.ui

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Build
import android.provider.Settings
import androidx.core.app.NotificationManagerCompat
import com.sovereign.runtime.android.accessibility.SovereignAccessibilityService
import com.sovereign.runtime.android.notification.SovereignNotificationListenerService
import com.sovereign.runtime.android.screen.ProjectionLifecycle
import com.sovereign.runtime.android.screen.ScreenProjectionRuntime

internal data class LocalAccessStatus(
    val accessibilityEnabled: Boolean,
    val notificationListenerEnabled: Boolean,
    val projectionLifecycle: ProjectionLifecycle,
    val projectionGeneration: Long,
    val projectionFailureReason: String?,
)

internal object LocalAccessStatusReader {
    fun read(context: Context): LocalAccessStatus {
        val projection = ScreenProjectionRuntime.state()
        return LocalAccessStatus(
            accessibilityEnabled = accessibilityServiceEnabled(context),
            notificationListenerEnabled = NotificationManagerCompat
                .getEnabledListenerPackages(context)
                .contains(context.packageName),
            projectionLifecycle = projection.lifecycle,
            projectionGeneration = projection.generation,
            projectionFailureReason = projection.failureReason,
        )
    }

    fun accessibilitySettingsIntent(): Intent = Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)

    fun notificationListenerSettingsIntent(context: Context): Intent {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            return Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)
        }
        val component = ComponentName(
            context,
            SovereignNotificationListenerService::class.java,
        )
        return Intent(Settings.ACTION_NOTIFICATION_LISTENER_DETAIL_SETTINGS).putExtra(
            Settings.EXTRA_NOTIFICATION_LISTENER_COMPONENT_NAME,
            component.flattenToString(),
        )
    }

    private fun accessibilityServiceEnabled(context: Context): Boolean {
        val expected = ComponentName(
            context,
            SovereignAccessibilityService::class.java,
        ).flattenToString()
        val enabledServices = Settings.Secure.getString(
            context.contentResolver,
            Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES,
        ).orEmpty()
        return enabledServices
            .split(':')
            .any { component -> component.equals(expected, ignoreCase = true) }
    }
}
