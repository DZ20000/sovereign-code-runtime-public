package com.sovereign.runtime.android

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch
import com.sovereign.runtime.android.approval.AndroidApprovalBrokerState
import com.sovereign.runtime.android.gateway.McpGatewayService
import com.sovereign.runtime.android.ui.AgentScreen
import com.sovereign.runtime.android.ui.MainViewModel

internal fun shouldSecureMainActivityWindow(
    connectionConfigVisible: Boolean,
    approvalState: AndroidApprovalBrokerState,
): Boolean = connectionConfigVisible || approvalState.active != null

class MainActivity : ComponentActivity() {
    private lateinit var mainViewModel: MainViewModel

    private val notificationPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        if (granted && McpGatewayService.notificationsAreAvailable(this)) {
            McpGatewayService.requestStart(this)
        } else {
            mainViewModel.reportError(
                IllegalStateException(
                    "Visible notifications are required for the local MCP foreground service.",
                ),
            )
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val runtime = SovereignAndroidApplication.from(this).runtime
        mainViewModel = ViewModelProvider(
            this,
            MainViewModel.Factory(runtime),
        )[MainViewModel::class.java]
        applySecureWindowState()
        setContent {
            AgentScreen(
                viewModel = mainViewModel,
                openAccessibilitySettings = ::openAccessibilitySettings,
                startGateway = ::requestStartGateway,
                stopGateway = ::requestStopGateway,
                openNotificationSettings = ::openNotificationSettings,
            )
        }
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                combine(
                    mainViewModel.connectionConfig,
                    mainViewModel.approvalState,
                ) { config, approval ->
                    shouldSecureMainActivityWindow(
                        connectionConfigVisible = config != null,
                        approvalState = approval,
                    )
                }
                    .distinctUntilChanged()
                    .collect { secureContentVisible ->
                        setSecureWindowState(secureContentVisible)
                    }
            }
        }
    }

    override fun onResume() {
        super.onResume()
        if (::mainViewModel.isInitialized) {
            applySecureWindowState()
        }
    }

    private fun applySecureWindowState() {
        setSecureWindowState(
            shouldSecureMainActivityWindow(
                connectionConfigVisible = mainViewModel.connectionConfig.value != null,
                approvalState = mainViewModel.approvalState.value,
            ),
        )
    }

    private fun setSecureWindowState(secureContentVisible: Boolean) {
        if (secureContentVisible) {
            window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        } else {
            window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
        }
    }

    private fun openAccessibilitySettings() {
        startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
    }

    private fun requestStartGateway() {
        if (McpGatewayService.notificationsAreAvailable(this)) {
            McpGatewayService.requestStart(this)
            return
        }
        if (
            Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(
                this,
                Manifest.permission.POST_NOTIFICATIONS,
            ) != PackageManager.PERMISSION_GRANTED
        ) {
            notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
            return
        }
        mainViewModel.reportError(
            IllegalStateException(
                "Notifications are disabled for Sovereign. Enable them before starting the local MCP gateway.",
            ),
        )
    }

    private fun requestStopGateway() {
        McpGatewayService.requestStop(this)
    }

    private fun openNotificationSettings() {
        startActivity(
            Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).apply {
                putExtra(Settings.EXTRA_APP_PACKAGE, packageName)
            },
        )
    }
}
