package com.sovereign.runtime.android.ui

import android.os.SystemClock
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.sovereign.runtime.android.accessibility.UiNodeSnapshot
import com.sovereign.runtime.android.approval.AndroidApprovalBrokerState
import com.sovereign.runtime.android.approval.AndroidApprovalPresentation
import com.sovereign.runtime.android.audit.AndroidAuditLedgerPhase
import com.sovereign.runtime.android.audit.AndroidAuditLedgerState
import com.sovereign.runtime.android.gateway.McpGatewayConnectionConfig
import com.sovereign.runtime.android.gateway.McpGatewayPhase
import com.sovereign.runtime.android.gateway.McpGatewayState
import com.sovereign.runtime.android.runtime.AuthorityProfile
import kotlinx.coroutines.delay

@Composable
fun AgentScreen(
    viewModel: MainViewModel,
    openAccessibilitySettings: () -> Unit,
    startGateway: () -> Unit,
    stopGateway: () -> Unit,
    openNotificationSettings: () -> Unit,
) {
    val serviceConnected by viewModel.serviceConnected.collectAsStateWithLifecycle()
    val profile by viewModel.profile.collectAsStateWithLifecycle()
    val snapshot by viewModel.snapshot.collectAsStateWithLifecycle()
    val status by viewModel.status.collectAsStateWithLifecycle()
    val approvalState by viewModel.approvalState.collectAsStateWithLifecycle()
    val auditState by viewModel.auditState.collectAsStateWithLifecycle()
    val gatewayState by viewModel.gatewayState.collectAsStateWithLifecycle()
    val connectionConfig by viewModel.connectionConfig.collectAsStateWithLifecycle()
    var textDraft by rememberSaveable { mutableStateOf("Hello from Sovereign") }

    MaterialTheme {
        Surface(modifier = Modifier.fillMaxSize()) {
            LazyColumn(
                modifier = Modifier
                    .fillMaxSize()
                    .windowInsetsPadding(WindowInsets.safeDrawing),
                verticalArrangement = Arrangement.spacedBy(12.dp),
                contentPadding = PaddingValues(16.dp),
            ) {
                item {
                    Text(
                        text = "Sovereign Android Runtime",
                        style = MaterialTheme.typography.headlineSmall,
                        fontWeight = FontWeight.SemiBold,
                    )
                    Text(
                        text = "Accessibility + authenticated loopback MCP · no remote relay · no Shizuku · no Root",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }

                if (approvalState.active != null) {
                    item(key = "active-approval") {
                        ApprovalCard(
                            state = approvalState,
                            allowApproval = viewModel::allowApproval,
                            denyApproval = viewModel::denyApproval,
                        )
                    }
                }

                item {
                    StatusCard(
                        serviceConnected = serviceConnected,
                        status = status,
                        openAccessibilitySettings = openAccessibilitySettings,
                    )
                }

                item {
                    LocalAccessPanel()
                }

                item {
                    GatewayCard(
                        state = gatewayState,
                        connectionConfig = connectionConfig,
                        startGateway = startGateway,
                        stopGateway = stopGateway,
                        revealConnection = viewModel::revealGatewayConnection,
                        hideConnection = viewModel::hideConnectionConfig,
                        rotateCredential = viewModel::rotateGatewayCredential,
                        openNotificationSettings = openNotificationSettings,
                    )
                }

                item {
                    AuditCard(
                        state = auditState,
                        verifyAudit = viewModel::verifyAuditLedger,
                    )
                }

                item {
                    AuthorityCard(
                        profile = profile,
                        onProfile = viewModel::setProfile,
                    )
                }

                item {
                    Card(modifier = Modifier.fillMaxWidth()) {
                        Column(modifier = Modifier.padding(14.dp)) {
                            Text(
                                text = "Local controls",
                                style = MaterialTheme.typography.titleMedium,
                                fontWeight = FontWeight.SemiBold,
                            )
                            Spacer(Modifier.height(8.dp))
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.spacedBy(8.dp),
                            ) {
                                Button(
                                    onClick = viewModel::observe,
                                    enabled = serviceConnected,
                                    modifier = Modifier.weight(1f),
                                ) {
                                    Text("Observe")
                                }
                                OutlinedButton(
                                    onClick = viewModel::globalBack,
                                    enabled = profile == AuthorityProfile.INTERACTION && snapshot != null,
                                    modifier = Modifier.weight(1f),
                                ) {
                                    Text("Back")
                                }
                                OutlinedButton(
                                    onClick = viewModel::globalHome,
                                    enabled = profile == AuthorityProfile.INTERACTION && snapshot != null,
                                    modifier = Modifier.weight(1f),
                                ) {
                                    Text("Home")
                                }
                            }
                            Spacer(Modifier.height(8.dp))
                            OutlinedTextField(
                                value = textDraft,
                                onValueChange = { value -> textDraft = value.take(4_000) },
                                modifier = Modifier.fillMaxWidth(),
                                label = { Text("Local ACTION_SET_TEXT test value") },
                                supportingText = {
                                    Text("Clipboard fallback is intentionally disabled.")
                                },
                            )
                        }
                    }
                }

                item {
                    Card(modifier = Modifier.fillMaxWidth()) {
                        Column(modifier = Modifier.padding(14.dp)) {
                            Text(
                                text = "Latest snapshot",
                                style = MaterialTheme.typography.titleMedium,
                                fontWeight = FontWeight.SemiBold,
                            )
                            Spacer(Modifier.height(6.dp))
                            val currentSnapshot = snapshot
                            if (currentSnapshot == null) {
                                Text(
                                    text = "No current revision. Observe the active window before acting.",
                                    style = MaterialTheme.typography.bodyMedium,
                                )
                            } else {
                                Text(
                                    text = "revision ${currentSnapshot.revision}",
                                    style = MaterialTheme.typography.bodySmall,
                                    fontFamily = FontFamily.Monospace,
                                )
                                Text(
                                    text = "${currentSnapshot.packageName ?: "unknown package"} · " +
                                        "${currentSnapshot.nodes.size} nodes" +
                                        if (currentSnapshot.truncated) " · truncated" else "",
                                    style = MaterialTheme.typography.bodyMedium,
                                )
                                if (currentSnapshot.redactionCount > 0) {
                                    Text(
                                        text = "${currentSnapshot.redactionCount} protected node(s) redacted",
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.error,
                                    )
                                }
                            }
                        }
                    }
                }

                snapshot?.let { currentSnapshot ->
                    items(
                        items = currentSnapshot.nodes.take(80),
                        key = { node -> "${currentSnapshot.revision}:${node.ref}" },
                    ) { node ->
                        NodeCard(
                            node = node,
                            interactionEnabled = profile == AuthorityProfile.INTERACTION,
                            textDraft = textDraft,
                            onClick = { viewModel.click(node.ref) },
                            onLongPress = { viewModel.longPress(node.ref) },
                            onSetText = { viewModel.setText(node.ref, textDraft) },
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun StatusCard(
    serviceConnected: Boolean,
    status: String,
    openAccessibilitySettings: () -> Unit,
) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(14.dp)) {
            Text(
                text = if (serviceConnected) {
                    "UI Adapter connected"
                } else {
                    "UI Adapter disabled"
                },
                style = MaterialTheme.typography.titleMedium,
                color = if (serviceConnected) {
                    MaterialTheme.colorScheme.primary
                } else {
                    MaterialTheme.colorScheme.error
                },
                fontWeight = FontWeight.SemiBold,
            )
            Spacer(Modifier.height(4.dp))
            Text(status, style = MaterialTheme.typography.bodyMedium)
            Spacer(Modifier.height(10.dp))
            OutlinedButton(onClick = openAccessibilitySettings) {
                Text("Open Accessibility settings")
            }
        }
    }
}

@Composable
private fun GatewayCard(
    state: McpGatewayState,
    connectionConfig: McpGatewayConnectionConfig?,
    startGateway: () -> Unit,
    stopGateway: () -> Unit,
    revealConnection: () -> Unit,
    hideConnection: () -> Unit,
    rotateCredential: () -> Unit,
    openNotificationSettings: () -> Unit,
) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(14.dp)) {
            Text(
                text = "Local MCP gateway",
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
            )
            Text(
                text = "User-started foreground service · 127.0.0.1 only · Bearer required",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(10.dp))
            Text(
                text = gatewayPhaseLabel(state.phase),
                style = MaterialTheme.typography.bodyLarge,
                color = when (state.phase) {
                    McpGatewayPhase.RUNNING -> MaterialTheme.colorScheme.primary
                    McpGatewayPhase.ERROR -> MaterialTheme.colorScheme.error
                    else -> MaterialTheme.colorScheme.onSurface
                },
                fontWeight = FontWeight.SemiBold,
            )
            state.endpoint?.let { endpoint ->
                SelectionContainer {
                    Text(
                        text = endpoint,
                        style = MaterialTheme.typography.bodySmall,
                        fontFamily = FontFamily.Monospace,
                    )
                }
            }
            if (state.listenerOwned) {
                Text(
                    text = "${state.activeSessions} active session(s) · key ${state.tokenFingerprint ?: "unknown"}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            state.errorMessage?.let { message ->
                Spacer(Modifier.height(6.dp))
                Text(
                    text = message,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
            }
            Spacer(Modifier.height(10.dp))
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                when {
                    state.listenerOwned -> Button(
                        onClick = stopGateway,
                        enabled = state.phase != McpGatewayPhase.STOPPING,
                        modifier = Modifier.weight(1f),
                    ) {
                        Text(
                            if (state.phase == McpGatewayPhase.STOPPING) {
                                "Stopping…"
                            } else {
                                "Stop gateway"
                            },
                        )
                    }
                    state.phase in setOf(McpGatewayPhase.STOPPED, McpGatewayPhase.ERROR) ->
                        Button(
                            onClick = startGateway,
                            modifier = Modifier.weight(1f),
                        ) {
                            Text("Start gateway")
                        }
                    else -> Button(
                        onClick = {},
                        enabled = false,
                        modifier = Modifier.weight(1f),
                    ) {
                        Text(
                            if (state.phase == McpGatewayPhase.STOPPING) {
                                "Stopping…"
                            } else {
                                "Starting…"
                            },
                        )
                    }
                }
                OutlinedButton(
                    onClick = revealConnection,
                    enabled = state.phase == McpGatewayPhase.RUNNING,
                    modifier = Modifier.weight(1f),
                ) {
                    Text("Reveal config")
                }
            }
            Spacer(Modifier.height(8.dp))
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                OutlinedButton(
                    onClick = rotateCredential,
                    enabled = !state.listenerOwned && state.phase in setOf(
                        McpGatewayPhase.STOPPED,
                        McpGatewayPhase.ERROR,
                    ),
                    modifier = Modifier.weight(1f),
                ) {
                    Text("Rotate key")
                }
                OutlinedButton(
                    onClick = openNotificationSettings,
                    modifier = Modifier.weight(1f),
                ) {
                    Text("Notifications")
                }
            }

            connectionConfig?.let { config ->
                Spacer(Modifier.height(12.dp))
                HorizontalDivider()
                Spacer(Modifier.height(10.dp))
                Text(
                    text = "Connection secret · visible for 30 seconds",
                    style = MaterialTheme.typography.labelLarge,
                    color = MaterialTheme.colorScheme.error,
                    fontWeight = FontWeight.SemiBold,
                )
                Text(
                    text = "Use only on this device or through a future authenticated tunnel. Treat the Authorization header as a password.",
                    style = MaterialTheme.typography.bodySmall,
                )
                Spacer(Modifier.height(8.dp))
                SelectionContainer(
                    modifier = Modifier.clearAndSetSemantics {
                        contentDescription =
                            "Sensitive local MCP connection credential. Hidden from Accessibility output."
                    },
                ) {
                    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text(
                            text = config.endpoint,
                            style = MaterialTheme.typography.bodySmall,
                            fontFamily = FontFamily.Monospace,
                        )
                        Text(
                            text = "Authorization: ${config.authorizationHeader}",
                            style = MaterialTheme.typography.bodySmall,
                            fontFamily = FontFamily.Monospace,
                        )
                    }
                }
                Spacer(Modifier.height(8.dp))
                OutlinedButton(onClick = hideConnection) {
                    Text("Hide secret")
                }
            }
        }
    }
}

