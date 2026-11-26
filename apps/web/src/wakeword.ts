/**
 * Browser-based "Hey Atlas" Wake Word Listener.
 *
 * Implements:
 * 1. Background keyword spotting for "Hey Atlas", "OK Atlas", and "Atlas" using Web Speech API.
 * 2. Strict mutual exclusivity with active microphone turns: pauses cleanly the moment
 *    a wake-word is spotted or the user clicks the mic, and resumes ONLY after Atlas finishes speaking.
 */

// Define SpeechRecognition interface for TypeScript
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

declare global {
  interface Window {
    SpeechRecognition?: new () => IWindowSpeechRecognition;
    webkitSpeechRecognition?: new () => IWindowSpeechRecognition;
  }
}

export class WakeWordDetector {
  private recognition: IWindowSpeechRecognition | null = null;
  private isActive = false;
  private isPaused = false;
  private isProcessingTurn = false;
  private onWakeWordDetected: (command: string) => void;
  private onStatusLog: (msg: string) => void;

  constructor(
    onWakeWordDetected: (command: string) => void,
    onStatusLog: (msg: string) => void
  ) {
    this.onWakeWordDetected = onWakeWordDetected;
    this.onStatusLog = onStatusLog;
  }

  get active(): boolean {
    return this.isActive && !this.isPaused;
  }

  get enabled(): boolean {
    return this.isActive;
  }

  start(): boolean {
    const SpeechRecognitionClass = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognitionClass) {
      this.onStatusLog('SpeechRecognition is not supported in this browser for Wake Word.');
      return false;
    }

    this.isActive = true;
    this.isPaused = false;
    this.isProcessingTurn = false;

    return this.initAndStart();
  }

  private initAndStart(): boolean {
    if (!this.isActive || this.isPaused) return false;

    const SpeechRecognitionClass = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognitionClass) return false;

    try {
      if (this.recognition) {
        try {
          this.recognition.abort();
        } catch (_) {}
      }

      this.recognition = new SpeechRecognitionClass();
      this.recognition.continuous = true;
      this.recognition.interimResults = true;
      this.recognition.lang = 'en-US';

      this.recognition.onresult = (event: any) => {
        if (this.isProcessingTurn || this.isPaused) return;

        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i];
          const transcript = result[0]?.transcript?.trim().toLowerCase() || '';

          // Match "hey atlas", "ok atlas", "hi atlas", or standalone "atlas"
          const match = transcript.match(/(?:hey|ok|hi|hello)?\s*\batlas\b[\s,:]*(.*)/i);
          if (match) {
            const trailingCommand = match[1]?.trim() || '';
            this.onStatusLog(`Wake Word matched: "Hey Atlas" (Command: "${trailingCommand || '<listening>'}").`);

            // Immediately pause wake word listener so the active microphone turn has exclusive access
            this.pause();
            this.onWakeWordDetected(trailingCommand);
            break;
          }
        }
      };

      this.recognition.onerror = (event: any) => {
        if (event.error === 'not-allowed') {
          this.onStatusLog('Microphone permission denied for wake word.');
          this.stop();
        } else if (event.error !== 'no-speech' && !this.isPaused) {
          console.debug('Wake word speech recognition error:', event.error);
        }
      };

      this.recognition.onend = () => {
        // Auto-restart only if active and NOT paused for active turn
        if (this.isActive && !this.isPaused) {
          try {
            this.recognition?.start();
          } catch (_) {}
        }
      };

      this.recognition.start();
      this.onStatusLog('Wake Word Listener active: Listening for "Hey Atlas"...');
      return true;
    } catch (err) {
      console.error('Failed to start WakeWordDetector:', err);
      return false;
    }
  }

  /**
   * Pauses wake-word detection and aborts recognition cleanly
   * so active speech turn has exclusive mic access.
   */
  pause(): void {
    if (this.isPaused) return;
    this.isPaused = true;
    if (this.recognition) {
      try {
        this.recognition.abort();
      } catch (_) {}
      this.recognition = null;
    }
    this.onStatusLog('Wake Word paused for active turn.');
  }

  /**
   * Resumes wake-word detection when Atlas finishes speaking and returns to IDLE.
   */
  resume(): void {
    if (!this.isActive || !this.isPaused) return;
    this.isPaused = false;
    this.isProcessingTurn = false;
    this.initAndStart();
    this.onStatusLog('Wake Word resumed.');
  }

  stop(): void {
    this.isActive = false;
    this.isPaused = false;
    this.isProcessingTurn = false;
    if (this.recognition) {
      try {
        this.recognition.abort();
      } catch (_) {}
      this.recognition = null;
    }
    this.onStatusLog('Wake Word Listener stopped.');
  }

  toggle(): boolean {
    if (this.isActive) {
      this.stop();
      return false;
    } else {
      return this.start();
    }
  }
}
