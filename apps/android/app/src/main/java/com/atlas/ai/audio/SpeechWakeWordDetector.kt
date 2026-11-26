package com.atlas.ai.audio

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.util.Log
import java.util.concurrent.atomic.AtomicBoolean

/**
 * On-device continuous speech-based Wake Word Detector for "Hey Atlas" and "OK Atlas".
 *
 * Uses Android's native SpeechRecognizer with offline preference and continuous re-arming
 * so it listens reliably in the background without heavy external library dependencies.
 */
class SpeechWakeWordDetector(
    private val context: Context,
    private val onWakeWordDetected: (keyword: String) -> Unit
) {
    companion object {
        private const val TAG = "SpeechWakeWordDetector"
        val KEYWORDS = listOf("hey atlas", "ok atlas", "okay atlas", "atlas")
    }

    private var speechRecognizer: SpeechRecognizer? = null
    private val isListening = AtomicBoolean(false)
    private val handler = Handler(Looper.getMainLooper())

    fun startListening() {
        handler.post {
            if (isListening.get()) return@post
            if (!SpeechRecognizer.isRecognitionAvailable(context)) {
                Log.w(TAG, "SpeechRecognizer is not available on this device.")
                return@post
            }

            try {
                isListening.set(true)
                initAndStartRecognizer()
                Log.i(TAG, "SpeechWakeWordDetector started listening for 'Hey Atlas'")
            } catch (e: Exception) {
                Log.e(TAG, "Failed to start speech recognizer", e)
                isListening.set(false)
            }
        }
    }

    fun stopListening() {
        handler.post {
            isListening.set(false)
            handler.removeCallbacksAndMessages(null)
            try {
                speechRecognizer?.stopListening()
                speechRecognizer?.cancel()
                speechRecognizer?.destroy()
            } catch (e: Exception) {
                Log.w(TAG, "Error stopping recognizer", e)
            } finally {
                speechRecognizer = null
            }
            Log.i(TAG, "SpeechWakeWordDetector stopped")
        }
    }

    private fun initAndStartRecognizer() {
        if (!isListening.get()) return

        speechRecognizer?.destroy()
        speechRecognizer = SpeechRecognizer.createSpeechRecognizer(context).apply {
            setRecognitionListener(object : RecognitionListener {
                override fun onReadyForSpeech(params: Bundle?) {}
                override fun onBeginningOfSpeech() {}
                override fun onRmsChanged(rmsdB: Float) {}
                override fun onBufferReceived(buffer: ByteArray?) {}

                override fun onEndOfSpeech() {
                    restartListening(delayMs = 150)
                }

                override fun onError(error: Int) {
                    // Recover from timeout or no-match and keep listening
                    Log.d(TAG, "SpeechRecognizer error: $error, re-arming...")
                    restartListening(delayMs = 300)
                }

                override fun onResults(results: Bundle?) {
                    checkMatches(results)
                    restartListening(delayMs = 150)
                }

                override fun onPartialResults(partialResults: Bundle?) {
                    checkMatches(partialResults)
                }

                override fun onEvent(eventType: Int, params: Bundle?) {}
            })
        }

        val recognizerIntent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 3)
            putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, context.packageName)
            // Request offline on-device recognition if available
            putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
        }

        try {
            speechRecognizer?.startListening(recognizerIntent)
        } catch (e: Exception) {
            Log.w(TAG, "Failed to start speechRecognizer intent", e)
            restartListening(delayMs = 500)
        }
    }

    private fun checkMatches(bundle: Bundle?) {
        val matches = bundle?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION) ?: return
        for (candidate in matches) {
            val lower = candidate.lowercase().trim()
            for (kw in KEYWORDS) {
                if (lower.contains(kw)) {
                    Log.i(TAG, "Wake word matched: '$kw' in candidate '$candidate'")
                    onWakeWordDetected(kw)
                    return
                }
            }
        }
    }

    private fun restartListening(delayMs: Long) {
        if (!isListening.get()) return
        handler.postDelayed({
            if (isListening.get()) {
                initAndStartRecognizer()
            }
        }, delayMs)
    }
}
