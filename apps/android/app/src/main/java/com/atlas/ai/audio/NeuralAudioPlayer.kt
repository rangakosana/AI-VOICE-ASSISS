package com.atlas.ai.audio

import android.content.Context
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.util.Base64
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.io.File
import java.io.FileOutputStream
import java.util.ArrayDeque

/**
 * Sequential Neural Audio Player for ATLAS on Android.
 *
 * Implements:
 * 1. Sequential MP3 chunk playback queue: streams sentences as they arrive over WebSocket.
 * 2. Instant barge-in cancellation: immediately halts playback, releases MediaPlayer,
 *    and deletes temporary cache chunks when user speaks or clicks Interrupt.
 * 3. Reactive playback state updates: notifies UI/WebSocket client when Atlas starts or finishes speaking.
 */
class NeuralAudioPlayer(
    private val context: Context,
    private val coroutineScope: CoroutineScope,
    private val onPlaybackStateChanged: ((isPlaying: Boolean) -> Unit)? = null
) {
    companion object {
        private const val TAG = "NeuralAudioPlayer"
    }

    data class AudioChunkItem(
        val index: Int,
        val file: File,
        val text: String? = null
    )

    private val queue = ArrayDeque<AudioChunkItem>()
    private var mediaPlayer: MediaPlayer? = null
    private var currentPlayingItem: AudioChunkItem? = null

    private val _isPlaying = MutableStateFlow(false)
    val isPlaying: StateFlow<Boolean> = _isPlaying.asStateFlow()

    private val lock = Any()

    /**
     * Enqueues an incoming base64 MP3 audio chunk received from server.audio.chunk.
     */
    fun enqueueChunk(base64Audio: String, index: Int, text: String? = null) {
        if (base64Audio.isBlank()) return

        coroutineScope.launch(Dispatchers.IO) {
            try {
                val audioBytes = Base64.decode(base64Audio, Base64.DEFAULT)
                val tempFile = File.createTempFile("atlas_tts_${index}_", ".mp3", context.cacheDir)
                FileOutputStream(tempFile).use { fos ->
                    fos.write(audioBytes)
                    fos.flush()
                }

                val item = AudioChunkItem(index = index, file = tempFile, text = text)

                synchronized(lock) {
                    queue.add(item)
                    if (mediaPlayer == null && !_isPlaying.value) {
                        playNextChunk()
                    }
                }
            } catch (e: Exception) {
                Log.e(TAG, "Failed to decode/enqueue audio chunk $index", e)
            }
        }
    }

    /**
     * Plays the next audio chunk in the queue.
     * Must be called inside synchronized(lock) or safe thread context.
     */
    private fun playNextChunk() {
        val nextItem = queue.poll()
        if (nextItem == null) {
            _isPlaying.value = false
            currentPlayingItem = null
            onPlaybackStateChanged?.invoke(false)
            return
        }

        currentPlayingItem = nextItem
        _isPlaying.value = true
        onPlaybackStateChanged?.invoke(true)

        coroutineScope.launch(Dispatchers.Main) {
            try {
                mediaPlayer?.release()
                mediaPlayer = MediaPlayer().apply {
                    setAudioAttributes(
                        AudioAttributes.Builder()
                            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                            .setUsage(AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE)
                            .build()
                    )
                    setDataSource(nextItem.file.absolutePath)
                    setOnPreparedListener { mp ->
                        mp.start()
                    }
                    setOnCompletionListener {
                        cleanupCurrentFile()
                        synchronized(lock) {
                            mediaPlayer?.release()
                            mediaPlayer = null
                            playNextChunk()
                        }
                    }
                    setOnErrorListener { _, what, extra ->
                        Log.w(TAG, "MediaPlayer error: what=$what, extra=$extra")
                        cleanupCurrentFile()
                        synchronized(lock) {
                            mediaPlayer?.release()
                            mediaPlayer = null
                            playNextChunk()
                        }
                        true
                    }
                    prepareAsync()
                }
            } catch (e: Exception) {
                Log.e(TAG, "Error playing chunk ${nextItem.index}", e)
                cleanupCurrentFile()
                synchronized(lock) {
                    mediaPlayer?.release()
                    mediaPlayer = null
                    playNextChunk()
                }
            }
        }
    }

    private fun cleanupCurrentFile() {
        currentPlayingItem?.let { item ->
            try {
                if (item.file.exists()) {
                    item.file.delete()
                }
            } catch (_: Exception) {}
        }
        currentPlayingItem = null
    }

    /**
     * Instantly stops playback and clears all pending chunks (barge-in interruption).
     */
    fun stop() {
        synchronized(lock) {
            try {
                mediaPlayer?.let { mp ->
                    if (mp.isPlaying) {
                        mp.stop()
                    }
                    mp.reset()
                    mp.release()
                }
            } catch (e: Exception) {
                Log.w(TAG, "Exception during mediaPlayer stop", e)
            } finally {
                mediaPlayer = null
            }

            cleanupCurrentFile()

            // Delete all queued temp files
            while (queue.isNotEmpty()) {
                val item = queue.poll()
                try {
                    if (item?.file?.exists() == true) {
                        item.file.delete()
                    }
                } catch (_: Exception) {}
            }

            if (_isPlaying.value) {
                _isPlaying.value = false
                onPlaybackStateChanged?.invoke(false)
            }
        }
    }

    /**
     * Cleans up resources on destruction.
     */
    fun release() {
        stop()
    }
}
