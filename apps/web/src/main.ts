import { WebAudioRecorder } from './audio.js';
import { AtlasWebClient } from './client.js';
import { HudArcReactorVisualizer } from './hudCanvas.js';
import { HudSoundEffects } from './sfx.js';
import { SpeechToTextEngine } from './stt.js';
import { TextToSpeech } from './tts.js';
import { WakeWordDetector } from './wakeword.js';
import type { AssistantState, ConnectionStatus, LogEntry } from './types.js';

// ---------------------------------------------------------------------------
// DOM Elements
// ---------------------------------------------------------------------------
const connectionBadge = document.getElementById('connectionBadge') as HTMLElement;
const connectionText = document.getElementById('connectionText') as HTMLElement;
const languageText = document.getElementById('languageText') as HTMLElement;
const wakeWordToggleBtn = document.getElementById('wakeWordToggleBtn') as HTMLButtonElement;
const wakeWordText = document.getElementById('wakeWordText') as HTMLElement;
const reconnectBtn = document.getElementById('reconnectBtn') as HTMLButtonElement;

const orbCanvas = document.getElementById('orbCanvas') as HTMLCanvasElement;
const assistantStatePill = document.getElementById('assistantStatePill') as HTMLDivElement;
const sessionIdLabel = document.getElementById('sessionIdLabel') as HTMLSpanElement;
const transcriptBody = document.getElementById('transcriptBody') as HTMLDivElement;

const chatForm = document.getElementById('chatForm') as HTMLFormElement;
const chatInput = document.getElementById('chatInput') as HTMLInputElement;
const sendBtn = document.getElementById('sendBtn') as HTMLButtonElement;
const interruptBtn = document.getElementById('interruptBtn') as HTMLButtonElement;
const micBtn = document.getElementById('micBtn') as HTMLButtonElement;
const resetBtn = document.getElementById('resetBtn') as HTMLButtonElement;
const quickPillButtons = document.querySelectorAll<HTMLButtonElement>('.hud-quick-btn');

// ---------------------------------------------------------------------------
// State Tracking
// ---------------------------------------------------------------------------
let currentAudioRms = 0;
let currentAssistantState: AssistantState = 'IDLE';
let lastUserPrompt = '';

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ---------------------------------------------------------------------------
// Initialize Core Engines
// ---------------------------------------------------------------------------
const sfx = new HudSoundEffects();
const hudVisualizer = new HudArcReactorVisualizer(orbCanvas);
window.addEventListener('resize', () => hudVisualizer.resize());

let wakeWordDetector: WakeWordDetector;

const tts = new TextToSpeech((isPlaying: boolean) => {
  if (!isPlaying) {
    audioRecorder.setAssistantSpeaking(false);
    if (currentAssistantState === 'SPEAKING') {
      client.setAssistantState('IDLE');
    }
    wakeWordDetector?.resume();
  } else {
    audioRecorder.setAssistantSpeaking(true);
    wakeWordDetector?.pause();
  }
});

const audioRecorder = new WebAudioRecorder();
const stt = new SpeechToTextEngine();

