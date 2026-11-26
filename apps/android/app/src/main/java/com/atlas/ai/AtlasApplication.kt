package com.atlas.ai

import android.app.Application
import android.util.Log

class AtlasApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        Log.i(TAG, "ATLAS Android Voice Assistant initialized.")
    }

    companion object {
        const val TAG = "AtlasApplication"
    }
}

