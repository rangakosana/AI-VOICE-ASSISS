package com.atlas.ai.audio

import android.content.Context
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.sqrt

/**
 * Interface for Wake-Word detection events.
 */
interface WakeWordListener {
    /**
     * Fired when "Hey Atlas" or "OK Atlas" is detected.
     */
    fun onWakeWordDetected(keyword: String, audioSample: ByteArray?)

    /**
     * Fired when audio energy transitions between speech and silence.
     */
    fun onSpeechActivityChanged(isSpeaking: Boolean) {}

    /**
     * Fired on engine error.
     */
    fun onError(error: String) {}
}

/**
 * Wake-Word Detection Engine for ATLAS on Android.
 *
 * Implements:
 * 1. Low-power Voice Activity Detection (VAD) energy gating.
 * 2. Pluggable on-device acoustic keyword spotting architecture for "Hey Atlas".
 * 3. Ring buffer maintenance to pass pre-roll speech audio to the WebSocket stream
 *    immediately upon wake-word confirmation so the user's first words aren't clipped.
 * 4. Dual-mode support: acoustic PCM frames + on-device SpeechRecognizer listener.
 */
class WakeWordEngine(
    private val coroutineScope: CoroutineScope,
    private val listener: WakeWordListener,
    private val context: Context? = null
) {
    companion object {
        private const val TAG = "WakeWordEngine"
        const val WAKE_WORD_PRIMARY = "Hey Atlas"
        const val WAKE_WORD_SECONDARY = "OK Atlas"

        // Silence / VAD thresholds
        private const val ENERGY_THRESHOLD = 0.035f
        private const val SILENCE_DURATION_MS = 1800L
        private const val RING_BUFFER_CAPACITY = 20 // ~2 seconds of 100ms chunks
    }

    private val isListening = AtomicBoolean(false)
    private var processingJob: Job? = null

    // Ring buffer storing recent PCM frames for pre-roll capture
    private val ringBuffer = ArrayDeque<ByteArray>(RING_BUFFER_CAPACITY)

    private val _detectionEvents = MutableSharedFlow<String>(extraBufferCapacity = 16)
    val detectionEvents: SharedFlow<String> = _detectionEvents.asSharedFlow()

    private var lastSpeechTimestampMs = 0L
    private var isCurrentlySpeaking = false

    private var speechDetector: SpeechWakeWordDetector? = null

    init {
        context?.let { ctx ->
            speechDetector = SpeechWakeWordDetector(ctx) { kw ->
                triggerWakeWord(kw)
            }
        }
    }

    /**
     * Starts the wake-word engine.
     */
    fun startListening() {
        if (isListening.compareAndSet(false, true)) {
            Log.d(TAG, "WakeWordEngine listening started for '$WAKE_WORD_PRIMARY'")
            ringBuffer.clear()
            lastSpeechTimestampMs = System.currentTimeMillis()
            speechDetector?.startListening()
        }
    }

    /**
     * Stops the wake-word engine.
     */
    fun stopListening() {
        if (isListening.compareAndSet(true, false)) {
            Log.d(TAG, "WakeWordEngine listening stopped")
            processingJob?.cancel()
            processingJob = null
            ringBuffer.clear()
            speechDetector?.stopListening()
        }
    }

    /**
     * Ingests a raw 16kHz 16-bit PCM chunk from AudioRecord or AudioRecord foreground service.
     */
    fun processPcmChunk(chunk: ByteArray) {
        if (!isListening.get() || chunk.isEmpty()) return

        // 1. Maintain pre-roll audio ring buffer
        synchronized(ringBuffer) {
            if (ringBuffer.size >= RING_BUFFER_CAPACITY) {
                ringBuffer.removeFirst()
            }
            ringBuffer.addLast(chunk.copyOf())
        }

        // 2. Compute RMS energy for lightweight VAD
        val rms = calculateRms(chunk)
        val now = System.currentTimeMillis()

        if (rms > ENERGY_THRESHOLD) {
            lastSpeechTimestampMs = now
            if (!isCurrentlySpeaking) {
                isCurrentlySpeaking = true
                listener.onSpeechActivityChanged(true)
            }
        } else {
            if (isCurrentlySpeaking && (now - lastSpeechTimestampMs) > SILENCE_DURATION_MS) {
                isCurrentlySpeaking = false
                listener.onSpeechActivityChanged(false)
            }
        }

        // 3. Acoustic Keyword Spotter (Hook for Porcupine / PocketSphinx / Vosk / ONNX model)
        coroutineScope.launch(Dispatchers.Default) {
            if (isActive && isListening.get()) {
                evaluateKeywordAcoustics(chunk, rms)
            }
        }
    }

    /**
     * Simulates or executes keyword classifier scoring.
     */
    private fun evaluateKeywordAcoustics(chunk: ByteArray, rms: Float) {
        // Acoustic spotting hook
    }

    /**
     * Manually or programmatically triggers wake-word detection (e.g. from hotword service or test).
     */
    fun triggerWakeWord(keyword: String = WAKE_WORD_PRIMARY) {
        Log.i(TAG, "Wake-word triggered: $keyword")
        val preRollAudio = getPreRollAudio()
        listener.onWakeWordDetected(keyword, preRollAudio)
        _detectionEvents.tryEmit(keyword)
    }

    /**
     * Flushes and returns the combined pre-roll audio buffers.
     */
    fun getPreRollAudio(): ByteArray {
        synchronized(ringBuffer) {
            val totalBytes = ringBuffer.sumOf { it.size }
            val combined = ByteArray(totalBytes)
            var offset = 0
            for (buf in ringBuffer) {
                System.arraycopy(buf, 0, combined, offset, buf.size)
                offset += buf.size
            }
            return combined
        }
    }

    private fun calculateRms(buffer: ByteArray): Float {
        var sumSquare = 0.0
        val sampleCount = buffer.size / 2
        for (i in 0 until sampleCount) {
            val sample = (buffer[i * 2 + 1].toInt() shl 8) or (buffer[i * 2].toInt() and 0xFF)
            sumSquare += (sample.toShort() * sample.toShort()).toDouble()
        }
        val rms = sqrt(sumSquare / sampleCount)
        return (rms / 32767.0).coerceIn(0.0, 1.0).toFloat()
    }
}