// ---------------------------------------------------------------------------
// WebSocket Gateway Client Configuration
// ---------------------------------------------------------------------------
const client = new AtlasWebClient({
  onStatusChange: (status: ConnectionStatus) => {
    if (connectionText) {
      connectionText.textContent = status === 'CONNECTED' ? 'CONNECTED' : status;
    }
    if (connectionBadge) {
      if (status === 'CONNECTED') {
        connectionBadge.className = 'hud-pill pill-connected';
      } else {
        connectionBadge.className = 'hud-pill pill-connected disconnected';
      }
    }
    sendBtn.disabled = status !== 'CONNECTED';

    if (status === 'CONNECTED') {
      sfx.playConnectChime();
    }
  },

  onAssistantStateChange: (state: AssistantState) => {
    currentAssistantState = state;
    const labels: Record<AssistantState, string> = {
      IDLE: 'Ready',
      LISTENING: 'Listening...',
      THINKING: 'Thinking...',
      SPEAKING: 'Speaking...',
    };
    if (assistantStatePill) {
      assistantStatePill.textContent = labels[state];
      assistantStatePill.className = `state-pill ${state.toLowerCase()}`;
    }

    // Interrupt button active during speech / generation
    interruptBtn.disabled = state !== 'SPEAKING' && state !== 'THINKING';

    // Wake-word mutual exclusivity
    if (state === 'SPEAKING') {
      audioRecorder.setAssistantSpeaking(true);
      wakeWordDetector?.pause();
    } else if (state === 'IDLE') {
      audioRecorder.setAssistantSpeaking(false);
      wakeWordDetector?.resume();
    } else {
      audioRecorder.setAssistantSpeaking(false);
      wakeWordDetector?.pause();
    }
  },

  onSessionChange: (sessionId: string | null) => {
    if (sessionIdLabel) {
      sessionIdLabel.textContent = sessionId
        ? `Session: ${sessionId.slice(0, 8)}...`
        : 'Session: None';
    }
  },

  onTranscript: (text: string, isFinal: boolean, role?: string) => {
    if (role === 'user' || isFinal) {
      lastUserPrompt = text;
      transcriptBody.innerHTML = `
        <div class="transcript-line user"><span class="speaker-label">YOU:</span> <span class="speaker-text">${escapeHtml(text)}</span></div>
        <div class="transcript-line atlas"><span class="speaker-label">ATLAS:</span> <span class="speaker-placeholder">Synthesizing telemetry...</span></div>
      `;
      transcriptBody.scrollTop = transcriptBody.scrollHeight;
    }
  },

  onStreamingDelta: (_delta: string, fullText: string) => {
    const userHtml = lastUserPrompt
      ? `<div class="transcript-line user"><span class="speaker-label">YOU:</span> <span class="speaker-text">${escapeHtml(lastUserPrompt)}</span></div>`
      : '';

    if (!fullText) {
      transcriptBody.innerHTML = `
        ${userHtml}
        <div class="transcript-line atlas"><span class="speaker-label">ATLAS:</span> <span class="speaker-placeholder">Synthesizing telemetry...</span></div>
      `;
    } else {
      transcriptBody.innerHTML = `
        ${userHtml}
        <div class="transcript-line atlas"><span class="speaker-label">ATLAS:</span> <span class="speaker-text">${escapeHtml(fullText)}</span></div>
      `;
      transcriptBody.scrollTop = transcriptBody.scrollHeight;
    }
  },

  onAudioChunk: (chunk: {
    responseId: string;
    index: number;
    audio: string;
    mimeType: string;
    text?: string;
    language?: 'te' | 'en';
    voice?: string;
    intent?: string;
    isFinal?: boolean;
  }) => {
    tts.enqueueNeuralAudio(chunk.audio, chunk.mimeType, chunk.text, chunk.index);

    // Update Language Pill (EN / TE)
    if (languageText) {
      if (chunk.language === 'te' || (chunk.voice && chunk.voice.includes('te-IN'))) {
        languageText.textContent = 'TE';
      } else {
        languageText.textContent = 'EN';
      }
    }
  },

  onStreamingComplete: (fullText: string) => {
    const userHtml = lastUserPrompt
      ? `<div class="transcript-line user"><span class="speaker-label">YOU:</span> <span class="speaker-text">${escapeHtml(lastUserPrompt)}</span></div>`
      : '';
    transcriptBody.innerHTML = `
      ${userHtml}
      <div class="transcript-line atlas"><span class="speaker-label">ATLAS:</span> <span class="speaker-text">${escapeHtml(fullText)}</span></div>
    `;
    transcriptBody.scrollTop = transcriptBody.scrollHeight;
    tts.speakFallbackIfNoNeuralAudio(fullText);
  },

  onLog: (entry: LogEntry) => {
    console.debug(`[ATLAS ${entry.direction}] ${entry.type}`, entry.payload || '');
  },
});