private fun gatewayPhaseLabel(phase: McpGatewayPhase): String = when (phase) {
    McpGatewayPhase.STOPPED -> "Stopped"
    McpGatewayPhase.STARTING -> "Starting"
    McpGatewayPhase.RUNNING -> "Running"
    McpGatewayPhase.STOPPING -> "Stopping"
    McpGatewayPhase.ERROR -> "Needs attention"
}

@Composable
private fun ApprovalCard(
    state: AndroidApprovalBrokerState,
    allowApproval: (String) -> Unit,
    denyApproval: (String) -> Unit,
) {
    val presentation = state.active ?: return
    var remainingSeconds by remember(presentation.requestId) {
        mutableLongStateOf(approvalRemainingSeconds(presentation))
    }
    LaunchedEffect(presentation.requestId, presentation.expiresAtElapsedMs) {
        while (true) {
            remainingSeconds = approvalRemainingSeconds(presentation)
            if (remainingSeconds <= 0L) break
            delay(250L)
        }
    }

    Card(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(14.dp)) {
            Text(
                text = "Local approval required",
                style = MaterialTheme.typography.titleMedium,
                color = MaterialTheme.colorScheme.error,
                fontWeight = FontWeight.SemiBold,
            )
            Text(
                text = "A remote client is waiting. Review this exact one-time action on the phone.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(10.dp))
            Text(
                text = presentation.title,
                style = MaterialTheme.typography.bodyLarge,
                fontWeight = FontWeight.SemiBold,
            )
            Text(
                text = presentation.message,
                style = MaterialTheme.typography.bodyMedium,
            )
            Spacer(Modifier.height(8.dp))
            SelectionContainer {
                Text(
                    text = presentation.detail,
                    style = MaterialTheme.typography.bodySmall,
                    fontFamily = FontFamily.Monospace,
                )
            }
            Spacer(Modifier.height(6.dp))
            Text(
                text = "Client ${presentation.principalFingerprint} · expires in ${remainingSeconds}s" +
                    if (state.queuedCount > 0) " · ${state.queuedCount} queued" else "",
                style = MaterialTheme.typography.bodySmall,
                color = if (remainingSeconds > 0L) {
                    MaterialTheme.colorScheme.onSurfaceVariant
                } else {
                    MaterialTheme.colorScheme.error
                },
                fontFamily = FontFamily.Monospace,
            )
            if (presentation.burstDetected) {
                Text(
                    text = "Multiple approval requests arrived in a short interval. Verify the tool and digest carefully.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
            }
            Spacer(Modifier.height(10.dp))
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                OutlinedButton(
                    onClick = { denyApproval(presentation.requestId) },
                    enabled = remainingSeconds > 0L,
                    modifier = Modifier.weight(1f),
                ) {
                    Text("Deny")
                }
                Button(
                    onClick = { allowApproval(presentation.requestId) },
                    enabled = remainingSeconds > 0L,
                    modifier = Modifier.weight(1f),
                ) {
                    Text("Allow once")
                }
            }
        }
    }
}

