package com.atlas.ai.network

import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * ATLAS WebSocket Client for Android.
 *
 * Implements real-time bidirectional communication with the ATLAS Fastify gateway.
 * Supports JSON control messages, binary PCM audio streaming, barge-in interrupts,
 * adaptive neural TTS chunk playback (Telugu & English), and automatic exponential backoff reconnection.
 */
class AtlasWebSocketClient(
    private val coroutineScope: CoroutineScope,
    private val okHttpClient: OkHttpClient = createDefaultOkHttpClient()
) {
    companion object {
        private const val TAG = "AtlasWebSocketClient"
        const val DEFAULT_CLOUD_URL = "wss://ai-voice-assiss.onrender.com/v1/realtime"
        const val DEFAULT_EMULATOR_URL = "ws://10.0.2.2:3000/v1/realtime"
        const val DEFAULT_LOCALHOST_URL = "ws://127.0.0.1:3000/v1/realtime"
        const val DEFAULT_PHYSICAL_DEVICE_URL = "ws://192.168.137.57:3000/v1/realtime"
        const val SERVER_URL = DEFAULT_CLOUD_URL

        private const val INITIAL_BACKOFF_MS = 1000L
        private const val MAX_BACKOFF_MS = 16000L
        private const val BACKOFF_MULTIPLIER = 2.0

        fun createDefaultOkHttpClient(): OkHttpClient {
            return OkHttpClient.Builder()
                .readTimeout(0, TimeUnit.MILLISECONDS) // Keep-alive for WebSockets
                .writeTimeout(10, TimeUnit.SECONDS)
                .connectTimeout(10, TimeUnit.SECONDS)
                .pingInterval(15, TimeUnit.SECONDS)
                .retryOnConnectionFailure(true)
                .build()
        }
    }

    enum class ConnectionStatus {
        DISCONNECTED,
        CONNECTING,
        CONNECTED,
        RECONNECTING
    }

    enum class AssistantState {
        IDLE,
        LISTENING,
        THINKING,
        SPEAKING
    }

    // State Flows
    private val _connectionStatus = MutableStateFlow(ConnectionStatus.DISCONNECTED)
    val connectionStatus: StateFlow<ConnectionStatus> = _connectionStatus.asStateFlow()

    private val _assistantState = MutableStateFlow(AssistantState.IDLE)
    val assistantState: StateFlow<AssistantState> = _assistantState.asStateFlow()

    private val _currentSessionId = MutableStateFlow<String?>(null)
    val currentSessionId: StateFlow<String?> = _currentSessionId.asStateFlow()

    private val _currentLanguage = MutableStateFlow("en")
    val currentLanguage: StateFlow<String> = _currentLanguage.asStateFlow()

    private val _currentStreamingText = MutableStateFlow("")
    val currentStreamingText: StateFlow<String> = _currentStreamingText.asStateFlow()

    private val _serverEvents = MutableSharedFlow<ServerMessage>(extraBufferCapacity = 64)
    val serverEvents: SharedFlow<ServerMessage> = _serverEvents.asSharedFlow()

    private val _incomingAudioChunks = MutableSharedFlow<ByteArray>(extraBufferCapacity = 64)
    val incomingAudioChunks: SharedFlow<ByteArray> = _incomingAudioChunks.asSharedFlow()

    private val _incomingServerAudioChunks = MutableSharedFlow<ServerAudioChunk>(extraBufferCapacity = 64)
    val incomingServerAudioChunks: SharedFlow<ServerAudioChunk> = _incomingServerAudioChunks.asSharedFlow()

    // Internal WebSocket references
    private var webSocket: WebSocket? = null
    private var serverUrl: String = DEFAULT_CLOUD_URL
    private val isExplicitDisconnect = AtomicBoolean(false)
    private var reconnectJob: Job? = null
    private var currentBackoffMs = INITIAL_BACKOFF_MS

    /**
     * Connect to the ATLAS Real-time Gateway WebSocket endpoint.
     */
    fun connect(url: String = DEFAULT_CLOUD_URL) {
        serverUrl = url
        isExplicitDisconnect.set(false)
        reconnectJob?.cancel()
        currentBackoffMs = INITIAL_BACKOFF_MS

        initiateConnection()
    }

    private fun initiateConnection() {
        if (_connectionStatus.value == ConnectionStatus.CONNECTED) {
            return
        }

        _connectionStatus.value = if (currentBackoffMs > INITIAL_BACKOFF_MS) {
            ConnectionStatus.RECONNECTING
        } else {
            ConnectionStatus.CONNECTING
        }

        try {
            val request = Request.Builder()
                .url(serverUrl)
                .build()

            webSocket = okHttpClient.newWebSocket(request, object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    Log.d(TAG, "WebSocket connected successfully to $serverUrl")
                    _connectionStatus.value = ConnectionStatus.CONNECTED
                    currentBackoffMs = INITIAL_BACKOFF_MS
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    handleTextMessage(text)
                }

                override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                    handleBinaryMessage(bytes.toByteArray())
                }

                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                    Log.d(TAG, "WebSocket closing: code=$code, reason=$reason")
                    webSocket.close(1000, null)
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    Log.d(TAG, "WebSocket closed: code=$code, reason=$reason")
                    _connectionStatus.value = ConnectionStatus.DISCONNECTED
                    if (!isExplicitDisconnect.get()) {
                        scheduleReconnect()
                    }
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    Log.e(TAG, "WebSocket failure: ${t.message}", t)
                    _connectionStatus.value = ConnectionStatus.DISCONNECTED
                    if (!isExplicitDisconnect.get()) {
                        scheduleReconnect()
                    }
                }
            })
        } catch (e: Exception) {
            Log.e(TAG, "Failed to initiate WebSocket connection", e)
            _connectionStatus.value = ConnectionStatus.DISCONNECTED
            if (!isExplicitDisconnect.get()) {
                scheduleReconnect()
            }
        }
    }

    /**
     * Disconnect cleanly from the WebSocket server.
     */
    fun disconnect() {
        isExplicitDisconnect.set(true)
        reconnectJob?.cancel()
        reconnectJob = null

        val sessionId = _currentSessionId.value
        if (sessionId != null) {
            try {
                val endMsg = ClientSessionEnd(sessionId = sessionId)
                webSocket?.send(ProtocolParser.toJson(endMsg))
            } catch (_: Exception) {}
        }

        webSocket?.close(1000, "Normal closure by user")
        webSocket = null
        _connectionStatus.value = ConnectionStatus.DISCONNECTED
        _assistantState.value = AssistantState.IDLE
        _currentSessionId.value = null
    }

    fun getServerUrl(): String = serverUrl

    fun setServerUrl(url: String) {
        if (serverUrl != url) {
            disconnect()
            connect(url)
        }
    }

    /**
     * Ends the active session cleanly and clears session ID.
     */
    fun endSession(reason: String = "user_reset") {
        val sessionId = _currentSessionId.value ?: return
        try {
            val endMsg = ClientSessionEnd(
                sessionId = sessionId,
                payload = ClientSessionEnd.Payload(reason = reason)
            )
            sendJson(ProtocolParser.toJson(endMsg))
        } catch (_: Exception) {}
        _currentSessionId.value = null
        _assistantState.value = AssistantState.IDLE
    }

    /**
     * Sends a start session handshake to initialize memory and conversation state.
     */
    fun startSession(language: String = _currentLanguage.value, clientVersion: String = "0.1.0") {
        val msg = ClientSessionStart(
            payload = ClientSessionStart.Payload(
                clientName = "ATLAS-Android",
                clientVersion = clientVersion,
                language = language
            )
        )
        sendJson(ProtocolParser.toJson(msg))
    }

    /**
     * Sends a text message to ATLAS.
     */
    fun sendMessage(text: String) {
        val sessionId = _currentSessionId.value ?: return
        val msg = ClientMessageSend(
            sessionId = sessionId,
            payload = ClientMessageSend.Payload(text = text)
        )
        sendJson(ProtocolParser.toJson(msg))
    }

    /**
     * Sends a barge-in interrupt signal to cancel in-flight model response generation.
     */
    fun sendInterrupt(reason: String = "user_barge_in") {
        val sessionId = _currentSessionId.value ?: return
        val msg = ClientInterrupt(
            sessionId = sessionId,
            payload = ClientInterrupt.Payload(reason = reason)
        )
        sendJson(ProtocolParser.toJson(msg))
        _assistantState.value = AssistantState.IDLE
    }

    /**
     * Commits spoken audio input, prompting the backend to process speech and stream response.
     */
    fun sendVoiceCommit(userText: String? = null) {
        val sessionId = _currentSessionId.value ?: return
        val msg = ClientVoiceCommit(
            sessionId = sessionId,
            payload = ClientVoiceCommit.Payload(text = userText)
        )
        sendJson(ProtocolParser.toJson(msg))
        _assistantState.value = AssistantState.THINKING
    }

    /**
     * Sends session audio parameters (16kHz PCM mono).
     */
    fun sendSessionUpdate(sampleRate: Int = 16000, audioFormat: String = "pcm16") {
        val sessionId = _currentSessionId.value ?: return
        val msg = SessionUpdate(
            sessionId = sessionId,
            payload = SessionUpdate.Payload(
                audioFormat = audioFormat,
                sampleRate = sampleRate,
                channels = 1,
                language = _currentLanguage.value
            )
        )
        sendJson(ProtocolParser.toJson(msg))
    }

    /**
     * Streams a raw binary PCM audio frame to the backend.
     */
    fun sendAudioChunk(byteArray: ByteArray): Boolean {
        if (_connectionStatus.value != ConnectionStatus.CONNECTED) {
            return false
        }
        val byteString = byteArray.toByteString()
        return webSocket?.send(byteString) ?: false
    }

    fun setAssistantState(state: AssistantState) {
        _assistantState.value = state
    }

    fun setLanguage(lang: String) {
        _currentLanguage.value = lang
    }

    private fun sendJson(jsonString: String): Boolean {
        if (_connectionStatus.value != ConnectionStatus.CONNECTED) {
            Log.w(TAG, "Cannot send message while not connected: $jsonString")
            return false
        }
        return webSocket?.send(jsonString) ?: false
    }

    private fun handleTextMessage(text: String) {
        val message = ProtocolParser.parseServerMessage(text) ?: return

        coroutineScope.launch {
            _serverEvents.emit(message)

            when (message) {
                is ServerReady -> {
                    // Gateway is ready, initiate session handshake
                    startSession()
                }

                is ServerSessionStarted -> {
                    _currentSessionId.value = message.sessionId
                    // Configure audio pipeline on gateway
                    sendSessionUpdate(sampleRate = 16000, audioFormat = "pcm16")
                }

                is ServerSessionEnded -> {
                    _currentSessionId.value = null
                    _assistantState.value = AssistantState.IDLE
                }

                is ServerResponseStarted -> {
                    _currentStreamingText.value = ""
                    _assistantState.value = AssistantState.SPEAKING
                }

                is ServerResponseDelta -> {
                    _currentStreamingText.value += message.payload.delta
                }

                is ServerResponseCompleted -> {
                    _currentStreamingText.value = message.payload.text
                    _assistantState.value = AssistantState.IDLE
                }

                is ServerResponseCancelled,
                is ServerGenerationCancelled -> {
                    Log.d(TAG, "Generation cancelled by server barge-in confirmation")
                    _assistantState.value = AssistantState.IDLE
                }

                is ServerTranscript -> {
                    if (message.payload.isFinal) {
                        _assistantState.value = AssistantState.THINKING
                    }
                }

                is ServerAudioChunk -> {
                    // Track active synthesis language (te or en)
                    message.payload.language?.let { lang ->
                        if (lang.isNotBlank()) {
                            _currentLanguage.value = lang
                        }
                    }
                    _incomingServerAudioChunks.emit(message)
                }

                is ServerError -> {
                    Log.e(TAG, "Server error: ${message.payload.code} - ${message.payload.message}")
                }

                else -> {
                    Log.d(TAG, "Received message: ${message.type}")
                }
            }
        }
    }

    private fun handleBinaryMessage(bytes: ByteArray) {
        coroutineScope.launch {
            _incomingAudioChunks.emit(bytes)
        }
    }

    private fun scheduleReconnect() {
        if (isExplicitDisconnect.get()) return

        reconnectJob?.cancel()
        reconnectJob = coroutineScope.launch(Dispatchers.IO) {
            Log.d(TAG, "Reconnecting in ${currentBackoffMs}ms...")
            delay(currentBackoffMs)

            // Exponential backoff with ceiling
            currentBackoffMs = (currentBackoffMs * BACKOFF_MULTIPLIER)
                .toLong()
                .coerceAtMost(MAX_BACKOFF_MS)

            if (isActive && !isExplicitDisconnect.get()) {
                initiateConnection()
            }
        }
    }
}
