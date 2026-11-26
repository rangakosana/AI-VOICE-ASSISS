package com.atlas.ai.audio

import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioRecord
import android.util.Log
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlin.math.max
import kotlin.math.sqrt

/**
 * High-performance, low-latency Audio Recorder streaming raw 16kHz PCM chunks
 * for ATLAS real-time bidirectional voice interaction.
 *
 * Implements:
 * 1. 25-30s max utterance duration cap (defaults to 28000ms).
 * 2. Adaptive silence/end-of-turn timeout (2500ms) with initial ambient noise floor calibration (300ms).
 * 3. Sustained speech detection (>=300ms) during assistant speaking for clean barge-in interruption.
 * 4. Reactive RMS calculation for UI visualizers.
 */
class AudioRecorder(
    private val context: Context,
    private val coroutineScope: CoroutineScope
) {
    companion object {
        private const val TAG = "AudioRecorder"
        const val DEFAULT_MAX_UTTERANCE_CAP_MS = 28000L
        const val DEFAULT_SILENCE_TIMEOUT_MS = 2500L
        const val CALIBRATION_DURATION_MS = 300L
        const val SUSTAINED_BARGE_IN_MS = 300L
    }

    private var audioRecord: AudioRecord? = null
    private var recordingJob: Job? = null

    private val _audioChunks = MutableSharedFlow<ByteArray>(extraBufferCapacity = 64)
    val audioChunks: SharedFlow<ByteArray> = _audioChunks.asSharedFlow()

    private val _isRecording = MutableStateFlow(false)
    val isRecording: StateFlow<Boolean> = _isRecording.asStateFlow()

    private val _audioLevelRms = MutableStateFlow(0f)
    val audioLevelRms: StateFlow<Float> = _audioLevelRms.asStateFlow()

    // Turn timing and adaptive VAD properties
    var maxUtteranceCapMs: Long = DEFAULT_MAX_UTTERANCE_CAP_MS
    var silenceTimeoutMs: Long = DEFAULT_SILENCE_TIMEOUT_MS

    var onSilenceTimeout: (() -> Unit)? = null
    var onMaxUtteranceTimeout: (() -> Unit)? = null
    var onBargeIn: (() -> Unit)? = null

    private var recordingStartTimeMs = 0L
    private var calibrationEndTimeMs = 0L
    private var lastSpeechTimeMs = 0L
    private var hasDetectedSpeech = false
    private var noiseFloor = 0.01f
    private var isAssistantSpeaking = false
    private var sustainedSpeechStartMs = 0L

    fun setAssistantSpeaking(speaking: Boolean) {
        isAssistantSpeaking = speaking
        if (!speaking) {
            sustainedSpeechStartMs = 0L
        }
    }

    /**
     * Checks if RECORD_AUDIO permission has been granted by user.
     */
    fun hasPermission(): Boolean {
        return ContextCompat.checkSelfPermission(
            context,
            android.Manifest.permission.RECORD_AUDIO
        ) == PackageManager.PERMISSION_GRANTED
    }

    /**
     * Starts continuous audio capture and emits 16-bit PCM chunks to [audioChunks].
     */
    @SuppressLint("MissingPermission")
    @Synchronized
    fun startRecording(onChunkCaptured: ((ByteArray) -> Unit)? = null): Boolean {
        if (_isRecording.value) {
            return true
        }

        if (!hasPermission()) {
            return false
        }

        val minBufferSize = AudioRecord.getMinBufferSize(
            AudioConfig.SAMPLE_RATE_HZ,
            AudioConfig.CHANNEL_CONFIG,
            AudioConfig.AUDIO_FORMAT
        )

        if (minBufferSize <= 0) {
            return false
        }

        val bufferSize = max(minBufferSize * 2, AudioConfig.CHUNK_SIZE_BYTES * 2)

        try {
            audioRecord = AudioRecord(
                AudioConfig.AUDIO_SOURCE,
                AudioConfig.SAMPLE_RATE_HZ,
                AudioConfig.CHANNEL_CONFIG,
                AudioConfig.AUDIO_FORMAT,
                bufferSize
            )

            if (audioRecord?.state != AudioRecord.STATE_INITIALIZED) {
                audioRecord?.release()
                audioRecord = null
                return false
            }

            audioRecord?.startRecording()
            _isRecording.value = true

            // Reset turn timing & VAD tracking
            val now = System.currentTimeMillis()
            recordingStartTimeMs = now
            calibrationEndTimeMs = now + CALIBRATION_DURATION_MS
            lastSpeechTimeMs = now
            hasDetectedSpeech = false
            sustainedSpeechStartMs = 0L
            noiseFloor = 0.01f

            recordingJob = coroutineScope.launch(Dispatchers.IO) {
                val readBuffer = ByteArray(AudioConfig.CHUNK_SIZE_BYTES)

                while (isActive && _isRecording.value) {
                    val bytesRead = audioRecord?.read(readBuffer, 0, readBuffer.size) ?: -1

                    if (bytesRead > 0) {
                        val chunkCopy = readBuffer.copyOf(bytesRead)
                        val rms = calculateRms(chunkCopy)
                        _audioChunks.emit(chunkCopy)
                        onChunkCaptured?.invoke(chunkCopy)

                        processVadAndTurnTiming(rms)
                    } else if (bytesRead == AudioRecord.ERROR_INVALID_OPERATION ||
                               bytesRead == AudioRecord.ERROR_BAD_VALUE) {
                        break
                    }
                }
            }

            return true
        } catch (e: Exception) {
            Log.e(TAG, "Exception starting AudioRecord", e)
            stopRecording()
            return false
        }
    }

    /**
     * Analyzes chunk RMS level against noise floor and triggers turn completion or barge-in callbacks.
     */
    private fun processVadAndTurnTiming(rms: Float) {
        val now = System.currentTimeMillis()

        if (now < calibrationEndTimeMs) {
            // Noise floor calibration during initial 300ms
            if (rms > 0f) {
                noiseFloor = minOf(noiseFloor, rms)
            }
            return
        }

        // Adaptive threshold based on calibrated noise floor
        val dynamicThreshold = maxOf(0.015f, noiseFloor * 1.8f)
        val isSpeech = rms >= dynamicThreshold

        if (isAssistantSpeaking) {
            // Sustained speech detection while assistant speaks -> barge-in
            if (isSpeech) {
                if (sustainedSpeechStartMs == 0L) {
                    sustainedSpeechStartMs = now
                } else if (now - sustainedSpeechStartMs >= SUSTAINED_BARGE_IN_MS) {
                    Log.i(TAG, "Sustained barge-in speech detected (RMS=$rms, thresh=$dynamicThreshold)")
                    sustainedSpeechStartMs = 0L
                    onBargeIn?.invoke()
                }
            } else {
                sustainedSpeechStartMs = 0L
            }
        } else {
            if (isSpeech) {
                hasDetectedSpeech = true
                lastSpeechTimeMs = now
            } else if (hasDetectedSpeech) {
                if (now - lastSpeechTimeMs >= silenceTimeoutMs) {
                    Log.i(TAG, "Silence pause detected after speech (${silenceTimeoutMs}ms)")
                    onSilenceTimeout?.invoke()
                }
            }
        }

        // Enforce maximum utterance cap (28 seconds)
        if (now - recordingStartTimeMs >= maxUtteranceCapMs) {
            Log.i(TAG, "Max utterance limit reached (${maxUtteranceCapMs}ms)")
            onMaxUtteranceTimeout?.invoke()
        }
    }

    /**
     * Stops active audio capture and releases native AudioRecord resources.
     */
    @Synchronized
    fun stopRecording() {
        _isRecording.value = false
        _audioLevelRms.value = 0f
        sustainedSpeechStartMs = 0L
        hasDetectedSpeech = false

        recordingJob?.cancel()
        recordingJob = null

        try {
            audioRecord?.let { record ->
                if (record.recordingState == AudioRecord.RECORDSTATE_RECORDING) {
                    record.stop()
                }
                record.release()
            }
        } catch (_: Exception) {
            // Ignore clean shutdown exceptions
        } finally {
            audioRecord = null
        }
    }

    /**
     * Computes RMS audio amplitude normalized between 0.0 and 1.0 for UI audio visualizer.
     */
    private fun calculateRms(buffer: ByteArray): Float {
        if (buffer.isEmpty()) {
            _audioLevelRms.value = 0f
            return 0f
        }

        var sumSquare = 0.0
        val sampleCount = buffer.size / 2

        for (i in 0 until sampleCount) {
            val sample = (buffer[i * 2 + 1].toInt() shl 8) or (buffer[i * 2].toInt() and 0xFF)
            sumSquare += (sample.toShort() * sample.toShort()).toDouble()
        }

        val rms = sqrt(sumSquare / sampleCount)
        // Normalize against max 16-bit short value (32767)
        val normalized = (rms / 32767.0).coerceIn(0.0, 1.0).toFloat()
        _audioLevelRms.value = normalized
        return normalized
    }
}
