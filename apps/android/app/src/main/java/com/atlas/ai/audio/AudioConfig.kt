package com.atlas.ai.audio

import android.media.AudioFormat
import android.media.MediaRecorder

/**
 * Standard Audio Configuration for ATLAS Voice Pipeline.
 *
 * Requirements:
 * - 16 kHz sample rate (Gemini & ATLAS standard)
 * - 16-bit Linear PCM
 * - Single channel (Mono)
 * - 100ms buffer chunking (3200 bytes per frame) for low-latency streaming
 */
object AudioConfig {
    const val SAMPLE_RATE_HZ = 16000
    const val CHANNEL_CONFIG = AudioFormat.CHANNEL_IN_MONO
    const val AUDIO_FORMAT = AudioFormat.ENCODING_PCM_16BIT
    const val AUDIO_SOURCE = MediaRecorder.AudioSource.VOICE_RECOGNITION

    // Number of channels (Mono = 1)
    const val CHANNELS = 1

    // Bytes per sample for 16-bit PCM = 2 bytes
    const val BYTES_PER_SAMPLE = 2

    // 100ms frame chunk: 1600 samples * 2 bytes = 3200 bytes
    const val CHUNK_DURATION_MS = 100
    const val CHUNK_SIZE_BYTES = (SAMPLE_RATE_HZ * CHUNK_DURATION_MS / 1000) * BYTES_PER_SAMPLE
}