private fun approvalRemainingSeconds(
    presentation: AndroidApprovalPresentation,
): Long {
    val remainingMs = presentation.expiresAtElapsedMs - SystemClock.elapsedRealtime()
    return if (remainingMs <= 0L) 0L else (remainingMs + 999L) / 1_000L
}

@Composable
private fun AuditCard(
    state: AndroidAuditLedgerState,
    verifyAudit: () -> Unit,
) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(14.dp)) {
            Text(
                text = "Immutable audit",
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
            )
            Text(
                text = "Tool arguments and results are stored only as SHA-256 digests plus bounded metadata.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(8.dp))
            Text(
                text = when (state.phase) {
                    AndroidAuditLedgerPhase.UNVERIFIED -> "Not verified"
                    AndroidAuditLedgerPhase.READY -> "Ready"
                    AndroidAuditLedgerPhase.ERROR -> "Needs attention"
                },
                color = when (state.phase) {
                    AndroidAuditLedgerPhase.READY -> MaterialTheme.colorScheme.primary
                    AndroidAuditLedgerPhase.ERROR -> MaterialTheme.colorScheme.error
                    AndroidAuditLedgerPhase.UNVERIFIED -> MaterialTheme.colorScheme.onSurface
                },
                fontWeight = FontWeight.SemiBold,
            )
            state.lastSequence?.let { sequence ->
                Text(
                    text = "Receipt $sequence · ${state.lastReceiptSha256?.take(16) ?: "digest unavailable"}",
                    style = MaterialTheme.typography.bodySmall,
                    fontFamily = FontFamily.Monospace,
                )
            }
            state.directorySyncCompleted?.let { completed ->
                Text(
                    text = if (completed) {
                        "File and directory durability confirmed."
                    } else {
                        "Receipt file flushed; directory metadata durability is unavailable on this device."
                    },
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            state.errorMessage?.let { message ->
                Spacer(Modifier.height(6.dp))
                Text(
                    text = "${state.errorCode ?: "AUDIT_UNAVAILABLE"}: $message",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
            }
            Spacer(Modifier.height(8.dp))
            OutlinedButton(onClick = verifyAudit) {
                Text("Verify receipts")
            }
        }
    }
}

@Composable
private fun AuthorityCard(
    profile: AuthorityProfile,
    onProfile: (AuthorityProfile) -> Unit,
) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(14.dp)) {
            Text(
                text = "Local authority",
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
            )
            Text(
                text = "The profile is local-only in this checkpoint and resets with the app process.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(10.dp))
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                ProfileButton(
                    label = "L1 Observe",
                    selected = profile == AuthorityProfile.OBSERVE,
                    enabled = true,
                    modifier = Modifier.weight(1f),
                    onClick = { onProfile(AuthorityProfile.OBSERVE) },
                )
                ProfileButton(
                    label = "L2 Interaction",
                    selected = profile == AuthorityProfile.INTERACTION,
                    enabled = true,
                    modifier = Modifier.weight(1f),
                    onClick = { onProfile(AuthorityProfile.INTERACTION) },
                )
            }
            Spacer(Modifier.height(8.dp))
            Text(
                text = "L3 System is intentionally unavailable until the optional Shizuku facade is implemented.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun ProfileButton(
    label: String,
    selected: Boolean,
    enabled: Boolean,
    modifier: Modifier = Modifier,
    onClick: () -> Unit,
) {
    if (selected) {
        Button(
            onClick = onClick,
            enabled = enabled,
            modifier = modifier,
        ) {
            Text(label)
        }
    } else {
        OutlinedButton(
            onClick = onClick,
            enabled = enabled,
            modifier = modifier,
        ) {
            Text(label)
        }
    }
}

@Composable
private fun NodeCard(
    node: UiNodeSnapshot,
    interactionEnabled: Boolean,
    textDraft: String,
    onClick: () -> Unit,
    onLongPress: () -> Unit,
    onSetText: () -> Unit,
) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(12.dp)) {
            Row(modifier = Modifier.fillMaxWidth()) {
                Text(
                    text = node.ref,
                    fontFamily = FontFamily.Monospace,
                    fontWeight = FontWeight.Bold,
                )
                Spacer(Modifier.width(8.dp))
                Text(
                    text = node.role.name,
                    style = MaterialTheme.typography.labelMedium,
                )
            }
            Spacer(Modifier.height(4.dp))
            Text(
                text = when {
                    node.redacted -> "[REDACTED PROTECTED NODE]"
                    node.text != null -> node.text
                    node.contentDescription != null -> node.contentDescription
                    else -> "(no public label)"
                },
                style = MaterialTheme.typography.bodyMedium,
            )
            Text(
                text = "${node.packageName ?: "unknown"} · " +
                    "[${node.bounds.left},${node.bounds.top},${node.bounds.right},${node.bounds.bottom}]",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                fontFamily = FontFamily.Monospace,
            )
            if (node.interactionDenied) {
                Text(
                    text = node.interactionDeniedReason ?: "Interaction denied by local policy.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
            }
            val canInteract = interactionEnabled && !node.interactionDenied && node.enabled
            if (canInteract && (node.clickable || node.longClickable || node.editable)) {
                Spacer(Modifier.height(8.dp))
                HorizontalDivider()
                Spacer(Modifier.height(8.dp))
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    if (node.clickable) {
                        OutlinedButton(
                            onClick = onClick,
                            modifier = Modifier.weight(1f),
                        ) {
                            Text("Click")
                        }
                    }
                    if (node.longClickable) {
                        OutlinedButton(
                            onClick = onLongPress,
                            modifier = Modifier.weight(1f),
                        ) {
                            Text("Long")
                        }
                    }
                    if (node.editable) {
                        OutlinedButton(
                            onClick = onSetText,
                            enabled = textDraft.length <= 4_000,
                            modifier = Modifier.weight(1f),
                        ) {
                            Text("Set text")
                        }
                    }
                }
            }
        }
    }
}
