package com.sovereign.runtime.android.apps

import android.content.ActivityNotFoundException
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

internal class PackageManagerAndroidAppPlatform(
    context: Context,
) : AndroidAppPlatform {
    private val applicationContext = context.applicationContext
    private val packageManager = applicationContext.packageManager

    override suspend fun queryLauncherActivities(
        packageName: String?,
    ): List<AndroidLaunchActivity> = withContext(Dispatchers.IO) {
        val intent = Intent(Intent.ACTION_MAIN)
            .addCategory(Intent.CATEGORY_LAUNCHER)
            .apply {
                if (packageName != null) setPackage(packageName)
            }
        queryIntentActivities(intent).mapNotNull { resolveInfo ->
            val activityInfo = resolveInfo.activityInfo ?: return@mapNotNull null
            val resolvedPackageName = activityInfo.packageName ?: return@mapNotNull null
            val activityName = activityInfo.name ?: return@mapNotNull null
            val label = runCatching {
                resolveInfo.loadLabel(packageManager).toString()
            }.getOrNull()
            AndroidLaunchActivity(
                packageName = resolvedPackageName,
                activityName = activityName,
                label = label,
                enabled = activityInfo.enabled && activityInfo.applicationInfo.enabled,
                exported = activityInfo.exported,
            )
        }
    }

    override suspend fun launch(activity: AndroidLaunchActivity) {
        val intent = Intent(Intent.ACTION_MAIN)
            .addCategory(Intent.CATEGORY_LAUNCHER)
            .setComponent(
                ComponentName(
                    activity.packageName,
                    activity.activityName,
                ),
            )
            .addFlags(
                Intent.FLAG_ACTIVITY_NEW_TASK or
                    Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED,
            )
        withContext(Dispatchers.Main.immediate) {
            try {
                applicationContext.startActivity(intent)
            } catch (error: ActivityNotFoundException) {
                throw AndroidAppLaunchRejectedException(
                    "The selected launcher activity no longer exists.",
                    error,
                )
            } catch (error: SecurityException) {
                throw AndroidAppLaunchRejectedException(
                    "Android denied the selected launcher activity.",
                    error,
                )
            }
        }
    }

    @Suppress("DEPRECATION")
    private fun queryIntentActivities(intent: Intent) =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            packageManager.queryIntentActivities(
                intent,
                PackageManager.ResolveInfoFlags.of(0L),
            )
        } else {
            packageManager.queryIntentActivities(
                intent,
                0,
            )
        }
}
