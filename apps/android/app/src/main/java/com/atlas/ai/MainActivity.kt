package com.atlas.ai

import android.Manifest
import android.app.KeyguardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import com.atlas.ai.audio.AudioRecorder
import com.atlas.ai.audio.NeuralAudioPlayer
import com.atlas.ai.network.AtlasWebSocketClient
import com.atlas.ai.service.AtlasWakeWordService
import com.atlas.ai.ui.ListeningScreen
import com.atlas.ai.ui.theme.AtlasTheme
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {

    private lateinit var webSocketClient: AtlasWebSocketClient
    private lateinit var audioRecorder: AudioRecorder
    private lateinit var audioPlayer: NeuralAudioPlayer
    private var currentServerUrl by mutableStateOf(AtlasWebSocketClient.SERVER_URL)
    private var wasWakeWordActive = false

    private val sharedPrefs by lazy {
        getSharedPreferences("atlas_prefs", Context.MODE_PRIVATE)
    }

    // Permission launcher supporting RECORD_AUDIO and POST_NOTIFICATIONS
    private val permissionsLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { permissions ->
        val recordAudioGranted = permissions[Manifest.permission.RECORD_AUDIO] == true
        if (recordAudioGranted) {
            Toast.makeText(this, "Microphone permission granted.", Toast.LENGTH_SHORT).show()
        } else {
            Toast.makeText(
                this,
                "Microphone permission is required for ATLAS voice interaction.",
                Toast.LENGTH_LONG
            ).show()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)

        // 1. Configure Lock-Screen, Turn-Screen-On, and Keyguard Dismissal
        configureLockScreenDisplay()

        // 2. Load persisted server URL or fallback to physical LAN default
        val savedUrl = sharedPrefs.getString("server_url", AtlasWebSocketClient.SERVER_URL)
            ?: AtlasWebSocketClient.SERVER_URL
        currentServerUrl = savedUrl

        // 3. Initialize network, recorder, and neural audio player engines
        webSocketClient = AtlasWebSocketClient(lifecycleScope)
        audioRecorder = AudioRecorder(this, lifecycleScope)
        audioPlayer = NeuralAudioPlayer(this, lifecycleScope) { isPlaying ->
            audioRecorder.setAssistantSpeaking(isPlaying)

            if (!isPlaying && webSocketClient.assistantState.value == AtlasWebSocketClient.AssistantState.SPEAKING) {
                webSocketClient.setAssistantState(AtlasWebSocketClient.AssistantState.IDLE)
                // Resume wake word if it was paused during interaction
                if (wasWakeWordActive && !audioRecorder.isRecording.value) {
                    wasWakeWordActive = false
                    AtlasWakeWordService.start(this)
                }
            }
        }

        // 4. Wire AudioRecorder turn timing and barge-in callbacks
        audioRecorder.onSilenceTimeout = {
            runOnUiThread {
                if (audioRecorder.isRecording.value) {
                    stopVoiceCapture()
                }
            }
        }

        audioRecorder.onMaxUtteranceTimeout = {
            runOnUiThread {
                if (audioRecorder.isRecording.value) {
                    stopVoiceCapture()
                }
            }
        }

        audioRecorder.onBargeIn = {
            runOnUiThread {
                audioPlayer.stop()
                webSocketClient.sendInterrupt(reason = "user_barge_in")
                if (audioRecorder.isRecording.value) {
                    stopVoiceCapture()
                    startVoiceCapture()
                }
            }
        }

        // 5. Collect neural audio chunks (MP3 base64) streamed from backend
        lifecycleScope.launch {
            webSocketClient.incomingServerAudioChunks.collect { chunk ->
                audioPlayer.enqueueChunk(
                    base64Audio = chunk.payload.audio,
                    index = chunk.payload.index,
                    text = chunk.payload.text
                )
            }
        }

        // 6. Connect to ATLAS Gateway
        webSocketClient.connect(currentServerUrl)

        // 7. Handle intent if launched directly from wake-word service
        handleIncomingIntent(intent)

        setContent {
            AtlasTheme {
                val connectionStatus by webSocketClient.connectionStatus.collectAsState()
                val assistantState by webSocketClient.assistantState.collectAsState()
                val isRecording by audioRecorder.isRecording.collectAsState()
                val audioRms by audioRecorder.audioLevelRms.collectAsState()
                val streamingText by webSocketClient.currentStreamingText.collectAsState()
                val sessionId by webSocketClient.currentSessionId.collectAsState()
                val currentLanguage by webSocketClient.currentLanguage.collectAsState()
                val isWakeWordRunning by AtlasWakeWordService.isServiceRunning.collectAsState()

                ListeningScreen(
                    connectionStatus = connectionStatus,
                    assistantState = assistantState,
                    isRecording = isRecording,
                    audioRms = audioRms,
                    streamingText = streamingText,
                    sessionId = sessionId,
                    serverUrl = currentServerUrl,
                    currentLanguage = currentLanguage,
                    isWakeWordRunning = isWakeWordRunning,
                    onSendMessage = { text ->
                        audioPlayer.stop()
                        webSocketClient.sendMessage(text)
                    },
                    onToggleRecording = {
                        if (isRecording) {
                            stopVoiceCapture()
                        } else {
                            if (audioRecorder.hasPermission()) {
                                startVoiceCapture()
                            } else {
                                requestRequiredPermissions()
                            }
                        }
                    },
                    onInterrupt = {
                        // Instant barge-in: stop both audio playback and active backend generation
                        audioPlayer.stop()
                        webSocketClient.sendInterrupt(reason = "user_barge_in")
                    },
                    onNewSession = {
                        audioPlayer.stop()
                        webSocketClient.endSession(reason = "user_reset")
                        webSocketClient.startSession()
                    },
                    onReconnect = {
                        webSocketClient.connect(currentServerUrl)
                    },
                    onChangeServerUrl = { newUrl ->
                        currentServerUrl = newUrl
                        sharedPrefs.edit().putString("server_url", newUrl).apply()
                        webSocketClient.setServerUrl(newUrl)
                    },
                    onToggleWakeWord = { enable ->
                        toggleWakeWordService(enable)
                    }
                )
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIncomingIntent(intent)
    }

    private fun handleIncomingIntent(intent: Intent?) {
        if (intent == null) return
        val isWakeWordTriggered =
            intent.action == AtlasWakeWordService.ACTION_WAKE_WORD_TRIGGERED ||
            intent.getBooleanExtra("EXTRA_AUTO_START_LISTENING", false)

        if (isWakeWordTriggered) {
            val keyword = intent.getStringExtra("EXTRA_WAKE_KEYWORD") ?: "Hey Atlas"
            Toast.makeText(this, "$keyword activated! Listening...", Toast.LENGTH_SHORT).show()
            audioPlayer.stop()
            if (audioRecorder.hasPermission()) {
                startVoiceCapture()
            }
        }
    }

    private fun toggleWakeWordService(enable: Boolean) {
        if (enable) {
            if (hasAllPermissions()) {
                AtlasWakeWordService.start(this)
            } else {
                requestRequiredPermissions()
            }
        } else {
            AtlasWakeWordService.stop(this)
        }
    }

    private fun hasAllPermissions(): Boolean {
        val audioGranted = ContextCompat.checkSelfPermission(
            this,
            Manifest.permission.RECORD_AUDIO
        ) == PackageManager.PERMISSION_GRANTED

        val notifGranted = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            ContextCompat.checkSelfPermission(
                this,
                Manifest.permission.POST_NOTIFICATIONS
            ) == PackageManager.PERMISSION_GRANTED
        } else {
            true
        }

        return audioGranted && notifGranted
    }

    private fun requestRequiredPermissions() {
        val perms = mutableListOf(Manifest.permission.RECORD_AUDIO)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            perms.add(Manifest.permission.POST_NOTIFICATIONS)
        }
        permissionsLauncher.launch(perms.toTypedArray())
    }

    private fun configureLockScreenDisplay() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        } else {
            @Suppress("DEPRECATION")
            window.addFlags(
                WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
                WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
            )
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val keyguardManager = getSystemService(Context.KEYGUARD_SERVICE) as? KeyguardManager
            keyguardManager?.requestDismissKeyguard(this, null)
        } else {
            @Suppress("DEPRECATION")
            window.addFlags(WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD)
        }

        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }

    private fun startVoiceCapture() {
        // Barge-in: Stop any currently speaking audio immediately
        audioPlayer.stop()

        // Temporarily pause wake-word service to prevent mic access conflicts
        if (AtlasWakeWordService.isServiceRunning.value) {
            wasWakeWordActive = true
            AtlasWakeWordService.stop(this)
        }

        val started = audioRecorder.startRecording { chunk ->
            // Stream raw 16kHz PCM audio chunk directly over WebSocket
            webSocketClient.sendAudioChunk(chunk)
        }
        if (started) {
            webSocketClient.setAssistantState(AtlasWebSocketClient.AssistantState.LISTENING)
        }
    }

    private fun stopVoiceCapture() {
        audioRecorder.stopRecording()
        // Commit voice turn to backend so speech is transcribed and answered
        webSocketClient.sendVoiceCommit()
    }

    override fun onDestroy() {
        super.onDestroy()
        audioPlayer.release()
        audioRecorder.stopRecording()
        webSocketClient.disconnect()
    }
}
