package com.atlas.ai.service

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import com.atlas.ai.MainActivity
import com.atlas.ai.audio.WakeWordEngine
import com.atlas.ai.audio.WakeWordListener
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * Android Foreground Service for persistent Background & Lock-Screen "Hey Atlas" detection.
 *
 * Runs with `android:foregroundServiceType="microphone"` (Android 14+ API 34).
 * Holds a partial wake lock to keep listening active while screen is locked.
 * On keyword detection:
 * 1. Acquires a temporary bright/partial wake lock.
 * 2. Launches or brings forward lock-screen compatible MainActivity (`setShowWhenLocked(true)`).
 * 3. Instructs the UI/client to automatically start streaming voice input to the ATLAS gateway.
 */
open class AtlasWakeWordService : Service(), WakeWordListener {

    companion object {
        private const val TAG = "AtlasWakeWordService"
        const val CHANNEL_ID = "atlas_wake_word_channel"
        const val NOTIFICATION_ID = 2002
        const val WAKE_NOTIFICATION_ID = 2003

        const val ACTION_START_LISTENING = "com.atlas.ai.action.START_WAKE_WORD_LISTENING"
        const val ACTION_STOP_LISTENING = "com.atlas.ai.action.STOP_WAKE_WORD_LISTENING"
        const val ACTION_WAKE_WORD_TRIGGERED = "com.atlas.ai.action.WAKE_WORD_TRIGGERED"

        private val _isServiceRunning = MutableStateFlow(false)
        val isServiceRunning: StateFlow<Boolean> = _isServiceRunning.asStateFlow()

        fun start(context: Context) {
            val intent = Intent(context, AtlasWakeWordService::class.java).apply {
                action = ACTION_START_LISTENING
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stop(context: Context) {
            val intent = Intent(context, AtlasWakeWordService::class.java).apply {
                action = ACTION_STOP_LISTENING
            }
            context.startService(intent)
        }
    }

    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var wakeLock: PowerManager.WakeLock? = null
    private var wakeWordEngine: WakeWordEngine? = null

    override fun onCreate() {
        super.onCreate()
        Log.d(TAG, "AtlasWakeWordService created")
        createNotificationChannel()

        // Initialize WakeWord engine with context for native speech detection
        wakeWordEngine = WakeWordEngine(serviceScope, this, this)

        val powerManager = getSystemService(Context.POWER_SERVICE) as? PowerManager
        wakeLock = powerManager?.newWakeLock(
            PowerManager.PARTIAL_WAKE_LOCK,
            "Atlas::BackgroundWakeLock"
        )?.apply {
            setReferenceCounted(false)
        }
    }

    @SuppressLint("WakelockTimeout")
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val action = intent?.action ?: ACTION_START_LISTENING

        when (action) {
            ACTION_START_LISTENING -> {
                Log.d(TAG, "Starting wake-word listening service...")
                startForegroundWithNotification()
                wakeLock?.acquire()
                _isServiceRunning.value = true

                wakeWordEngine?.startListening()
            }
            ACTION_STOP_LISTENING -> {
                Log.d(TAG, "Stopping wake-word listening service...")
                stopForegroundListening()
                stopSelf()
            }
        }

        return START_STICKY
    }

    private fun startForegroundWithNotification() {
        val notification = buildPersistentNotification("Listening in background for 'Hey Atlas'...")

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            ServiceCompat.startForeground(
                this,
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun stopForegroundListening() {
        _isServiceRunning.value = false
        wakeWordEngine?.stopListening()

        try {
            if (wakeLock?.isHeld == true) {
                wakeLock?.release()
            }
        } catch (_: Exception) {}

        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Atlas Wake-Word Detection",
                NotificationManager.IMPORTANCE_HIGH
            ).apply {
                description = "Keeps 'Hey Atlas' listening active in background and on lock screen"
                setShowBadge(false)
                lockscreenVisibility = Notification.VISIBILITY_PUBLIC
            }
            val manager = getSystemService(NotificationManager::class.java)
            manager?.createNotificationChannel(channel)
        }
    }

    private fun buildPersistentNotification(contentText: String): Notification {
        val openAppIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val pendingIntent = PendingIntent.getActivity(
            this,
            0,
            openAppIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val stopIntent = Intent(this, AtlasWakeWordService::class.java).apply {
            action = ACTION_STOP_LISTENING
        }
        val stopPendingIntent = PendingIntent.getService(
            this,
            1,
            stopIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("ATLAS AI Companion")
            .setContentText(contentText)
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentIntent(pendingIntent)
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Stop", stopPendingIntent)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .build()
    }

    // WakeWordListener implementation
    override fun onWakeWordDetected(keyword: String, audioSample: ByteArray?) {
        Log.i(TAG, "Wake word detected! Bringing ATLAS forward: $keyword")

        // Acquire 15s wake lock to keep device awake while launching UI
        try {
            val pm = getSystemService(Context.POWER_SERVICE) as? PowerManager
            @Suppress("DEPRECATION")
            val screenLock = pm?.newWakeLock(
                PowerManager.SCREEN_BRIGHT_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP,
                "Atlas::ScreenWakeOnHotword"
            )
            screenLock?.acquire(15000L)
        } catch (e: Exception) {
            Log.w(TAG, "Failed to acquire screen wake lock", e)
        }

        serviceScope.launch(Dispatchers.Main) {
            val wakeIntent = Intent(this@AtlasWakeWordService, MainActivity::class.java).apply {
                action = ACTION_WAKE_WORD_TRIGGERED
                addFlags(
                    Intent.FLAG_ACTIVITY_NEW_TASK or
                    Intent.FLAG_ACTIVITY_REORDER_TO_FRONT or
                    Intent.FLAG_ACTIVITY_SINGLE_TOP
                )
                putExtra("EXTRA_AUTO_START_LISTENING", true)
                putExtra("EXTRA_WAKE_KEYWORD", keyword)
            }

            // Create high-priority full-screen intent notification so it pops up over lock screen
            val fullScreenPendingIntent = PendingIntent.getActivity(
                this@AtlasWakeWordService,
                101,
                wakeIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )

            val wakeNotification = NotificationCompat.Builder(this@AtlasWakeWordService, CHANNEL_ID)
                .setContentTitle("ATLAS Activated")
                .setContentText("Listening via '$keyword'...")
                .setSmallIcon(android.R.drawable.ic_btn_speak_now)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_CALL)
                .setFullScreenIntent(fullScreenPendingIntent, true)
                .setAutoCancel(true)
                .build()

            val notificationManager = getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
            notificationManager?.notify(WAKE_NOTIFICATION_ID, wakeNotification)

            try {
                startActivity(wakeIntent)
            } catch (e: Exception) {
                Log.e(TAG, "Failed to start MainActivity directly from service", e)
            }
        }
    }

    override fun onSpeechActivityChanged(isSpeaking: Boolean) {
        Log.d(TAG, "Speech activity changed: isSpeaking=$isSpeaking")
    }

    override fun onError(error: String) {
        Log.e(TAG, "Wake-word engine error: $error")
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        super.onDestroy()
        stopForegroundListening()
        serviceScope.cancel()
        Log.d(TAG, "AtlasWakeWordService destroyed")
    }
}