// ---------------------------------------------------------------------------
// Background Wake-Word ("Hey Atlas") Setup
// ---------------------------------------------------------------------------
wakeWordDetector = new WakeWordDetector(
  (trailingCommand: string) => {
    sfx.playWakeChime();
    tts.stop();

    if (trailingCommand.trim()) {
      lastUserPrompt = trailingCommand.trim();
      transcriptBody.innerHTML = `
        <div class="transcript-line user"><span class="speaker-label">YOU:</span> <span class="speaker-text">${escapeHtml(lastUserPrompt)}</span></div>
        <div class="transcript-line atlas"><span class="speaker-label">ATLAS:</span> <span class="speaker-placeholder">Synthesizing telemetry...</span></div>
      `;
      client.sendVoiceCommit(trailingCommand.trim());
    } else {
      startVoiceTurn('Hey Atlas detected. Listening for command...');
    }
  },
  (statusLog: string) => {
    console.debug('[WakeWord] Status:', statusLog);
  }
);

// ---------------------------------------------------------------------------
// 60FPS Bioluminescent Plasma & Audio Waveform Loop
// ---------------------------------------------------------------------------
function animationLoop() {
  let frequencyData: Uint8Array = new Uint8Array(0);

  if (currentAssistantState === 'SPEAKING') {
    frequencyData = tts.getAudioData();
  } else if (audioRecorder.isRecording) {
    frequencyData = audioRecorder.getAudioData();
  }

  hudVisualizer.render({
    assistantState: currentAssistantState,
    isRecording: audioRecorder.isRecording,
    audioRms: currentAudioRms,
    frequencyData,
  });

  requestAnimationFrame(animationLoop);
}

requestAnimationFrame(animationLoop);

// ---------------------------------------------------------------------------
// Voice Turn-Taking & Sustained Barge-In
// ---------------------------------------------------------------------------
function handleSustainedBargeIn() {
  if (currentAssistantState !== 'SPEAKING') return;

  sfx.playInterruptChime();
  tts.stop();
  stopVoiceTurn();
  client.sendInterrupt('user_barge_in');

  console.debug('[BargeIn] Sustained close-mic speech (>=300ms) detected. Halting Atlas.');
  startVoiceTurn('Barge-in detected. Listening...');
}

async function startVoiceTurn(placeholderMessage?: string) {
  wakeWordDetector.pause();
  tts.stop();
  sfx.playMicActiveChime();

  transcriptBody.innerHTML = `
    <div class="transcript-line user"><span class="speaker-placeholder">${placeholderMessage || 'Listening... Speak your prompt.'}</span></div>
  `;

  const micStarted = await audioRecorder.start({
    onChunk: (chunk: ArrayBuffer) => {
      client.sendAudioChunk(chunk);
    },
    onRms: (rms: number, _speechActive: boolean) => {
      currentAudioRms = rms;
    },
    onSilenceTimeout: () => {
      stopVoiceTurn();
    },
    onMaxUtteranceTimeout: () => {
      console.debug('[VoiceTurn] Max utterance cap reached. Committing audio turn.');
      stopVoiceTurn(undefined, true);
    },
    onBargeIn: () => {
      handleSustainedBargeIn();
    },
  });

  if (!micStarted) {
    transcriptBody.innerHTML = '<span class="speaker-placeholder">Microphone access denied or unavailable.</span>';
    wakeWordDetector.resume();
    return;
  }

  micBtn.classList.add('recording');
  client.setAssistantState('LISTENING');

  stt.start(
    (interimText: string) => {
      transcriptBody.innerHTML = `
        <div class="transcript-line user"><span class="speaker-label">YOU:</span> <span class="speaker-text">${escapeHtml(interimText)}...</span></div>
      `;
      transcriptBody.scrollTop = transcriptBody.scrollHeight;
    },
    (finalText: string) => {
      stopVoiceTurn(finalText);
    }
  );
}

