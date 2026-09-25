package com.sovereign.runtime.android.ui

import android.content.ActivityNotFoundException
import android.content.Intent
import android.provider.Settings
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.sovereign.runtime.android.screen.ProjectionLifecycle
import com.sovereign.runtime.android.screen.ScreenCaptureConsentActivity
import com.sovereign.runtime.android.screen.ScreenProjectionForegroundService
import kotlinx.coroutines.delay

@Composable
internal fun LocalAccessPanel(
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    var status by remember {
        mutableStateOf(LocalAccessStatusReader.read(context))
    }

    LaunchedEffect(context) {
        while (true) {
            status = LocalAccessStatusReader.read(context)
            delay(1_000)
        }
    }

    Card(
        modifier = modifier.fillMaxWidth(),
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text(
                text = "Local Android access",
                style = MaterialTheme.typography.titleMedium,
            )
            Text(
                text = "These controls open Android-owned permission surfaces. Remote MCP tools cannot grant them.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            AccessStatusRow(
                label = "Accessibility UI adapter",
                active = status.accessibilityEnabled,
                detail = if (status.accessibilityEnabled) {
                    "Enabled by the local Android user"
                } else {
                    "Disabled · UI observation and interaction are unavailable"
                },
            )
            OutlinedButton(
                onClick = {
                    context.startActivity(
                        LocalAccessStatusReader.accessibilitySettingsIntent()
                            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                    )
                },
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text("Open Accessibility settings")
            }

            AccessStatusRow(
                label = "Notification observer",
                active = status.notificationListenerEnabled,
                detail = if (status.notificationListenerEnabled) {
                    "Enabled · content remains redacted by local package policy"
                } else {
                    "Disabled · notification MCP tools return unavailable"
                },
            )
            OutlinedButton(
                onClick = {
                    val detailIntent = LocalAccessStatusReader
                        .notificationListenerSettingsIntent(context)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    try {
                        context.startActivity(detailIntent)
                    } catch (_: ActivityNotFoundException) {
                        context.startActivity(
                            Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)
                                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                        )
                    }
                },
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text("Open notification access")
            }

            AccessStatusRow(
                label = "Screen-capture consent",
                active = status.projectionLifecycle == ProjectionLifecycle.ACTIVE,
                detail = projectionDetail(status),
            )
            when (status.projectionLifecycle) {
                ProjectionLifecycle.ACTIVE -> Button(
                    onClick = {
                        context.startService(
                            ScreenProjectionForegroundService.stopIntent(context),
                        )
                    },
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text("Stop screen-capture consent")
                }
                ProjectionLifecycle.CONSENT_PENDING -> OutlinedButton(
                    onClick = {},
                    enabled = false,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text("Android consent is pending")
                }
                ProjectionLifecycle.IDLE,
                ProjectionLifecycle.NEEDS_ATTENTION -> OutlinedButton(
                    onClick = {
                        context.startActivity(
                            ScreenCaptureConsentActivity.createIntent(context)
                                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                        )
                    },
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text("Open Android screen consent")
                }
            }
            Text(
                text = "Screen consent is local-only. Remote capture remains bounded by authority, sensitive-surface policy, a short lease, and one-time in-memory reads.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun AccessStatusRow(
    label: String,
    active: Boolean,
    detail: String,
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Column(
            modifier = Modifier.weight(1f),
        ) {
            Text(
                text = label,
                style = MaterialTheme.typography.labelLarge,
            )
            Text(
                text = detail,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Text(
            text = if (active) "Ready" else "Off",
            style = MaterialTheme.typography.labelMedium,
            color = if (active) {
                MaterialTheme.colorScheme.primary
            } else {
                MaterialTheme.colorScheme.onSurfaceVariant
            },
        )
    }
}

private fun projectionDetail(status: LocalAccessStatus): String = when (
    status.projectionLifecycle
) {
    ProjectionLifecycle.IDLE -> "Idle · Android consent is not active"
    ProjectionLifecycle.CONSENT_PENDING ->
        "Waiting for local Android consent · generation ${status.projectionGeneration}"
    ProjectionLifecycle.ACTIVE ->
        "Active in this app process · automatically expires after five minutes"
    ProjectionLifecycle.NEEDS_ATTENTION ->
        status.projectionFailureReason ?: "Screen-capture ownership needs local attention"
}
