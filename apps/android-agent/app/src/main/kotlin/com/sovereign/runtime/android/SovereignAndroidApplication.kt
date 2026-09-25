package com.sovereign.runtime.android

import android.app.Application
import android.content.Context
import com.sovereign.runtime.android.runtime.AndroidAgentRuntime

class SovereignAndroidApplication : Application() {
    lateinit var runtime: AndroidAgentRuntime
        private set

    override fun onCreate() {
        super.onCreate()
        runtime = AndroidAgentRuntime(applicationContext)
    }

    companion object {
        fun from(context: Context): SovereignAndroidApplication =
            context.applicationContext as? SovereignAndroidApplication
                ?: error("Sovereign Android application runtime is unavailable.")
    }
}
