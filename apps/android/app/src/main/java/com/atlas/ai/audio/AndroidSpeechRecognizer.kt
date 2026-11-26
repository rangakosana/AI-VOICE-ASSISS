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
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Native Android Speech-To-Text (STT) Engine for ATLAS Voice Assistant.
 *
 * Implements:
 * 1. Low-latency on-device & system speech recognition via Android's SpeechRecognizer.
 * 2. Real-time partial results streaming for live UI transcript rendering.
 * 3. Dynamic RMS energy calculation (-2dB to 10dB normalized to 0.0..1.0) to drive the Holographic HUD core.
 * 4. Multi-language speech recognition supporting both English (en-IN / en-US) and Telugu (te-IN).
 */
class AndroidSpeechRecognizer(
    private val context: Context,
    private val onPartialText: (String) -> Unit,
    private val onFinalText: (String) -> Unit,
    private val onRmsChanged: (Float) -> Unit,
    private val onError: (String) -> Unit
) {
    companion object {
        private const val TAG = "AndroidSpeechRecognizer"
    }

    private var speechRecognizer: SpeechRecognizer? = null
    private val handler = Handler(Looper.getMainLooper())
    private val _isListening = MutableStateFlow(false)
    val isListening: StateFlow<Boolean> = _isListening.asStateFlow()

    private var accumulatedText = ""

    /**
     * Starts listening for spoken speech in the target language.
     */
    fun startListening(language: String = "en-IN") {
        handler.post {
            if (_isListening.value) return@post

            if (!SpeechRecognizer.isRecognitionAvailable(context)) {
                onError("Speech recognition is not available on this device.")
                return@post
            }

            try {
                speechRecognizer?.destroy()
                speechRecognizer = SpeechRecognizer.createSpeechRecognizer(context).apply {
                    setRecognitionListener(object : RecognitionListener {
                        override fun onReadyForSpeech(params: Bundle?) {
                            Log.d(TAG, "SpeechRecognizer ready for speech in $language")
                            _isListening.value = true
                        }

                        override fun onBeginningOfSpeech() {
                            Log.d(TAG, "User started speaking")
                        }

                        override fun onRmsChanged(rmsdB: Float) {
                            // Convert dB (-2 to 10 typical in Android) to normalized 0.0 .. 1.0
                            val normalized = ((rmsdB + 2f) / 12f).coerceIn(0f, 1f)
                            onRmsChanged(normalized)
                        }

                        override fun onBufferReceived(buffer: ByteArray?) {}

                        override fun onEndOfSpeech() {
                            Log.d(TAG, "End of speech detected")
                        }

                        override fun onError(error: Int) {
                            Log.w(TAG, "SpeechRecognizer error: $error")
                            _isListening.value = false
                            onRmsChanged(0f)

                            // If we have some partial text recognized before timeout, treat it as final
                            if (accumulatedText.isNotBlank()) {
                                val textToSend = accumulatedText.trim()
                                accumulatedText = ""
                                onFinalText(textToSend)
                            } else {
                                val message = when (error) {
                                    SpeechRecognizer.ERROR_NO_MATCH -> "No speech detected. Tap mic to try again."
                                    SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "Speech timeout. Tap mic to try again."
                                    SpeechRecognizer.ERROR_AUDIO -> "Audio recording issue. Please check mic permissions."
                                    SpeechRecognizer.ERROR_NETWORK -> "Network issue during speech recognition."
                                    else -> "Speech recognition paused ($error)."
                                }
                                onError(message)
                            }
                        }

                        override fun onResults(results: Bundle?) {
                            _isListening.value = false
                            onRmsChanged(0f)
                            val matches = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                            val text = matches?.firstOrNull() ?: accumulatedText
                            accumulatedText = ""

                            if (!text.isNullOrBlank()) {
                                Log.i(TAG, "Final recognized speech: $text")
                                onFinalText(text.trim())
                            } else {
                                onError("No words captured. Tap mic to try again.")
                            }
                        }

                        override fun onPartialResults(partialResults: Bundle?) {
                            val matches = partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                            val partial = matches?.firstOrNull() ?: return
                            if (partial.isNotBlank()) {
                                accumulatedText = partial
                                onPartialText(partial.trim())
                            }
                        }

                        override fun onEvent(eventType: Int, params: Bundle?) {}
                    })
                }

                val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                    putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                    putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
                    putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 3)
                    putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, context.packageName)
                    putExtra(RecognizerIntent.EXTRA_LANGUAGE, language)
                    putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, language)
                    // Multi-language support: Telugu and English
                    putExtra("android.speech.extra.EXTRA_ADDITIONAL_LANGUAGES", arrayOf("te-IN", "en-IN", "en-US"))
                }

                speechRecognizer?.startListening(intent)
                _isListening.value = true
                accumulatedText = ""
            } catch (e: Exception) {
                Log.e(TAG, "Failed to start speech recognition", e)
                _isListening.value = false
                onError("Failed to start microphone: ${e.message}")
            }
        }
    }

    /**
     * Stops listening and requests final recognition result.
     */
    fun stopListening() {
        handler.post {
            try {
                if (_isListening.value) {
                    speechRecognizer?.stopListening()
                }
            } catch (e: Exception) {
                Log.w(TAG, "Exception stopping speech recognizer", e)
            } finally {
                _isListening.value = false
                onRmsChanged(0f)
            }
        }
    }

    /**
     * Cancels active recognition and releases native SpeechRecognizer.
     */
    fun cancel() {
        handler.post {
            try {
                speechRecognizer?.cancel()
                speechRecognizer?.destroy()
            } catch (_: Exception) {}
            finally {
                speechRecognizer = null
                _isListening.value = false
                onRmsChanged(0f)
                accumulatedText = ""
            }
        }
    }
}
