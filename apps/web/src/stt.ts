/**
 * Browser Speech-To-Text (STT) and Voice Activity Detection (VAD) Engine.
 * Converts real-time spoken audio to text, manages silence timeouts,
 * and enforces a maximum turn cap so background speech never hangs the session.
 */

interface IWindowSpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: any) => void) | null;
  onerror: ((event: any) => void) | null;
  onend: (() => void) | null;
}

export class SpeechToTextEngine {
  private recognition: IWindowSpeechRecognition | null = null;
  private isListeningInternal = false;
  private silenceTimer: number | null = null;
  private maxUtteranceTimer: number | null = null;
  private currentTranscript = '';
  private onInterimCallback: ((text: string) => void) | null = null;
  private onFinalCallback: ((text: string) => void) | null = null;

  get isListening(): boolean {
    return this.isListeningInternal;
  }

  getCurrentTranscript(): string {
    return this.currentTranscript.trim();
  }

  start(
    onInterim: (text: string) => void,
    onFinal: (text: string) => void
  ): boolean {
    const SpeechRecognitionClass = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognitionClass) {
      console.warn('SpeechRecognition API not available in this browser.');
      return false;
    }

    if (this.isListeningInternal) return true;

    this.currentTranscript = '';
    this.onInterimCallback = onInterim;
    this.onFinalCallback = onFinal;

    try {
      this.recognition = new SpeechRecognitionClass();
      this.recognition.continuous = true;
      this.recognition.interimResults = true;
      this.recognition.lang = 'en-US';

      this.recognition.onresult = (event: any) => {
        let interimText = '';
        let finalText = '';

        for (let i = 0; i < event.results.length; i++) {
          const item = event.results[i];
          if (item.isFinal) {
            finalText += item[0]?.transcript || '';
          } else {
            interimText += item[0]?.transcript || '';
          }
        }

        const fullText = (finalText + ' ' + interimText).trim();
        if (fullText) {
          this.currentTranscript = fullText;
          this.onInterimCallback?.(fullText);

          // Reset silence timer on speech activity
          this.resetSilenceTimer();
        }
      };

      this.recognition.onerror = (event: any) => {
        if (event.error !== 'no-speech') {
          console.debug('STT Recognition error:', event.error);
        }
      };

      this.recognition.onend = () => {
        if (this.isListeningInternal && this.currentTranscript.trim()) {
          this.finish();
        }
      };

      this.recognition.start();
      this.isListeningInternal = true;

      // Maximum utterance cap: hard auto-commit at 30s even if background chatter continues
      this.clearMaxUtteranceTimer();
      this.maxUtteranceTimer = window.setTimeout(() => {
        if (this.isListeningInternal) {
          console.debug('STT max utterance cap reached (30s), auto-committing turn.');
          this.finish();
        }
      }, 30000);

      return true;
    } catch (err) {
      console.error('Failed to start SpeechToTextEngine:', err);
      this.stop();
      return false;
    }
  }

  stop(): string {
    const final = this.currentTranscript.trim();
    this.isListeningInternal = false;
    this.clearSilenceTimer();
    this.clearMaxUtteranceTimer();

    if (this.recognition) {
      try {
        this.recognition.stop();
      } catch (_) {}
      this.recognition = null;
    }

    return final;
  }

  forceCommit(): string {
    const final = this.stop();
    return final;
  }

  private resetSilenceTimer() {
    this.clearSilenceTimer();
    // 2.5 seconds of silence after speaking automatically commits the turn (forgiving pause window)
    this.silenceTimer = window.setTimeout(() => {
      if (this.isListeningInternal && this.currentTranscript.trim()) {
        this.finish();
      }
    }, 2500);
  }

  private clearSilenceTimer() {
    if (this.silenceTimer) {
      window.clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
  }

  private clearMaxUtteranceTimer() {
    if (this.maxUtteranceTimer) {
      window.clearTimeout(this.maxUtteranceTimer);
      this.maxUtteranceTimer = null;
    }
  }

  private finish() {
    const final = this.stop();
    if (final) {
      this.onFinalCallback?.(final);
    }
  }
}
