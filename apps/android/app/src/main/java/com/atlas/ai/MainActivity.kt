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
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import com.atlas.ai.audio.AndroidSpeechRecognizer
import com.atlas.ai.audio.NeuralAudioPlayer
import com.atlas.ai.network.AtlasWebSocketClient
import com.atlas.ai.service.AtlasWakeWordService
import com.atlas.ai.ui.ListeningScreen
import com.atlas.ai.ui.theme.AtlasTheme
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {

    private lateinit var webSocketClient: AtlasWebSocketClient
    private lateinit var speechRecognizer: AndroidSpeechRecognizer
    private lateinit var audioPlayer: NeuralAudioPlayer

    private var currentServerUrl by mutableStateOf(AtlasWebSocketClient.SERVER_URL)
    private var isRecording by mutableStateOf(false)
    private var liveAudioRms by mutableFloatStateOf(0f)
    private var liveStreamingText by mutableStateOf("")
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

        // 2. Load persisted server URL or fallback to Cloud default
        val savedUrl = sharedPrefs.getString("server_url", AtlasWebSocketClient.SERVER_URL)
            ?: AtlasWebSocketClient.SERVER_URL
        currentServerUrl = savedUrl

        // 3. Initialize WebSocket client and Neural Audio player
        webSocketClient = AtlasWebSocketClient(lifecycleScope)
        audioPlayer = NeuralAudioPlayer(this, lifecycleScope) { isPlaying ->
            if (!isPlaying && webSocketClient.assistantState.value == AtlasWebSocketClient.AssistantState.SPEAKING) {
                webSocketClient.setAssistantState(AtlasWebSocketClient.AssistantState.IDLE)
                // Resume wake word if it was paused during interaction
                if (wasWakeWordActive && !isRecording) {
                    wasWakeWordActive = false
                    AtlasWakeWordService.start(this)
                }
            }
        }

        // 4. Initialize Native Android Speech Recognizer (STT Engine)
        speechRecognizer = AndroidSpeechRecognizer(
            context = this,
            onPartialText = { partial ->
                runOnUiThread {
                    liveStreamingText = "YOU: $partial"
                }
            },
            onFinalText = { final ->
                runOnUiThread {
                    isRecording = false
                    liveAudioRms = 0f
                    liveStreamingText = "YOU: $final\n\nATLAS: (Thinking...)"
                    webSocketClient.sendVoiceCommit(final)
                }
            },
            onRmsChanged = { rms ->
                runOnUiThread {
                    liveAudioRms = rms
                }
            },
            onError = { errMsg ->
                runOnUiThread {
                    isRecording = false
                    liveAudioRms = 0f
                    if (liveStreamingText.startsWith("YOU:")) {
                        liveStreamingText = errMsg
                    }
                    if (webSocketClient.assistantState.value == AtlasWebSocketClient.AssistantState.LISTENING) {
                        webSocketClient.setAssistantState(AtlasWebSocketClient.AssistantState.IDLE)
                    }
                    if (wasWakeWordActive && !isRecording) {
                        wasWakeWordActive = false
                        AtlasWakeWordService.start(this)
                    }
                }
            }
        )

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
                val serverStreamingText by webSocketClient.currentStreamingText.collectAsState()
                val sessionId by webSocketClient.currentSessionId.collectAsState()
                val currentLanguage by webSocketClient.currentLanguage.collectAsState()
                val isWakeWordRunning by AtlasWakeWordService.isServiceRunning.collectAsState()

                // Display server streaming text when assistant is speaking, otherwise show live user mic text
                val displayedText = if (assistantState == AtlasWebSocketClient.AssistantState.SPEAKING ||
                                       assistantState == AtlasWebSocketClient.AssistantState.THINKING) {
                    if (serverStreamingText.isNotBlank()) "ATLAS: $serverStreamingText" else liveStreamingText
                } else {
                    if (liveStreamingText.isNotBlank()) liveStreamingText else serverStreamingText
                }

                ListeningScreen(
                    connectionStatus = connectionStatus,
                    assistantState = assistantState,
                    isRecording = isRecording,
                    audioRms = liveAudioRms,
                    streamingText = displayedText,
                    sessionId = sessionId,
                    serverUrl = currentServerUrl,
                    currentLanguage = currentLanguage,
                    isWakeWordRunning = isWakeWordRunning,
                    onSendMessage = { text ->
                        audioPlayer.stop()
                        liveStreamingText = "YOU: $text"
                        webSocketClient.sendMessage(text)
                    },
                    onToggleRecording = {
                        if (isRecording) {
                            stopVoiceCapture()
                        } else {
                            if (hasAllPermissions()) {
                                startVoiceCapture()
                            } else {
                                requestRequiredPermissions()
                            }
                        }
                    },
                    onInterrupt = {
                        // Instant barge-in: stop both audio playback and active backend generation
                        audioPlayer.stop()
                        speechRecognizer.cancel()
                        isRecording = false
                        liveAudioRms = 0f
                        webSocketClient.sendInterrupt(reason = "user_barge_in")
                    },
                    onNewSession = {
                        audioPlayer.stop()
                        speechRecognizer.cancel()
                        isRecording = false
                        liveAudioRms = 0f
                        liveStreamingText = ""
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
            if (hasAllPermissions()) {
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

        // Temporarily pause wake-word service so mic is 100% free
        if (AtlasWakeWordService.isServiceRunning.value) {
            wasWakeWordActive = true
            AtlasWakeWordService.stop(this)
        }

        isRecording = true
        webSocketClient.setAssistantState(AtlasWebSocketClient.AssistantState.LISTENING)
        liveStreamingText = "Listening..."

        val lang = if (webSocketClient.currentLanguage.value == "te") "te-IN" else "en-IN"
        speechRecognizer.startListening(lang)
    }

    private fun stopVoiceCapture() {
        speechRecognizer.stopListening()
    }

    override fun onDestroy() {
        super.onDestroy()
        audioPlayer.release()
        speechRecognizer.cancel()
        webSocketClient.disconnect()
    }
}