function stopVoiceTurn(explicitFinalText?: string, isManualOrCap = false) {
  if (!audioRecorder.isRecording && !stt.isListening && !explicitFinalText && !isManualOrCap) return;

  audioRecorder.stop();
  const sttFinal = explicitFinalText ?? stt.stop();
  micBtn.classList.remove('recording');

  const promptText = (sttFinal || stt.getCurrentTranscript() || '').trim();
  if (promptText) {
    lastUserPrompt = promptText;
    tts.resetTurn();

    transcriptBody.innerHTML = `
      <div class="transcript-line user"><span class="speaker-label">YOU:</span> <span class="speaker-text">${escapeHtml(promptText)}</span></div>
      <div class="transcript-line atlas"><span class="speaker-label">ATLAS:</span> <span class="speaker-placeholder">Synthesizing telemetry...</span></div>
    `;
    transcriptBody.scrollTop = transcriptBody.scrollHeight;
    client.sendVoiceCommit(promptText);
  } else if (isManualOrCap) {
    lastUserPrompt = '(Audio command)';
    tts.resetTurn();

    transcriptBody.innerHTML = `
      <div class="transcript-line user"><span class="speaker-label">YOU:</span> <span class="speaker-text"><em>(Audio prompt transmitted)</em></span></div>
      <div class="transcript-line atlas"><span class="speaker-label">ATLAS:</span> <span class="speaker-placeholder">Synthesizing telemetry...</span></div>
    `;
    transcriptBody.scrollTop = transcriptBody.scrollHeight;
    client.sendVoiceCommit('');
  } else {
    client.setAssistantState('IDLE');
    wakeWordDetector.resume();
  }
}

// ---------------------------------------------------------------------------
// Control Event Listeners
// ---------------------------------------------------------------------------
client.connect();

// Unlock Web Audio API on gesture
window.addEventListener('click', () => tts.resumeAudioContext(), { once: true });
window.addEventListener('keydown', () => tts.resumeAudioContext(), { once: true });

reconnectBtn?.addEventListener('click', () => {
  tts.resumeAudioContext();
  client.connect();
});

chatForm?.addEventListener('submit', (e) => {
  e.preventDefault();
  tts.resumeAudioContext();
  const text = chatInput.value.trim();
  if (!text) return;

  tts.resetTurn();
  stopVoiceTurn();

  lastUserPrompt = text;
  transcriptBody.innerHTML = `
    <div class="transcript-line user"><span class="speaker-label">YOU:</span> <span class="speaker-text">${escapeHtml(text)}</span></div>
    <div class="transcript-line atlas"><span class="speaker-label">ATLAS:</span> <span class="speaker-placeholder">Synthesizing telemetry...</span></div>
  `;
  client.sendMessage(text);
  chatInput.value = '';
});

// Mic Toggle
micBtn?.addEventListener('click', async () => {
  if (audioRecorder.isRecording || stt.isListening) {
    stopVoiceTurn(undefined, true);
  } else {
    await startVoiceTurn();
  }
});

// Barge-in Interrupt
interruptBtn?.addEventListener('click', () => {
  sfx.playInterruptChime();
  tts.stop();
  stopVoiceTurn();
  client.sendInterrupt('user_barge_in');
  wakeWordDetector.resume();
});

// Reset Session
resetBtn?.addEventListener('click', () => {
  sfx.playInterruptChime();
  tts.stop();
  stopVoiceTurn();
  lastUserPrompt = '';
  transcriptBody.innerHTML = `
    <div class="transcript-line atlas"><span class="speaker-label">ATLAS:</span> <span class="speaker-text">Session reset. Ready for your input.</span></div>
  `;
  client.endSession('user_reset');
  setTimeout(() => {
    client.startSession();
    wakeWordDetector.resume();
  }, 200);
});

// Toggle "Hey Atlas" Wake Word
if (wakeWordToggleBtn) {
  wakeWordToggleBtn.addEventListener('click', () => {
    const isNowActive = wakeWordDetector.toggle();
    if (wakeWordText) {
      wakeWordText.textContent = isNowActive ? 'WAKE WORD ON' : 'WAKE WORD OFF';
    }
    wakeWordToggleBtn.classList.toggle('active', isNowActive);
  });
}

// Quick Prompt Pills
quickPillButtons.forEach((pill) => {
  pill.addEventListener('click', () => {
    const prompt = pill.dataset.prompt;
    if (prompt) {
      chatInput.value = prompt;
      chatForm.dispatchEvent(new Event('submit', { cancelable: true }));
    }
  });
});
